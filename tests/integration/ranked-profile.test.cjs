const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');
const source = process.env.SYNC_TEST_DATABASE_URL;
const root = path.resolve(__dirname, '../..');
const { readProfileRankedData, rankedSnapshot } = loadTypeScript('src/lib/ranked-data.ts');

test('ranked profile persistence and shared fallback cadence use real PostgreSQL', { skip: !source }, async t => {
  const target = new URL(source);
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.match(target.pathname, /^\/brawl_[a-z_]+_tests$/);
  assert.equal(target.search, ''); assert.equal(target.hash, '');
  const loopback = db => assert.ok(['127.0.0.1', '::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/i, '')));
  target.pathname = '/postgres';
  const admin = new Client({ connectionString: target.href }); await admin.connect();
  try {
    loopback(admin);
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_ranked_tests'")).rowCount) {
      await admin.query("CREATE DATABASE brawl_ranked_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
    }
  } finally { await admin.end(); }
  target.pathname = '/brawl_ranked_tests';
  const db = new Client({ connectionString: target.href }); await db.connect(); t.after(() => db.end()); loopback(db);
  assert.equal((await db.query('SELECT current_database() name')).rows[0].name, 'brawl_ranked_tests');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  await db.query('ALTER TABLE members ADD COLUMN owner_user_id uuid');
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(name => /^20260916\d{4}_.*\.sql$/.test(name)).sort();
  for (const name of migrations.filter(name => name < '202609160015_')) {
    await db.query(fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8'));
  }
  await db.query("INSERT INTO members(player_tag,player_name,rank_current,rank_highest) VALUES('#LEGACY','Legacy','Gold I','Masters')");
  const legacyVersion = (await db.query("SELECT xmin::text version FROM members WHERE player_tag='#LEGACY'")).rows[0].version;
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/202609160015_ranked_profile.sql'), 'utf8');
  await db.query(migration); await db.query(migration);
  const at = new Date(Date.now() - 30000).toISOString();
  const profile = { rankedSeasonId: 48, rankedRankName: 'DIAMOND I', rankedElo: 3417,
    highestSeasonRankedRankName: 'DIAMOND II', highestSeasonRankedElo: 3505,
    highestAllTimeRankedRankName: 'MASTERS', highestAllTimeRankedElo: 0 };
  const fields = p => JSON.parse(JSON.stringify(rankedSnapshot(readProfileRankedData(p), at)));
  const member = (tag = '#AA', ranked = profile) => ({ player_tag: tag, player_name: 'لاعب', role: 'member', trophies: 100,
    highest_trophies: 120, exp_level: 5, brawlers_count: 1, solo_victories: 2, duo_victories: 3, trio_victories: 4, ...fields(ranked) });
  const payload = (members = [member()], extra = {}) => ({ members, battles: [], brawlers: [],
    battle_observations: members.map(m => ({ player_tag: m.player_tag, success: true, battle_times: [] })),
    ranked_complete: members.every(m => m.rank_available), ranked_attempted: false, battle_logs_complete: true, ...extra });
  const acquire = async (options = {}, connection = db) => (await connection.query('SELECT acquire_sync_run($1,$2,$3,$4,$5) x',
    ['#CLUB', options.source || 'manual', options.scope || 'full', options.tag || null, options.key || null])).rows[0].x;
  const commit = async (run, body, connection = db) => (await connection.query('SELECT commit_sync_snapshot($1,$2,$3) x', [run.run_id, run.fence, body])).rows[0].x;
  const reserve = async (run, tags = ['#AA'], connection = db) => (await connection.query('SELECT begin_sync_ranked_fallback($1,$2,$3) tags', [run.run_id, run.fence, tags])).rows[0].tags;
  const fail = async run => db.query("SELECT fail_sync_run($1,$2,'snapshot_rejected','The snapshot was not committed.')", [run.run_id, run.fence]);
  const get = async (tag = '#AA') => (await db.query('SELECT *,xmin::text version FROM members WHERE player_tag=$1', [tag])).rows[0];
  const setting = async key => (await db.query('SELECT value FROM settings WHERE key=$1', [key])).rows[0]?.value;
  const reset = async () => {
    await db.query('TRUNCATE members,member_history,activity_log,club_events,battle_history,daily_stats,player_tracking,brawler_snapshots,notifications,sync_runs,sync_leases,membership_change_events,notification_outbox,member_activity_state,player_brawler_state,sync_battle_coverage,sync_battle_gaps,sync_ranked_fallback_attempts,settings RESTART IDENTITY CASCADE');
    await db.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('notifications_enabled','false'),('sync_ranked_interval_minutes','30')");
  };

  await t.test('additive migration is repeatable and never fabricates metadata for historical ranks', async () => {
    const row = await get('#LEGACY'); assert.equal(row.version, legacyVersion);
    assert.equal(row.rank_highest, 'Masters'); assert.equal(row.ranked_points, null);
    assert.equal(row.ranked_checked_at, null); assert.equal(row.ranked_source, null); assert.equal(row.ranked_provenance, null);
  });
  await t.test('current, season-best and all-time values commit atomically, including a historical rank with zero Elo', async () => {
    await reset(); const run = await acquire({ key: 'first-profile' }); const body = payload();
    body.members[0].ranked_provenance.rank_current.privateToken = 'must-not-leak';
    body.members[0].ranked_provenance.notes = { source: 'profile', checked_at: at };
    const result = await commit(run, body); const row = await get();
    assert.equal(result.success, true); assert.equal(row.rank_current, 'Diamond I'); assert.equal(row.ranked_points, 3417);
    assert.equal(row.ranked_season_id, 48); assert.equal(row.ranked_season_best, 'Diamond II'); assert.equal(row.ranked_season_best_points, 3505);
    assert.equal(row.rank_highest, 'Masters'); assert.equal(row.ranked_all_time_best_points, 0);
    assert.equal(row.ranked_checked_at.toISOString(), at); assert.equal(row.ranked_source, 'profile');
    assert.equal(await setting('last_ranked_attempt_time'), undefined); assert.ok(await setting('last_ranked_sync_time'));
    const events = (await db.query('SELECT after_snapshot FROM membership_change_events')).rows;
    assert.equal(events[0].after_snapshot.ranked_all_time_best_points, 0);
    assert.equal(JSON.stringify(events).includes('must-not-leak'), false); assert.equal(JSON.stringify(row.ranked_provenance).includes('notes'), false);
    assert.deepEqual(await commit(run, body), result); assert.equal((await get()).version, row.version);
    const replay = await acquire({ key: 'first-profile' }); assert.equal(replay.replayed, true); assert.deepEqual(replay.result, result);
  });
  await t.test('unknown modern ranks remain null, while explicit Unranked zero is accepted', async () => {
    await reset(); await commit(await acquire(), payload([member('#AA', {})]));
    const unknown = await get(); assert.equal(unknown.rank_current, null); assert.equal(unknown.rank_highest, null); assert.equal(unknown.ranked_points, null);
    assert.equal(await setting('last_ranked_sync_time'), undefined);
    await commit(await acquire(), payload([member('#AA', { rankedRankName: 'UNRANKED', rankedElo: 0, highestAllTimeRankedRankName: 'UNRANKED', highestAllTimeRankedElo: 0 })]));
    assert.equal((await get()).rank_current, 'Unranked'); assert.equal((await get()).ranked_points, 0);
  });
  await t.test('partial and failed observations preserve known values and complete freshness', async () => {
    await reset(); await commit(await acquire(), payload()); const before = await get(); const marker = await setting('last_ranked_sync_time');
    await commit(await acquire(), payload([member('#AA', { rankedElo: 3425 })]));
    const row = await get(); assert.equal(row.ranked_points, 3425); assert.equal(row.rank_current, before.rank_current);
    for (const key of ['rank_highest', 'ranked_all_time_best_points', 'ranked_season_best', 'ranked_season_best_points', 'ranked_source']) assert.deepEqual(row[key], before[key]);
    assert.equal(row.ranked_checked_at.toISOString(), before.ranked_checked_at.toISOString()); assert.equal(await setting('last_ranked_sync_time'), marker);
    await commit(await acquire(), payload([member('#AA', {})])); assert.equal((await get()).ranked_points, 3425);
    assert.deepEqual((await get()).ranked_provenance, row.ranked_provenance);
  });
  await t.test('a verified season rollover clears only stale season best evidence', async () => {
    await reset(); await commit(await acquire(), payload());
    await commit(await acquire(), payload([member('#AA', { rankedSeasonId: 49 })])); const row = await get();
    assert.equal(row.ranked_season_id, 49); assert.equal(row.ranked_season_best, null); assert.equal(row.ranked_season_best_points, null);
    assert.equal(row.rank_highest, 'Masters'); assert.equal(row.ranked_all_time_best_points, 0); assert.equal(row.rank_current, 'Diamond I');
    assert.equal(Object.hasOwn(row.ranked_provenance, 'ranked_season_best'), false);
    assert.equal(Object.hasOwn(row.ranked_provenance, 'ranked_season_best_points'), false);
    assert.equal(row.ranked_provenance.rank_highest.source, 'profile');
  });
  await t.test('member refresh returns public rank metadata and does not advance full freshness markers', async () => {
    await reset(); await commit(await acquire(), payload()); const marker = await setting('last_ranked_sync_time');
    await db.query("UPDATE members SET owner_user_id='00000000-0000-0000-0000-000000000001'");
    const run = await acquire({ source: 'member', scope: 'member', tag: '#AA' });
    const result = await commit(run, payload([member('#AA', { ...profile, rankedElo: 3440 })]));
    assert.equal(result.member.ranked_points, 3440); assert.equal(result.member.rank_highest, 'Masters'); assert.equal(Object.hasOwn(result.member, 'owner_user_id'), false);
    assert.equal(await setting('last_ranked_sync_time'), marker);
  });
  await t.test('fallback reservations survive a failed run and share cadence between full and manual member refresh', async () => {
    await reset(); await commit(await acquire(), payload()); const run = await acquire();
    assert.deepEqual(await reserve(run), ['#AA']); const marker = await setting('last_ranked_attempt_time'); const freshness = await setting('last_ranked_sync_time');
    await fail(run); const manual = await acquire({ source: 'member', scope: 'member', tag: '#AA' });
    assert.deepEqual(await reserve(manual), []); assert.equal(await setting('last_ranked_attempt_time'), marker); await fail(manual);
    const next = await acquire(); assert.deepEqual(await reserve(next, ['#AA', '#BB', '#BB']), ['#BB']);
    assert.equal(await setting('last_ranked_sync_time'), freshness);
    await db.query("UPDATE sync_ranked_fallback_attempts SET attempted_at=now()-interval '29 minutes 10 seconds' WHERE player_tag='#AA'");
    assert.deepEqual(await reserve(next, ['#AA']), ['#AA']);
  });
  await t.test('two independent callers can reserve the same player only once', async () => {
    await reset(); const run = await acquire(); const other = new Client({ connectionString: target.href }); await other.connect();
    try {
      const results = await Promise.all([reserve(run), reserve(run, ['#AA'], other)]);
      assert.deepEqual(results.map(tags => tags.length).sort(), [0, 1]);
      assert.equal((await db.query('SELECT count(*)::int n FROM sync_ranked_fallback_attempts')).rows[0].n, 1);
    } finally { await other.end(); }
  });
  await t.test('cooldowns, scope, configured club and stale fences block fallback before its marker', async () => {
    await reset(); const run = await acquire();
    await db.query("INSERT INTO settings(key,value) VALUES('sync_ranked_cooldown_until',(now()+interval '1 hour')::text)");
    assert.deepEqual(await reserve(run), []); assert.equal(await setting('last_ranked_attempt_time'), undefined);
    await db.query("DELETE FROM settings WHERE key='sync_ranked_cooldown_until'; UPDATE settings SET value='#OTHER' WHERE key='club_tag'");
    await assert.rejects(reserve(run), /club_configuration_changed/);
    await db.query("UPDATE settings SET value='#CLUB' WHERE key='club_tag'; UPDATE sync_leases SET expires_at=now()-interval '1 second'");
    const replacement = await acquire(); await assert.rejects(reserve(run), /stale_sync_fence/); await fail(replacement);
    const roster = await acquire({ scope: 'roster' }); await assert.rejects(reserve(roster), /sync_scope_mismatch/); await fail(roster);
    const manual = await acquire({ scope: 'member', source: 'member', tag: '#AA' }); await assert.rejects(reserve(manual, ['#BB']), /invalid_ranked_members/);
    assert.equal((await db.query('SELECT count(*)::int n FROM sync_ranked_fallback_attempts')).rows[0].n, 0);
  });
  await t.test('a late snapshot failure rolls back ranks and freshness but leaves the pre-network reservation intact', async () => {
    await reset(); await commit(await acquire(), payload()); const before = await get(); const marker = await setting('last_ranked_sync_time');
    const run = await acquire(); await reserve(run); const attempt = await setting('last_ranked_attempt_time');
    const body = payload([member('#AA', { ...profile, rankedElo: 5000 })], { ranked_attempted: true,
      brawlers: [{ player_tag: '#AA', brawler_id: 1, brawler_name: 'X'.repeat(100), power_level: 1, trophies: 0, rank: 1, gadgets_count: 0, star_powers_count: 0, gears_count: 0 }] });
    await assert.rejects(commit(run, body), /value too long/); assert.deepEqual(await get(), before);
    assert.equal(await setting('last_ranked_sync_time'), marker); assert.equal(await setting('last_ranked_attempt_time'), attempt);
    assert.equal((await db.query('SELECT count(*)::int n FROM sync_ranked_fallback_attempts')).rows[0].n, 1);
    assert.equal((await db.query('SELECT status FROM sync_runs WHERE id=$1', [run.run_id])).rows[0].status, 'running');
    body.brawlers = []; await commit(run, body); assert.equal((await get()).ranked_points, 5000);
    assert.equal(await setting('last_ranked_attempt_time'), attempt, 'new payload must not move the attempt marker to commit time');
  });
  await t.test('legacy payloads keep old rank semantics and cannot erase the new metadata', async () => {
    await reset(); await commit(await acquire(), payload()); const old = await get();
    const legacy = member(); for (const key of Object.keys(legacy)) if (key.startsWith('rank')) delete legacy[key];
    legacy.rank_current = 'Unranked'; legacy.rank_highest = 'Unranked'; legacy.rank_available = false;
    await commit(await acquire(), payload([legacy], { ranked_complete: false })); const row = await get();
    assert.equal(row.rank_current, old.rank_current); assert.equal(row.rank_highest, old.rank_highest); assert.equal(row.ranked_points, old.ranked_points);
    assert.deepEqual(row.ranked_provenance, old.ranked_provenance);
  });
  await t.test('private fallback reservations and mutation RPCs are denied to public roles', async () => {
    await reset(); const run = await acquire();
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      try {
        await assert.rejects(reserve(run), error => error.code === '42501');
        await assert.rejects(db.query('SELECT * FROM sync_ranked_fallback_attempts'), error => error.code === '42501');
        await assert.rejects(db.query("INSERT INTO sync_ranked_fallback_attempts VALUES('#CLUB','#AA',now())"), error => error.code === '42501');
        await assert.rejects(db.query('SELECT owner_user_id FROM members'), error => error.code === '42501');
      } finally { await db.query('RESET ROLE'); }
    }
    await db.query('SET ROLE service_role');
    try {
      assert.deepEqual(await reserve(run), ['#AA']);
      assert.equal((await db.query('SELECT count(*)::int n FROM sync_ranked_fallback_attempts')).rows[0].n, 1);
      await assert.rejects(db.query("INSERT INTO sync_ranked_fallback_attempts VALUES('#CLUB','#BB',now())"), error => error.code === '42501');
      const result = await commit(run, payload()); assert.equal(result.success, true);
    } finally { await db.query('RESET ROLE'); }
  });
});
