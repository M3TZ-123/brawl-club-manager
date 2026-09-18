const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { randomUUID } = require('node:crypto');
const source = process.env.SECURITY_TEST_DATABASE_URL || process.env.SYNC_TEST_DATABASE_URL;
const root = path.resolve(__dirname, '../..');
const club = '#PYLQ';
const sample = (wins = 4) => ({ clubTag: club, totalWins: wins, reportedPlayersPlayed: 1,
  members: [{ playerTag: '#PYLR', playerName: 'عضو', reportedWins: wins, reportedTicketsRemaining: 2 }] });
const toolsSample = (wins = 4) => ({ ...sample(wins), source: 'BrawlTools', reportedPlayersPlayed: null, reportedBattlesPlayed: 128 });
const secondsBetween = (left, right) => Math.round((Date.parse(left) - Date.parse(right)) / 1000);

test('Mega Pig source cache privately coordinates durable cadence and preserves evidence on failures', { skip: !source }, async t => {
  const url = new URL(source);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/brawl_(security|sync|mega_pig_source)_tests$/); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const local = db => assert.ok(['127.0.0.1', '::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/, '')));
  url.pathname = '/postgres'; const admin = new Client({ connectionString: url.href }); await admin.connect(); local(admin);
  try {
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_mega_pig_source_tests'")).rowCount) {
      await admin.query("CREATE DATABASE brawl_mega_pig_source_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
    }
  } finally { await admin.end(); }
  url.pathname = '/brawl_mega_pig_source_tests'; const db = new Client({ connectionString: url.href }); await db.connect(); local(db); t.after(() => db.end());
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  for (const file of fs.readdirSync(path.join(root, 'supabase/migrations')).filter(name => /^20260916\d{4}_.*\.sql$/.test(name)).sort()) {
    await db.query(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'));
  }
  await db.query("INSERT INTO settings(key,value) VALUES('club_tag',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [club]);
  const reset = async () => { await db.query('TRUNCATE club_mega_pig_source_cache; TRUNCATE club_planned_events CASCADE'); await db.query("UPDATE settings SET value=$1 WHERE key='club_tag'", [club]); };
  const claim = async (token = randomUUID(), connection = db, target = club) => {
    const data = (await connection.query('SELECT public.claim_mega_pig_source_cache($1,$2) value', [target, token])).rows[0].value;
    return { token, ...data };
  };
  const claimTools = async (token = randomUUID(), connection = db, target = club) => {
    const data = (await connection.query('SELECT public.claim_mega_pig_brawltools_cache($1,$2) value', [target, token])).rows[0].value;
    return { token, ...data };
  };
  const finish = async (token, payload = sample(), error = null, retry = null, connection = db, target = club) =>
    (await connection.query('SELECT public.finish_mega_pig_source_cache($1,$2,$3,$4,$5) value', [target, token, payload, error, retry])).rows[0].value;
  const due = () => db.query("UPDATE club_mega_pig_source_cache SET next_check_at=clock_timestamp()-interval '1 second',lease_expires_at=NULL");
  const event = async (status = 'planned', endedHoursAgo = -1) => {
    await db.query("INSERT INTO club_planned_events(club_tag,title,kind,cycle_label,starts_at,ends_at,team_size,status) VALUES($1,'Mega Pig','mega_pig','Saved cycle',clock_timestamp()-interval '2 days',clock_timestamp()-$2*interval '1 hour',3,$3)", [club, endedHoursAgo, status]);
  };

  await t.test('two independent workers obtain only one claim; successful default checks are twenty minutes apart', async () => {
    await reset(); const other = new Client({ connectionString: url.href }); await other.connect(); local(other);
    try {
      const pair = await Promise.all([claim(), claim(randomUUID(), other)]);
      assert.equal(pair.filter(result => result.acquired).length, 1); assert.equal(pair.filter(result => !result.acquired).length, 1);
      for (const result of pair) assert.equal(Object.hasOwn(result.entry, 'lease_token'), false);
      const winner = pair.find(result => result.acquired), saved = await finish(winner.token);
      assert.equal(saved.accepted, true); assert.equal(saved.entry.payload.totalWins, 4); assert.equal(saved.entry.consecutive_failures, 0);
      assert.equal(secondsBetween(saved.entry.next_check_at, saved.entry.fetched_at), 1200);
      assert.equal((await claim()).acquired, false); assert.equal(saved.entry.lease_expires_at, null);
    } finally { await other.end(); }
  });
  await t.test('planned or recently completed windows shorten only successful checks; cancellation and old windows do not', async () => {
    for (const [status, hours, expected] of [['planned', -1, 600], ['completed', 5, 600], ['completed', 7, 1200], ['cancelled', -1, 1200]]) {
      await reset(); await event(status, hours); const acquired = await claim(), saved = await finish(acquired.token);
      assert.equal(secondsBetween(saved.entry.next_check_at, saved.entry.fetched_at), expected, `${status}/${hours}`);
    }
    await reset(); const first = await claim(); await finish(first.token);
    await db.query("UPDATE club_mega_pig_source_cache SET fetched_at=clock_timestamp()-interval '11 minutes',last_attempt_at=clock_timestamp()-interval '12 minutes',next_check_at=clock_timestamp()+interval '9 minutes'");
    assert.equal((await claim()).acquired, false); await event(); assert.equal((await claim()).acquired, true, 'A newly saved active window may shorten20m to10m');
  });
  await t.test('failed checks retain known data and use exponential cooldown even when an event becomes active', async () => {
    await reset(); const initial = await claim(); const known = (await finish(initial.token)).entry;
    for (const expected of [1800, 3600, 7200, 14400, 21600, 21600]) {
      await due(); const acquired = await claim(), failed = (await finish(acquired.token, null, 'unavailable')).entry;
      assert.deepEqual(failed.payload, known.payload); assert.equal(failed.fetched_at, known.fetched_at); assert.equal(failed.changed_at, known.changed_at);
      assert.equal(failed.error_code, 'unavailable'); assert.equal(secondsBetween(failed.next_check_at, failed.last_attempt_at), expected);
      if (expected === 1800) await event();
      assert.equal((await claim()).acquired, false, 'Active events cannot bypass provider failure cooldown');
    }
    await due(); const next = await claim(), success = (await finish(next.token)).entry;
    assert.equal(success.consecutive_failures, 0); assert.equal(success.error_code, null);
    assert.equal(secondsBetween(success.next_check_at, success.fetched_at), 600);
  });
  await t.test('Retry-After longer than one day is honored up to seven days; short or absent headers cannot bypass minimum delay', async () => {
    for (const [retry, expected] of [[null, 1800], [20, 1800], [7200, 7200], [172800, 172800], [2147483647, 604800]]) {
      await reset(); const acquired = await claim(), failed = (await finish(acquired.token, null, 'rate_limited', retry)).entry;
      assert.equal(secondsBetween(failed.next_check_at, failed.last_attempt_at), expected); assert.equal((await claim()).acquired, false);
    }
  });
  await t.test('an abandoned claim still reserves a retry delay; stale or expired completions cannot replace it', async () => {
    await reset(); const first = await claim();
    assert.equal(secondsBetween(first.entry.next_check_at, first.entry.last_attempt_at), 1800);
    assert.equal((await finish(randomUUID())).accepted, false);
    await db.query("UPDATE club_mega_pig_source_cache SET lease_expires_at=clock_timestamp()-interval '1 second'");
    assert.equal((await finish(first.token)).accepted, false); assert.equal((await claim()).acquired, false);
    await due(); const next = await claim(); assert.equal(next.acquired, true);
    assert.equal((await finish(first.token, sample(99))).accepted, false);
    assert.equal((await finish(next.token, sample(5))).entry.payload.totalWins, 5);
  });
  await t.test('changing values keep one previous snapshot without inferring a reset or cycle; unchanged data keeps changedAt', async () => {
    await reset(); const first = await claim(), saved = (await finish(first.token, sample(10))).entry;
    await due(); const same = await claim(), unchanged = (await finish(same.token, sample(10))).entry;
    assert.equal(unchanged.changed_at, saved.changed_at); assert.equal(unchanged.previous_payload, null);
    await due(); const next = await claim(), lowered = (await finish(next.token, sample(1))).entry;
    assert.equal(lowered.previous_payload.totalWins, 10); assert.equal(lowered.payload.totalWins, 1);
    assert.doesNotMatch(JSON.stringify(lowered), /cycle|reset/);
    await due(); const failure = await claim(), retained = (await finish(failure.token, null, 'invalid')).entry;
    assert.deepEqual(retained.previous_payload, lowered.previous_payload); assert.equal(retained.changed_at, lowered.changed_at);
  });
  await t.test('configured-club changes reject both old claims and old completion without touching stored evidence', async () => {
    await reset(); const acquired = await claim(); await db.query("UPDATE settings SET value='#GGRR' WHERE key='club_tag'");
    await assert.rejects(claim(), error => error.code === '40001'); await assert.rejects(finish(acquired.token), error => error.code === '40001');
    const current = (await db.query('SELECT * FROM club_mega_pig_source_cache')).rows[0]; assert.equal(current.payload, null); assert.equal(current.lease_token, acquired.token);
    assert.equal((await claim(randomUUID(), db, '#GGRR')).acquired, true);
  });
  await t.test('one provider transition preserves old evidence and cooldown without transferring it to the independent API', async () => {
    await reset(); const first = await claim(); await finish(first.token);
    await due(); const changed = await claim(); await finish(changed.token, sample(5));
    await due(); const unavailable = await claim(); const old = (await finish(unavailable.token, null, 'unavailable')).entry;
    const observations = (await db.query('SELECT count(*) FROM club_mega_pig_observations')).rows[0].count;
    const other = new Client({ connectionString: url.href }); await other.connect(); local(other);
    let switched;
    try {
      const attempts = await Promise.all([claimTools(), claimTools(randomUUID(), other)]);
      assert.equal(attempts.filter(value => value.acquired).length, 1);
      switched = attempts.find(value => value.acquired);
    } finally { await other.end(); }
    assert.equal(switched.entry.source_provider, 'BrawlTools'); assert.equal(switched.entry.consecutive_failures, 0);
    assert.equal(switched.entry.error_code, null); assert.deepEqual(switched.entry.payload, old.payload);
    assert.deepEqual(switched.entry.previous_payload, old.previous_payload);
    assert.equal(switched.entry.fetched_at, old.fetched_at); assert.equal(switched.entry.changed_at, old.changed_at);
    const previous = switched.entry.previous_provider_state;
    assert.equal(previous.source_provider, 'BrawlAce'); assert.equal(previous.error_code, old.error_code);
    assert.equal(previous.last_attempt_at, old.last_attempt_at); assert.equal(previous.next_check_at, old.next_check_at);
    assert.equal(previous.consecutive_failures, old.consecutive_failures); assert.ok(previous.transitioned_at);
    assert.equal(Object.hasOwn(previous, 'lease_token'), false);
    assert.equal((await db.query('SELECT count(*) FROM club_mega_pig_observations')).rows[0].count, observations);
    assert.equal((await claim()).acquired, false, 'Old workers cannot fetch BrawlAce on the new schedule');
    const failed = (await finish(switched.token, null, 'rate_limited', 7200)).entry;
    assert.equal(failed.consecutive_failures, 1); assert.equal(secondsBetween(failed.next_check_at, failed.last_attempt_at), 7200);
    await event();
    for (let i = 0; i < 3; i++) {
      const again = await claimTools(); assert.equal(again.acquired, false);
      assert.equal(again.entry.next_check_at, failed.next_check_at); assert.equal(again.entry.consecutive_failures, 1);
      assert.deepEqual(again.entry.previous_provider_state, previous); assert.equal((await claim()).acquired, false);
    }
    await due(); const retry = await claimTools(), second = (await finish(retry.token, null, 'rate_limited', 20)).entry;
    assert.equal(second.consecutive_failures, 2); assert.equal(secondsBetween(second.next_check_at, second.last_attempt_at), 3600);
    assert.deepEqual(second.previous_provider_state, previous, 'The switch happens once and does not reset new-provider failures');
  });
  await t.test('an active old lease delays switching and an expired old worker cannot write after the transition', async () => {
    await reset(); const old = await claim();
    const before = (await db.query('SELECT to_jsonb(c) value FROM club_mega_pig_source_cache c')).rows[0].value;
    const blocked = await claimTools(); assert.equal(blocked.acquired, false); assert.equal(blocked.entry.source_provider, 'BrawlAce');
    assert.deepEqual((await db.query('SELECT to_jsonb(c) value FROM club_mega_pig_source_cache c')).rows[0].value, before);
    await db.query("UPDATE club_mega_pig_source_cache SET lease_expires_at=clock_timestamp()-interval '1 second'");
    const switched = await claimTools(); assert.equal(switched.acquired, true);
    assert.equal((await finish(old.token)).accepted, false);
    await assert.rejects(finish(switched.token, sample()), error => error.code === '22023', 'A payload must match its leased provider');
    const saved = (await finish(switched.token, toolsSample())).entry;
    assert.equal(saved.payload.source, 'BrawlTools'); assert.equal(saved.payload.reportedPlayersPlayed, null);
    assert.equal(saved.payload.reportedBattlesPlayed, 128); assert.equal(secondsBetween(saved.next_check_at, saved.fetched_at), 1200);
    const latest = (await db.query('SELECT payload FROM club_mega_pig_observations ORDER BY recorded_at DESC,id DESC LIMIT 1')).rows[0].payload;
    assert.equal(latest.source, 'BrawlTools'); assert.equal(latest.reportedPlayersPlayed, null);
    await due(); assert.equal((await claim()).acquired, false); assert.equal((await claimTools()).acquired, true);
    await db.query("UPDATE settings SET value='#GGRR' WHERE key='club_tag'");
    await assert.rejects(claimTools(), error => error.code === '40001');
  });
  await t.test('input bounds fail closed and all cache mutation is restricted to service-only RPCs', async () => {
    await reset(); const acquired = await claim();
    for (const bad of [{ ...sample(), clubTag: '#GGRR' }, { ...sample(), members: {} }, { ...sample(), members: Array.from({ length: 31 }, () => sample().members[0]) }, { ...sample(), large: 'x'.repeat(65536) }]) {
      await assert.rejects(finish(acquired.token, bad), error => error.code === '22023');
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const sql of ['SELECT * FROM public.club_mega_pig_source_cache', "INSERT INTO public.club_mega_pig_source_cache(club_tag) VALUES('#GGRR')", 'DELETE FROM public.club_mega_pig_source_cache', "SELECT public.claim_mega_pig_source_cache('#PYLQ','00000000-0000-4000-8000-000000000001')",
        "SELECT public.claim_mega_pig_brawltools_cache('#PYLQ','00000000-0000-4000-8000-000000000001')",
        "SELECT public.claim_mega_pig_provider_cache('#PYLQ','00000000-0000-4000-8000-000000000001','BrawlTools')"]) {
        if (role === 'service_role' && (sql.startsWith('SELECT *') || (sql.startsWith('SELECT public.claim') && !sql.includes('provider_cache')))) continue;
        await db.query('BEGIN'); try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(db.query(sql), error => error.code === '42501'); } finally { await db.query('ROLLBACK'); }
      }
      if (role !== 'service_role') {
        await db.query('BEGIN'); try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(finish(acquired.token), error => error.code === '42501'); } finally { await db.query('ROLLBACK'); }
      }
    }
    await db.query('BEGIN'); try { await db.query('SET LOCAL ROLE service_role'); assert.equal((await finish(acquired.token)).accepted, true); } finally { await db.query('ROLLBACK'); }
    const functions = (await db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('claim_mega_pig_source_cache','claim_mega_pig_brawltools_cache','finish_mega_pig_source_cache')")).rows;
    assert.equal(functions.length, 3); for (const fn of functions) { assert.equal(fn.prosecdef, true); assert.ok(fn.proconfig.includes('search_path=pg_catalog')); }
    assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.club_mega_pig_source_cache'::regclass")).rows[0].relrowsecurity, true);
  });
  await t.test('the new private table is included in the existing bounded backup capture allowlist', async () => {
    const definition = (await db.query("SELECT pg_get_functiondef('public.create_backup_snapshot(uuid)'::regprocedure) value")).rows[0].value;
    assert.match(definition, /v_allowed text\[\] := ARRAY\[[^\]]*'club_mega_pig_source_cache'/);
    assert.match(definition, /club_roster_snapshots/); assert.match(definition, /club_event_entries/);
  });
});
