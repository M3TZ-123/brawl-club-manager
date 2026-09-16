const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');
const source = process.env.SYNC_TEST_DATABASE_URL || process.env.SECURITY_TEST_DATABASE_URL;
const root = path.resolve(__dirname, '../..');
const { readProfileRankedData, rankedSnapshot } = loadTypeScript('src/lib/ranked-data.ts');

test('profile progress is prospective, bounded and atomic in local PostgreSQL', { skip: !source }, async t => {
  const target = new URL(source);
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.match(target.pathname, /^\/brawl_[a-z_]+_tests$/); assert.equal(target.search, ''); assert.equal(target.hash, '');
  const loopback = db => assert.ok(['127.0.0.1', '::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/i, '')));
  target.pathname = '/postgres'; const admin = new Client({ connectionString: target.href }); await admin.connect();
  try {
    loopback(admin);
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_progress_tests'")).rowCount) {
      await admin.query("CREATE DATABASE brawl_progress_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
    }
  } finally { await admin.end(); }
  target.pathname = '/brawl_progress_tests'; const db = new Client({ connectionString: target.href }); await db.connect(); t.after(() => db.end()); loopback(db);
  assert.equal((await db.query('SELECT current_database() name')).rows[0].name, 'brawl_progress_tests');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  await db.query('ALTER TABLE members ADD COLUMN owner_user_id uuid');
  for (const file of fs.readdirSync(path.join(root, 'supabase/migrations')).filter(name => /^20260916\d{4}_.*\.sql$/.test(name) && name < '202609160020_').sort()) {
    await db.query(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'));
  }
  await db.query("INSERT INTO members(player_tag,player_name,rank_current,rank_highest) VALUES('#LEGACY','Legacy','Gold I','Masters')");
  const version = (await db.query("SELECT xmin::text version FROM members WHERE player_tag='#LEGACY'")).rows[0].version;
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/202609160020_player_progress.sql'), 'utf8');
  await db.query(migration); await db.query(migration);
  const preservation = fs.readFileSync(path.join(root, 'supabase/migrations/202609160025_equipment_metadata_preservation.sql'), 'utf8');
  await db.query(preservation); await db.query(preservation);
  const at = new Date(Date.now() - 30000).toISOString();
  const profile = { rankedSeasonId: 48, rankedRankName: 'DIAMOND I', rankedElo: 3417,
    highestSeasonRankedRankName: 'DIAMOND II', highestSeasonRankedElo: 3505, highestAllTimeRankedRankName: 'MASTERS', highestAllTimeRankedElo: 0 };
  const fields = p => JSON.parse(JSON.stringify(rankedSnapshot(readProfileRankedData(p), at)));
  const member = (overrides = {}) => ({ player_tag: '#AA', player_name: 'لاعب', role: 'member', trophies: 100,
    highest_trophies: 120, exp_level: 5, brawlers_count: 1, solo_victories: 2, duo_victories: 3, trio_victories: 4, ...('ranked_profile_version' in overrides ? {} : fields(profile)),
    profile_progress: { exp_points: 1245, fame: 750, fame_tier_name: 'Global I', total_prestige_level: 2 }, ...overrides });
  const brawler = (progress = {}) => ({ player_tag: '#AA', brawler_id: 16000000, brawler_name: 'SHELLY', power_level: 11, trophies: 750, rank: 25,
    gadgets_count: 1, star_powers_count: 0, gears_count: 1, progress: { highest_trophies: 900, prestige_level: 1, current_win_streak: 0, max_win_streak: 10,
      gadgets: [{ id: 23000000, name: 'FAST FORWARD' }], star_powers: [], gears: [{ id: 62000000, name: 'SPEED', level: 3 }],
      skin: { id: 29000001, name: 'Star Shelly' }, hyper_charges: [{ id: 76000000, name: 'Double Barrel' }], buffies: { gadget: true, starPower: false }, ...progress } });
  const payload = (overrides = {}) => ({ members: [member()], brawlers: [brawler()], battles: [],
    battle_observations: [{ player_tag: '#AA', success: true, battle_times: [] }], ranked_complete: true, battle_logs_complete: true, ...overrides });
  const acquire = async (scope = 'full') => (await db.query('SELECT acquire_sync_run($1,$2,$3,$4,NULL) x', ['#CLUB', scope === 'member' ? 'member' : 'manual', scope, scope === 'member' ? '#AA' : null])).rows[0].x;
  const commit = async (run, body) => (await db.query('SELECT commit_sync_snapshot($1,$2,$3) x', [run.run_id, run.fence, body])).rows[0].x;
  const save = async body => commit(await acquire(), body);
  const one = async table => (await db.query(`SELECT *,xmin::text version FROM ${table} WHERE player_tag='#AA'`)).rows[0];
  const history = async () => (await db.query("SELECT * FROM player_ranked_history WHERE player_tag='#AA' ORDER BY id")).rows;
  const reset = async () => {
    await db.query('TRUNCATE members,member_history,activity_log,club_events,battle_history,daily_stats,player_tracking,brawler_snapshots,notifications,sync_runs,sync_leases,membership_change_events,notification_outbox,member_activity_state,player_brawler_state,sync_battle_coverage,sync_battle_gaps,sync_ranked_fallback_attempts,settings RESTART IDENTITY CASCADE');
    await db.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('notifications_enabled','false')");
  };
  await t.test('repeatable additive migration leaves legacy data unchanged and never fabricates observations', async () => {
    assert.equal((await db.query("SELECT xmin::text version FROM members WHERE player_tag='#LEGACY'")).rows[0].version, version);
    for (const table of ['player_profile_details', 'player_brawler_details', 'player_ranked_history']) assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
  });
  await t.test('validated profile, reported equipment and first rank observation commit together without backdating', async () => {
    await reset(); const before = Date.now(); const run = await acquire(); const body = payload();
    body.brawlers[0].progress.hyper_charges[0].secret = 'never-store';
    const result = await commit(run, body); assert.equal(result.success, true);
    const detail = await one('player_profile_details'); const b = await one('player_brawler_details'); const h = await history();
    assert.equal(detail.exp_points, 1245); assert.equal(detail.fame, 750); assert.equal(detail.total_prestige_level, 2);
    assert.equal(b.highest_trophies, 900); assert.equal(b.current_win_streak, 0); assert.deepEqual(b.star_powers, []);
    assert.deepEqual(b.buffies, { gadget: true, starPower: false }); assert.equal(b.buffies.hyperCharge, undefined);
    assert.deepEqual(b.hyper_charges, [{ id: 76000000, name: 'Double Barrel' }]); assert.equal(JSON.stringify(b).includes('never-store'), false);
    assert.ok(detail.field_checked_at.highest_trophies); assert.ok(b.field_checked_at.hyper_charges);
    assert.equal(h.length, 1); assert.equal(h[0].kind, 'initial'); assert.equal(h[0].all_time_best, 'Masters'); assert.equal(h[0].all_time_best_points, 0);
    assert.ok(h[0].observed_at.getTime() >= before); assert.equal(h[0].provenance.rank_current.checked_at, at);
    assert.deepEqual(await commit(run, body), result); assert.equal((await history()).length, 1); assert.equal((await one('player_brawler_details')).version, b.version);
  });
  await t.test('missing/invalid optional values preserve knowledge; explicit empty arrays and false booleans update it', async () => {
    await reset(); await save(payload()); const b = await one('player_brawler_details');
    const next = brawler(); next.progress = { highest_trophies: 'invalid', prestige_level: -1, gadgets: [], gears: [{ id: 'bad' }], hyper_charges: null, buffies: { gadget: false, hyperCharge: false, secret: true } };
    await save(payload({ members: [member({ profile_progress: { fame: null, exp_points: -5, total_prestige_level: 0, fame_tier_name: '' }, ...fields({}) })], brawlers: [next] }));
    const detail = await one('player_profile_details'); const updated = await one('player_brawler_details');
    assert.equal(detail.exp_points, 1245); assert.equal(detail.fame, 750); assert.equal(detail.total_prestige_level, 0); assert.equal(detail.fame_tier_name, 'Global I');
    assert.equal(updated.highest_trophies, 900); assert.equal(updated.prestige_level, 1); assert.deepEqual(updated.gadgets, []); assert.deepEqual(updated.gears, b.gears); assert.deepEqual(updated.hyper_charges, b.hyper_charges);
    assert.deepEqual(updated.buffies, { gadget: false, starPower: false, hyperCharge: false }); assert.equal((await history()).length, 1);
  });
  await t.test('unchanged detail avoids row rewrites while profile check advances; changed points and season reset remain distinct', async () => {
    await reset(); await save(payload()); const b = await one('player_brawler_details'); const detail = await one('player_profile_details');
    await save(payload()); assert.equal((await one('player_brawler_details')).version, b.version); assert.ok((await one('player_profile_details')).observed_at > detail.observed_at); assert.equal((await history()).length, 1);
    await save(payload({ members: [member({ ...fields({ ...profile, rankedElo: 3500 }) })] }));
    await save(payload({ members: [member({ ...fields({ rankedSeasonId: 49 }) })] }));
    const h = await history(); assert.equal(h.length, 3); assert.equal(h[1].kind, 'change'); assert.equal(h[1].points, 3500);
    assert.equal(h[2].kind, 'season_reset'); assert.equal(h[2].season_best, null); assert.equal(h[2].all_time_best, 'Masters');
  });
  await t.test('partial equipment entries preserve known metadata for the same ID without inventing fresh verification', async () => {
    await reset(); await save(payload()); const before = await one('player_brawler_details');
    await db.query(preservation); assert.deepEqual(await one('player_brawler_details'), before, 'Applying the fix must not rewrite existing observations');
    const partial = brawler({ gears: [{ id: 62000000 }], skin: { id: 29000001 }, gadgets: [{ id: 23000000, name: '' }], hyper_charges: [{ id: 76000000 }] });
    partial.trophies = 751;
    await save(payload({ brawlers: [partial] })); const after = await one('player_brawler_details');
    assert.deepEqual(after.gears, before.gears); assert.deepEqual(after.skin, before.skin); assert.deepEqual(after.gadgets, before.gadgets); assert.deepEqual(after.hyper_charges, before.hyper_charges);
    assert.equal(after.trophies, 751); assert.ok(after.observed_at > before.observed_at);
    for (const field of ['gears', 'skin', 'gadgets', 'hyper_charges']) assert.equal(after.field_checked_at[field], before.field_checked_at[field]);
    await save(payload({ brawlers: [partial] })); assert.equal((await one('player_brawler_details')).version, after.version, 'An unchanged merged observation must not rewrite the row');
    await save(payload({ brawlers: [brawler({ gears: [{ id: 62000001 }], skin: { id: 29000002 }, gadgets: [], hyper_charges: [] })] }));
    const replacement = await one('player_brawler_details');
    assert.deepEqual(replacement.gears, [{ id: 62000001, name: null }]); assert.deepEqual(replacement.skin, { id: 29000002, name: null });
    assert.deepEqual(replacement.gadgets, []); assert.deepEqual(replacement.hyper_charges, []);
    await save(payload({ brawlers: [brawler({ gears: [{ id: 62000001, name: 'Updated', level: 0 }] })] }));
    assert.deepEqual((await one('player_brawler_details')).gears, [{ id: 62000001, name: 'Updated', level: 0 }]);
  });
  await t.test('invalid equipment attributes preserve knowledge while an omitted prior ID stays removed', async () => {
    await reset(); await save(payload({ brawlers: [brawler({ gears: [{ id: 62000000, name: 'SPEED', level: 3 }, { id: 62000001, name: 'DAMAGE', level: 2 }] })] }));
    const original = await one('player_brawler_details');
    await save(payload({ brawlers: [brawler({ gears: [{ id: 62000000, name: false }] })] }));
    const reduced = await one('player_brawler_details'); assert.deepEqual(reduced.gears, [{ id: 62000000, name: 'SPEED', level: 3 }]);
    assert.equal(reduced.field_checked_at.gears, original.field_checked_at.gears);
    await save(payload({ brawlers: [brawler({ gears: [{ id: 62000000, name: '', level: -1 }], skin: { id: 29000001, name: false } })] }));
    const invalid = await one('player_brawler_details'); assert.deepEqual(invalid.gears, reduced.gears); assert.deepEqual(invalid.skin, original.skin);
    assert.equal(invalid.version, reduced.version); assert.equal(invalid.field_checked_at.gears, original.field_checked_at.gears);
  });
  await t.test('cached-only ranked values do not invent a new observed history baseline', async () => {
    await reset(); await db.query("INSERT INTO members(player_tag,player_name,rank_current,rank_highest) VALUES('#AA','Legacy','Gold I','Masters')");
    await save(payload({ members: [member({ ...fields({}) })] })); assert.equal((await history()).length, 0);
    await save(payload({ members: [member({ ...fields({ highestAllTimeRankedRankName: 'MASTERS', highestAllTimeRankedElo: 0 }) })] }));
    assert.equal((await history()).length, 1);
  });
  await t.test('missing optional equipment never resets daily counts, including the next UTC day', async () => {
    await reset(); await save(payload()); const before = await one('brawler_snapshots');
    const sparse = brawler(); sparse.progress = {};
    delete sparse.gadgets_count; delete sparse.star_powers_count; delete sparse.gears_count;
    await save(payload({ brawlers: [sparse] }));
    const unchanged = await one('brawler_snapshots'); assert.equal(unchanged.version, before.version); assert.equal(unchanged.gadgets_count, 1);
    await db.query("UPDATE brawler_snapshots SET recorded_at=recorded_at-interval '1 day'");
    await save(payload({ brawlers: [sparse] }));
    const today = (await db.query('SELECT * FROM brawler_snapshots ORDER BY recorded_at DESC LIMIT 1')).rows[0];
    assert.equal(today.gadgets_count, 1); assert.equal(today.star_powers_count, 0); assert.equal(today.gears_count, 1);
    await save(payload({ brawlers: [{ ...sparse, gadgets_count: 0, progress: { gadgets: [] } }] }));
    assert.equal((await db.query('SELECT gadgets_count FROM brawler_snapshots ORDER BY recorded_at DESC LIMIT 1')).rows[0].gadgets_count, 0);
  });
  await t.test('optional duration enriches one existing battle without erasure or double-counting', async () => {
    await reset(); const battle = { player_tag: '#AA', battle_time: at, mode: 'brawlBall', map: 'Backyard Bowl', result: 'victory', trophy_change: 8, trophy_change_reported: true, is_star_player: true, brawler_name: 'SHELLY', brawler_power: 11, brawler_trophies: 750, teams_json: [] };
    await save(payload({ battles: [battle] })); assert.equal((await one('battle_history')).duration_seconds, null);
    await save(payload({ battles: [{ ...battle, duration_seconds: 0 }] })); assert.equal((await one('battle_history')).duration_seconds, 0);
    await save(payload({ battles: [{ ...battle, duration_seconds: 120 }] }));
    await save(payload({ battles: [{ ...battle, duration_seconds: 'wrong' }] })); assert.equal((await one('battle_history')).duration_seconds, 120);
    assert.equal((await one('daily_stats')).battles, 1); assert.equal((await db.query('SELECT count(*)::int n FROM battle_history')).rows[0].n, 1);
  });
  await t.test('late progress failure rolls back members, details, ranks, markers and public completion signal', async () => {
    await reset(); await save(payload()); const old = await one('members'); const detail = await one('player_profile_details'); const h = await history();
    const signal = (await db.query('SELECT * FROM club_sync_signals')).rows;
    await db.query("CREATE FUNCTION fail_progress_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test progress rollback'; END $$; CREATE TRIGGER fail_progress_test BEFORE INSERT ON player_ranked_history FOR EACH ROW EXECUTE FUNCTION fail_progress_test()");
    const run = await acquire(); const body = payload({ members: [member({ trophies: 999, ...fields({ ...profile, rankedElo: 4000 }), profile_progress: { fame: 1000 } })] });
    try { await assert.rejects(commit(run, body), /test progress rollback/); }
    finally { await db.query('DROP TRIGGER fail_progress_test ON player_ranked_history; DROP FUNCTION fail_progress_test()'); }
    assert.deepEqual(await one('members'), old); assert.deepEqual(await one('player_profile_details'), detail); assert.deepEqual(await history(), h); assert.deepEqual((await db.query('SELECT * FROM club_sync_signals')).rows, signal);
    assert.equal((await db.query('SELECT status FROM sync_runs WHERE id=$1', [run.run_id])).rows[0].status, 'running');
    await commit(run, body); assert.equal((await one('members')).trophies, 999);
  });
  await t.test('member refresh records progress, roster does not; removed collection never deletes history', async () => {
    await reset(); await save(payload()); const run = await acquire('member'); await commit(run, payload({ members: [member({ profile_progress: { fame: 1000 } })] }));
    const detail = await one('player_profile_details'); assert.equal(detail.fame, 1000);
    const roster = await acquire('roster'); await db.query('SELECT commit_roster_snapshot($1,$2,$3)', [roster.run_id, roster.fence, { members: [{ player_tag: '#AA', player_name: 'لاعب', role: 'member', trophies: 105 }] }]);
    assert.deepEqual(await one('player_profile_details'), detail);
    await save(payload({ brawlers: [], members: [member({ brawlers_count: 0 })] })); assert.equal(await one('player_brawler_details'), undefined);
    assert.ok(await one('brawler_snapshots')); assert.equal((await history()).length, 1);
  });
  await t.test('maintenance retains changes7d then real latest daily observations by season90d, preserving membership audit', async () => {
    await reset(); await save(payload()); const audit = (await db.query('SELECT count(*)::int n FROM membership_change_events')).rows[0].n;
    await db.query(`INSERT INTO player_ranked_history(player_tag,run_id,observed_at,kind,season_id,points)
      SELECT '#AA',gen_random_uuid(),(now() AT TIME ZONE 'UTC')::date+v.offset_time,'change',v.season_id,v.points
      FROM (VALUES(interval '-2 days 1 hour',48,1),(interval '-2 days 2 hours',48,2),
        (interval '-10 days 1 hour',48,10),(interval '-10 days 2 hours',48,11),(interval '-10 days 3 hours',49,12),
        (interval '-89 days 1 hour',47,13),(interval '-91 days 1 hour',46,14)) v(offset_time,season_id,points)`);
    const result = (await db.query('SELECT run_sync_maintenance() result')).rows[0].result;
    assert.equal(result.rankedHistory, 2); const rows = await history(); assert.equal(rows.length, 6);
    assert.deepEqual(rows.filter(r => r.observed_at < new Date(Date.now() - 7 * 86400000)).map(r => r.points).sort((a, b) => a - b), [11, 12, 13]);
    assert.equal((await db.query('SELECT count(*)::int n FROM membership_change_events')).rows[0].n, audit);
  });
  await t.test('public roles cannot read or write details and service can read but must mutate through fenced commit', async () => {
    await reset(); await save(payload());
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await db.query(`SET ROLE ${role}`);
      try {
        for (const table of ['player_profile_details', 'player_brawler_details', 'player_ranked_history']) {
          if (role === 'service_role') assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 1);
          else await assert.rejects(db.query(`SELECT * FROM ${table}`), e => e.code === '42501');
          await assert.rejects(db.query(`DELETE FROM ${table}`), e => e.code === '42501');
        }
        await assert.rejects(db.query("SELECT sync_apply_player_progress(gen_random_uuid(),'{\"members\":[],\"brawlers\":[]}',now())"), e => e.code === '42501');
        await assert.rejects(db.query("SELECT sync_merge_progress_equipment('[]','[]')"), e => e.code === '42501');
      } finally { await db.query('RESET ROLE'); }
    }
    const run = await acquire(); await db.query('SET ROLE service_role');
    try { assert.equal((await commit(run, payload())).success, true); } finally { await db.query('RESET ROLE'); }
  });
});
