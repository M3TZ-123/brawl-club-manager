const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { randomUUID } = require('node:crypto');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');
const source = process.env.SECURITY_TEST_DATABASE_URL || process.env.SYNC_TEST_DATABASE_URL;
const root = path.resolve(__dirname, '../..');
const club = '#PYLQ';
const at = minutes => new Date(Date.now() + minutes * 60000).toISOString();
const sample = (total = 82, members) => ({ clubTag: club, totalWins: total, reportedPlayersPlayed: 2,
  members: members || [{ playerTag: '#PYLR', playerName: 'محمد', reportedWins: 5, reportedTicketsRemaining: 2 },
    { playerTag: '#PYLU', playerName: 'Unknown source member', reportedWins: null, reportedTicketsRemaining: null }] });

test('permanent Mega Pig archive keeps observed evidence separate from manually confirmed cycles', { skip: !source }, async t => {
  const url = new URL(source); assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/brawl_(security|sync|mega_pig_archive)_tests$/); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const local = db => assert.ok(['127.0.0.1', '::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/, '')));
  url.pathname = '/postgres'; const admin = new Client({ connectionString: url.href }); await admin.connect(); local(admin);
  try { if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_mega_pig_archive_tests'")).rowCount) {
    await admin.query("CREATE DATABASE brawl_mega_pig_archive_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
  } } finally { await admin.end(); }
  url.pathname = '/brawl_mega_pig_archive_tests'; const db = new Client({ connectionString: url.href }); await db.connect(); local(db); t.after(() => db.end());
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(name => /^20260916\d{4}_.*\.sql$/.test(name)).sort();
  for (const file of migrations.filter(file => file < '202609160039')) await db.query(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'));
  await db.query("INSERT INTO settings(key,value) VALUES('club_tag',$1),('last_roster_sync_time',$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [club, at(-1)]);
  await db.query("INSERT INTO members(player_tag,player_name,trophies) VALUES('#PYLR','محمد',100),('#PYLC','Roster-only member',200); INSERT INTO member_history(player_tag,player_name,is_current_member) VALUES('#PYLR','محمد',true),('#PYLC','Roster-only member',true)");
  const seededAt = at(-40);
  await db.query('INSERT INTO club_mega_pig_source_cache(club_tag,payload,previous_payload,fetched_at,last_attempt_at) VALUES($1,$2,$3,$4,$4)', [club, sample(), sample(80), seededAt]);
  await db.query(fs.readFileSync(path.join(root, 'supabase/migrations/202609160039_mega_pig_archive.sql'), 'utf8'));
  const read = async (mode, id = null, player = null, offset = 0, connection = db, tag = club) =>
    (await connection.query('SELECT public.mega_pig_archive_read($1,$2,$3,$4,$5) value', [tag, mode, id, player, offset])).rows[0].value;
  const write = async (action, body, connection = db, tag = club) =>
    (await connection.query('SELECT public.mega_pig_archive_write($1,$2,$3) value', [tag, action, body])).rows[0].value;
  const record = async (payload = sample(), fetchedAt = at(-0.01), origin = 'source_fetch') =>
    (await db.query('SELECT public.mega_pig_archive_capture($1,$2,$3,$4) value', [club, payload, fetchedAt, origin])).rows[0].value;
  const input = (initial, extra = {}) => ({ title: 'Confirmed cycle', startsAt: at(-1440), endsAt: at(1440), milestones: [16, 32, 48, 64, 80],
    captureEnabled: true, initialObservationId: initial, notes: '', ...extra });
  const create = async (cycle, requestId = randomUUID(), connection = db) => write('save_cycle', { id: null, version: 0, requestId, cycle }, connection);
  const edit = async (saved, cycle) => write('save_cycle', { id: saved.cycle_id, version: saved.version, requestId: randomUUID(), cycle });
  const reset = async () => {
    await db.query('TRUNCATE club_mega_pig_cycle_revisions,club_mega_pig_cycle_members,club_mega_pig_cycles,club_mega_pig_observations,club_mega_pig_source_cache CASCADE');
    await db.query("UPDATE settings SET value=$1 WHERE key='club_tag';", [club]);
    await db.query("UPDATE member_history SET is_current_member=true WHERE player_tag IN('#PYLR','#PYLC')");
  };

  await t.test('migration seeds the existing82-win reading at its actual time and preserves an unknown-time previous reading', async () => {
    const result = await read('cycles'), readings = await read('readings');
    assert.equal(result.cycles.length, 0); assert.equal(result.observation_count, 2); assert.equal(result.latest_observation.total_wins, 82);
    assert.equal(Date.parse(result.latest_observation.first_fetched_at), Date.parse(seededAt));
    assert.equal(readings.observations[1].first_fetched_at, null); assert.equal(readings.observations[1].last_fetched_at, null);
    const detail = await read('reading', readings.observations[1].id); assert.equal(detail.observation.origin, 'legacy_previous');
    assert.equal(detail.observation.payload.members[1].reportedWins, null);
  });
  await t.test('every successful cache finish archives atomically, consecutive identical readings only extend actual fetch times', async () => {
    const claim = async () => { await db.query("UPDATE club_mega_pig_source_cache SET next_check_at=clock_timestamp()-interval '1 second'"); const token = randomUUID();
      const value = (await db.query('SELECT claim_mega_pig_source_cache($1,$2) value', [club, token])).rows[0].value; assert.equal(value.acquired, true); return token; };
    const finish = async (token, payload, error = null) => (await db.query('SELECT finish_mega_pig_source_cache($1,$2,$3,$4,NULL) value', [club, token, payload, error])).rows[0].value;
    const initial = (await read('cycles')).latest_observation;
    await finish(await claim(), sample()); let latest = (await read('cycles')).latest_observation;
    assert.equal(latest.id, initial.id); assert.equal(Date.parse(latest.first_fetched_at), Date.parse(seededAt)); assert.ok(Date.parse(latest.last_fetched_at) > Date.parse(seededAt));
    await finish(await claim(), sample(83)); latest = (await read('cycles')).latest_observation; assert.notEqual(latest.id, initial.id); assert.equal(latest.total_wins, 83);
    const count = (await read('cycles')).observation_count;
    await finish(await claim(), null, 'unavailable'); assert.equal((await read('cycles')).observation_count, count);
    assert.equal((await finish(randomUUID(), sample(84))).accepted, false); assert.equal((await read('cycles')).observation_count, count);
    await finish(await claim(), sample()); assert.equal((await read('cycles')).observation_count, count + 1, 'Nonconsecutive repeat remains a distinct historical change');
  });
  await t.test('explicit initial confirmation creates a roster/source union with unknowns and idempotent versioned administration', async () => {
    await reset(); const observed = await record(), body = input(observed), request = randomUUID();
    const unassigned = await read('player', null, '#PYLR'); assert.equal(unassigned.history.length, 0); assert.equal(unassigned.player_readings.length, 1);
    assert.equal(unassigned.player_readings[0].member.reportedWins, 5); assert.equal(unassigned.player_readings[0].observation.id, observed);
    const saved = await create(body, request), replay = await create(body, request); assert.equal(replay.replayed, true); assert.equal(replay.cycle_id, saved.cycle_id);
    const detail = await read('cycle', saved.cycle_id); assert.equal(detail.members.length, 3); assert.equal(detail.cycle.reported_total_wins, 82);
    assert.equal(detail.cycle.initial_observation_id, observed); assert.equal(detail.cycle.final_total_wins, null); assert.equal(detail.cycle.reward_status, 'unknown');
    const rosterOnly = detail.members.find(m => m.player_tag === '#PYLC'); assert.equal(rosterOnly.wins, null); assert.equal(rosterOnly.first_observed_at, null);
    assert.equal(detail.members.find(m => m.player_tag === '#PYLU').wins, null); assert.equal(detail.members.find(m => m.player_tag === '#PYLR').wins, 5);
    await assert.rejects(create({ ...body, title: 'Different' }, request), e => e.code === '40001');
    const updated = await edit(saved, { ...body, title: 'Edited' }); assert.equal(updated.version, 2);
    await assert.rejects(edit(saved, body), e => e.code === '40001');
    assert.equal((await db.query('SELECT count(*) FROM club_mega_pig_cycle_revisions WHERE cycle_id=$1', [saved.cycle_id])).rows[0].count, '2');
  });
  await t.test('changed/null readings preserve previous known counters and timestamps, names and departed members', async () => {
    await reset(); const oldAt = at(-10), observed = await record(sample(), oldAt), saved = await create(input(observed));
    await db.query("UPDATE member_history SET is_current_member=false WHERE player_tag='#PYLR'");
    await record(sample(85, [{ playerTag: '#PYLR', playerName: 'New name', reportedWins: null, reportedTicketsRemaining: null },
      { playerTag: '#PYLU', playerName: 'Now known', reportedWins: 8, reportedTicketsRemaining: 0 },
      { playerTag: '#PYLJ', playerName: 'Future member', reportedWins: 0, reportedTicketsRemaining: 6 }]));
    const detail = await read('cycle', saved.cycle_id), former = detail.members.find(m => m.player_tag === '#PYLR');
    assert.equal(detail.members.length, 4); assert.equal(former.is_current_member, false); assert.equal(former.player_name, 'New name'); assert.equal(former.first_player_name, 'محمد');
    assert.equal(former.wins, 5); assert.equal(Date.parse(former.wins_observed_at), Date.parse(oldAt)); assert.equal(former.latest_wins_unknown, true);
    assert.equal(detail.members.find(m => m.player_tag === '#PYLU').tickets_remaining, 0); assert.equal(detail.cycle.reported_total_wins, 85, 'Total is source club total, never sum of historical union');
    await db.query("DELETE FROM members WHERE player_tag='#PYLR'");
    assert.equal((await read('player', null, '#PYLR')).history[0].member.wins, 5, 'No current-member FK can erase historical evidence');
  });
  await t.test('a decreasing total pauses capture while saving raw changes; only explicit noted re-confirmation resumes the same cycle', async () => {
    await reset(); const observed = await record(), initial = input(observed), saved = await create(initial);
    const lowered = await record(sample(6)); let detail = await read('cycle', saved.cycle_id);
    assert.equal(detail.cycle.reported_total_wins, 82); assert.equal(detail.cycle.capture_enabled, false); assert.equal(detail.cycle.capture_paused_reason, 'counters_decreased');
    assert.equal((await read('reading', lowered)).observation.total_wins, 6);
    assert.equal(detail.latest_observation.id, lowered, 'Paused detail exposes the new reading for explicit reconfirmation');
    const paused = { cycle_id: saved.cycle_id, version: detail.cycle.version };
    await assert.rejects(edit(paused, initial), e => e.code === '22023');
    await assert.rejects(edit(paused, { ...initial, initialObservationId: lowered }), e => e.code === '22023');
    const resumed = await edit(paused, { ...initial, initialObservationId: lowered, notes: 'Confirmed source correction in the same cycle.' });
    detail = await read('cycle', saved.cycle_id); assert.equal(detail.cycle.reported_total_wins, 6); assert.equal(detail.cycle.capture_paused_reason, null); assert.equal(detail.cycle.capture_enabled, true);
    const revision = (await db.query('SELECT before_snapshot,after_snapshot FROM club_mega_pig_cycle_revisions WHERE cycle_id=$1 AND version=$2', [saved.cycle_id, resumed.version])).rows[0];
    assert.equal(revision.before_snapshot.initial_observation_id, observed); assert.equal(revision.after_snapshot.initial_observation_id, lowered);
    await record(sample(7)); assert.equal((await read('cycle', saved.cycle_id)).cycle.reported_total_wins, 7);
  });
  await t.test('future/ended windows and finalized cycles stop automatic capture without inventing final outcomes', async () => {
    await reset(); const observed = await record(), ended = input(observed, { startsAt: at(-5000), endsAt: at(-4000) });
    const saved = await create(ended); assert.equal((await read('cycle', saved.cycle_id)).cycle.reported_total_wins, 82, 'Explicit initial confirmation may map an outside-window reading');
    await record(sample(83)); let detail = await read('cycle', saved.cycle_id); assert.equal(detail.cycle.reported_total_wins, 82); assert.equal(detail.cycle.finalized_at, null);
    await assert.rejects(edit(saved, { ...ended, startsAt: at(-4000), endsAt: at(-3000) }), e => e.code === '55000');
    await assert.rejects(write('finalize_cycle', { id: saved.cycle_id, version: saved.version, finalTotalWins: 82, confirmedStage: 4, rewardStatus: 'received', notes: '' }), e => e.code === '22023');
    const final = await write('finalize_cycle', { id: saved.cycle_id, version: saved.version, finalTotalWins: null, confirmedStage: null, rewardStatus: 'unknown', notes: 'Final values not verified.' });
    detail = await read('cycle', saved.cycle_id); assert.equal(detail.cycle.final_total_wins, null); assert.equal(detail.cycle.confirmed_stage, null); assert.equal(detail.cycle.reward_status, 'unknown'); assert.ok(detail.cycle.finalized_at);
    const reopened = await write('reopen_cycle', { id: saved.cycle_id, version: final.version, reason: 'Review final record.' });
    assert.equal(reopened.version, final.version + 1); detail = await read('cycle', saved.cycle_id); assert.equal(detail.cycle.finalized_at, null); assert.equal(detail.cycle.capture_enabled, false);
    const future = await create(input(observed, { startsAt: at(60), endsAt: at(120) })); await record(sample(84)); assert.equal((await read('cycle', future.cycle_id)).cycle.reported_total_wins, 82);
    await assert.rejects(write('finalize_cycle', { id: future.cycle_id, version: future.version, finalTotalWins: 82, confirmedStage: 5, rewardStatus: 'received', notes: '' }), e => e.code === '55000');
  });
  await t.test('overlapping enabled cycles serialize across two administrative workers', async () => {
    await reset(); const observed = await record(), cycle = input(observed), other = new Client({ connectionString: url.href }); await other.connect(); local(other);
    try {
      const results = await Promise.allSettled([create(cycle), create({ ...cycle, title: 'Concurrent' }, randomUUID(), other)]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, '40001');
      assert.equal((await read('cycles')).cycles.length, 1);
    } finally { await other.end(); }
  });
  await t.test('capture and admin actions share serialization without taking source cache locks in reverse order', async () => {
    await reset(); const observed = await record(), saved = await create(input(observed));
    const other = new Client({ connectionString: url.href }); await other.connect(); local(other);
    try {
      await db.query('BEGIN'); await db.query("SELECT 1 FROM settings WHERE key='club_tag' FOR SHARE"); await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,3901))', [club]);
      let completed = false; const capture = other.query('SELECT mega_pig_archive_capture($1,$2,$3,$4)', [club, sample(83), at(-0.01), 'source_fetch']).then(() => { completed = true; });
      await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(completed, false);
      await db.query('COMMIT'); await capture; assert.equal((await read('cycle', saved.cycle_id)).cycle.reported_total_wins, 83);
    } finally { await db.query('ROLLBACK'); await other.end(); }
  });
  await t.test('failed archive persistence rolls back the successful cache finish too', async () => {
    await reset(); await db.query('INSERT INTO club_mega_pig_source_cache(club_tag,payload,fetched_at,last_attempt_at) VALUES($1,$2,$3,$3)', [club, sample(), at(-40)]);
    const token = randomUUID(); await db.query('SELECT claim_mega_pig_source_cache($1,$2)', [club, token]);
    await db.query("CREATE FUNCTION public.archive_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rejection'; END $$; CREATE TRIGGER archive_test_reject BEFORE INSERT ON club_mega_pig_observations FOR EACH ROW EXECUTE FUNCTION public.archive_test_reject()");
    try { await assert.rejects(db.query('SELECT finish_mega_pig_source_cache($1,$2,$3,NULL,NULL)', [club, token, sample(83)]), e => e.code === 'P0001'); }
    finally { await db.query('DROP TRIGGER archive_test_reject ON club_mega_pig_observations; DROP FUNCTION public.archive_test_reject()'); }
    const cache = (await db.query('SELECT payload,lease_token FROM club_mega_pig_source_cache')).rows[0]; assert.equal(cache.payload.totalWins, 82); assert.equal(cache.lease_token, token); assert.equal((await read('cycles')).observation_count, 0);
  });
  await t.test('unconfirmed cycles cannot auto-capture, constraints preserve nulls, and another club is isolated', async () => {
    await reset(); const observed = await record();
    await assert.rejects(create(input(null)), e => e.code === '22023');
    for (const milestones of [[], [1, 1], [2, 1], [0], [1, null], Array.from({ length: 11 }, (_, i) => i + 1)]) await assert.rejects(create(input(observed, { milestones })), e => e.code === '22023');
    const saved = await create(input(null, { captureEnabled: false, milestones: null })); await record(sample(83)); assert.equal((await read('cycle', saved.cycle_id)).cycle.reported_total_wins, null);
    await assert.rejects(read('cycle', randomUUID()), e => e.code === 'P0002'); await assert.rejects(read('cycles', null, null, 0, db, '#GGRR'), e => e.code === '55000');
    await db.query("UPDATE settings SET value='#GGRR' WHERE key='club_tag'");
    await assert.rejects(edit(saved, input(observed)), e => e.code === '55000'); await assert.rejects(read('reading', observed), e => e.code === '55000');
  });
  await t.test('bounded read pages expose all retained former members, cycles, source changes and player history', async () => {
    await reset(); const observed = await record(); const saved = await create(input(observed, { captureEnabled: false }));
    await db.query("INSERT INTO club_mega_pig_cycle_members(cycle_id,player_tag,first_player_name,player_name) SELECT $1,'#OLD'||i,'Former','Former' FROM generate_series(1,51) i", [saved.cycle_id]);
    const first = await read('cycle', saved.cycle_id), second = await read('cycle', saved.cycle_id, null, first.next_offset);
    assert.equal(first.members.length, 50); assert.equal(first.next_offset, 50); assert.equal(second.members.length, 4); assert.equal(second.next_offset, null);
    assert.equal(new Set([...first.members, ...second.members].map(m => m.player_tag)).size, 54);
    for (let i = 0; i < 21; i++) { await create(input(observed, { captureEnabled: false, title: `Cycle${i}` })); await record(sample(100 + i)); }
    for (const mode of ['cycles', 'readings', 'player']) {
      const page = await read(mode, null, mode === 'player' ? '#PYLR' : null); const key = mode === 'cycles' ? 'cycles' : mode === 'readings' ? 'observations' : 'history';
      assert.equal(page[key].length, 20); assert.equal(page.next_offset, 20);
      const more = await read(mode, null, mode === 'player' ? '#PYLR' : null, 20); assert.equal(more[key].length, 2); assert.equal(more.next_offset, null);
      if (mode === 'player') { assert.equal(page.player_readings.length, 20); assert.equal(more.player_readings.length, 2); }
    }
    await record(sample(130)); await record(sample(131));
    const independent = await read('player', null, '#PYLR', 20); assert.equal(independent.history.length, 2); assert.equal(independent.player_readings.length, 4);
    assert.equal((await read('player', null, '#PYLC')).player_readings.length, 0, 'Roster-only membership never fabricates source readings');
  });
  await t.test('real SQL responses and mutations satisfy the TypeScript service contract for every read mode and finalization', async () => {
    await reset(); const observed = await record();
    const service = loadTypeScript('src/lib/mega-pig-archive.ts', {
      '@/lib/accepted-club-roster': { requireAcceptedClubRoster: async () => club, assertAcceptedClubRoster: async value => assert.equal(value, club) },
      '@/lib/supabase-admin': { supabaseAdmin: { rpc(name, args) { return { abortSignal: async () => {
        try {
          const value = name === 'mega_pig_archive_read'
            ? await read(args.p_mode, args.p_id, args.p_player, args.p_offset, db, args.p_club)
            : await write(args.p_action, args.p_body, db, args.p_club);
          return { data: value, error: null };
        } catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
      } }; } } },
    });
    const cycle = input(observed, { startsAt: at(-10000), endsAt: at(-9000), captureEnabled: false, notes: 'ا'.repeat(2000) });
    const saved = await service.mutateMegaPigArchive({ action: 'save_cycle', id: null, version: 0, requestId: randomUUID(), cycle });
    const fetch = async params => service.readMegaPigArchive(new URLSearchParams(params));
    const listing = await fetch({ mode: 'cycles' }); assert.equal(listing.cycles[0].id, saved.id); assert.equal(listing.latestObservation.totalWins, 82);
    const detail = await fetch({ mode: 'cycle', id: saved.id }); assert.equal(detail.cycle.initialObservationId, observed); assert.equal(detail.latestObservation.id, observed); assert.equal(detail.members.length, 3);
    const readings = await fetch({ mode: 'readings' }); assert.equal(readings.observations[0].id, observed);
    const reading = await fetch({ mode: 'reading', id: observed }); assert.equal(reading.observation.members.find(m => m.playerTag === '#PYLU').reportedWins, null);
    const player = await fetch({ mode: 'player', player: '#PYLR' }); assert.equal(player.history[0].cycle.id, saved.id); assert.equal(player.playerReadings[0].member.reportedWins, 5);
    const final = await service.mutateMegaPigArchive({ action: 'finalize_cycle', id: saved.id, version: saved.version, finalTotalWins: 82, confirmedStage: 5, rewardStatus: 'received', notes: '' });
    assert.equal((await fetch({ mode: 'cycle', id: saved.id })).cycle.rewardStatus, 'received');
    const reopened = await service.mutateMegaPigArchive({ action: 'reopen_cycle', id: saved.id, version: final.version, reason: 'ا'.repeat(2000) });
    assert.equal(reopened.version, final.version + 1); assert.equal((await fetch({ mode: 'cycle', id: saved.id })).cycle.captureEnabled, false);
    await create(input(null, { captureEnabled: false, startsAt: at(-60 * 24 * 89), endsAt: at(1) }));
    await assert.rejects(create(input(null, { captureEnabled: false, startsAt: at(-60 * 24 * 91), endsAt: at(1) })), e => e.code === '22023');
  });
  await t.test('private ACLs survive permissive defaults; reads are genuinely read-only and immutable records have no public writes', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const queries = ['SELECT * FROM club_mega_pig_observations', 'DELETE FROM club_mega_pig_cycle_members', "SELECT mega_pig_archive_capture('#PYLQ','{}',now(),'source_fetch')", "SELECT mega_pig_archive_write('#PYLQ','save_cycle','{}')", "SELECT mega_pig_archive_read('#PYLQ','cycles')"];
      for (const sql of queries) {
        if (role === 'service_role' && (sql.startsWith('SELECT *') || sql.includes('archive_write(') || sql.includes('archive_read('))) continue;
        await db.query('BEGIN'); try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(db.query(sql), e => e.code === '42501'); } finally { await db.query('ROLLBACK'); }
      }
    }
    await db.query('BEGIN READ ONLY'); try { await db.query('SET LOCAL ROLE service_role'); assert.ok((await read('cycles')).cycles.length); } finally { await db.query('ROLLBACK'); }
    const fn = (await db.query("SELECT prosecdef,provolatile,proconfig FROM pg_proc WHERE oid='mega_pig_archive_read(text,text,uuid,text,integer)'::regprocedure")).rows[0];
    assert.equal(fn.prosecdef, true); assert.equal(fn.provolatile, 's'); assert.ok(fn.proconfig.includes('search_path=pg_catalog'));
    const backup = (await db.query("SELECT pg_get_functiondef('create_backup_snapshot(uuid)'::regprocedure) value")).rows[0].value;
    for (const table of ['club_mega_pig_cycles', 'club_mega_pig_cycle_members', 'club_mega_pig_observations', 'club_mega_pig_cycle_revisions']) assert.ok(backup.includes(`'${table}'`));
  });
});
