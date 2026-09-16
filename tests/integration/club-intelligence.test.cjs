const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');
const { buildClubIntelligence } = loadTypeScript('src/lib/club-intelligence.ts');
const source = process.env.SYNC_TEST_DATABASE_URL || process.env.SECURITY_TEST_DATABASE_URL;
const root = path.resolve(__dirname, '../..');

test('club intelligence captures only accepted complete rosters and protects prospective history', { skip: !source }, async t => {
  const target = new URL(source);
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.match(target.pathname, /^\/brawl_[a-z_]+_tests$/); assert.equal(target.search, ''); assert.equal(target.hash, '');
  const loopback = db => assert.ok(['127.0.0.1', '::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/i, '')));
  target.pathname = '/postgres'; const admin = new Client({ connectionString: target.href }); await admin.connect();
  try { loopback(admin); if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_intelligence_tests'")).rowCount)
    await admin.query("CREATE DATABASE brawl_intelligence_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
  } finally { await admin.end(); }
  target.pathname = '/brawl_intelligence_tests'; const db = new Client({ connectionString: target.href }); await db.connect(); t.after(() => db.end()); loopback(db);
  assert.equal((await db.query('SELECT current_database() name')).rows[0].name, 'brawl_intelligence_tests');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  await db.query('ALTER TABLE members ADD COLUMN owner_user_id uuid');
  for (const file of fs.readdirSync(path.join(root, 'supabase/migrations')).filter(name => /^20260916\d{4}_.*\.sql$/.test(name) && name < '202609160030_').sort())
    await db.query(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'));
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/202609160029_club_intelligence.sql'), 'utf8');
  await db.query(migration);
  const member = (tag = '#AA', trophies = 100) => ({ player_tag: tag, player_name: 'لاعب', role: 'member', trophies, highest_trophies: trophies,
    exp_level: 1, brawlers_count: 0, solo_victories: 0, duo_victories: 0, trio_victories: 0 });
  const snapshot = (members, metadata = {}) => ({ metadata: { name: 'النادي', description: 'Hello', type: 'open', badgeId: 1, requiredTrophies: 1000, ...metadata },
    members: members.map(row => ({ tag: row.player_tag, name: row.player_name, role: row.role, trophies: row.trophies })) });
  const payload = (members = [member()], metadata = {}) => ({ members, brawlers: [], battles: [], club_snapshot: snapshot(members, metadata) });
  const acquire = async (scope = 'full', key = null) => (await db.query('SELECT acquire_sync_run($1,$2,$3,$4,$5) result', ['#CLUB', 'manual', scope, scope === 'member' ? '#AA' : null, key])).rows[0].result;
  const commit = async (run, body, scope = 'full') => (await db.query(`SELECT ${scope === 'roster' ? 'commit_roster_snapshot' : 'commit_sync_snapshot'}($1,$2,$3) result`, [run.run_id, run.fence, body])).rows[0].result;
  const save = async (body = payload(), scope = 'full') => commit(await acquire(scope), body, scope);
  const count = async table => (await db.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0].n;
  const reset = async () => {
    await db.query('TRUNCATE members,member_history,activity_log,club_events,battle_history,daily_stats,player_tracking,brawler_snapshots,notifications,sync_runs,sync_leases,membership_change_events,notification_outbox,member_activity_state,player_brawler_state,sync_battle_coverage,sync_battle_gaps,sync_ranked_fallback_attempts,club_profiles,club_profile_events,club_roster_snapshots,settings RESTART IDENTITY CASCADE');
    await db.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('notifications_enabled','false')");
  };
  await t.test('migration creates no historical observations and old clients continue without a baseline', async () => {
    assert.equal(await count('club_roster_snapshots'), 0); await reset(); const body = payload(); delete body.club_snapshot;
    assert.equal((await save(body)).success, true); assert.equal(await count('club_profiles'), 0); assert.equal(await count('club_roster_snapshots'), 0);
  });
  await t.test('full and roster acceptance retain first and latest daily endpoints; replay has no extra history', async () => {
    await reset(); const run = await acquire('full', 'intelligence-replay'); await commit(run, payload());
    const first = (await db.query('SELECT * FROM club_roster_snapshots')).rows[0];
    await save(payload([member('#AA', 150), member('#BB', 200)], { description: '' }), 'roster');
    const current = (await db.query('SELECT * FROM club_roster_snapshots')).rows[0];
    assert.equal(await count('club_roster_snapshots'), 1); assert.deepEqual(current.first_members, first.first_members);
    assert.equal(current.last_members.length, 2); assert.equal(current.last_members[0].trophies, 150);
    assert.equal(current.first_run_id, first.first_run_id); assert.notEqual(current.last_run_id, first.last_run_id);
    const rows = await count('club_profile_events'); await commit(run, payload());
    assert.equal(await count('club_profile_events'), rows); assert.deepEqual((await db.query('SELECT * FROM club_roster_snapshots')).rows[0], current);
  });
  await t.test('thirty-member capture shares the existing lease and stays one bounded row per UTC day', async () => {
    await reset(); const members = Array.from({ length: 30 }, (_, i) => member(`#P${String(i).padStart(2, '0')}`, 25000 + i));
    const first = await acquire('roster'); const overlapping = await acquire('roster');
    assert.equal(overlapping.acquired, false); assert.equal(await count('club_roster_snapshots'), 0);
    const started = performance.now(); await commit(first, payload(members), 'roster');
    t.diagnostic(`Local 30-member roster with intelligence capture: ${Math.round(performance.now() - started)}ms`);
    await save(payload(members.map(row => ({ ...row, trophies: row.trophies + 1 }))), 'roster');
    assert.equal(await count('club_roster_snapshots'), 1);
    const row = (await db.query('SELECT jsonb_array_length(first_members) n,pg_column_size(first_members)+pg_column_size(last_members) bytes FROM club_roster_snapshots')).rows[0];
    assert.equal(row.n, 30); assert.ok(row.bytes < 65536);
    const result = buildClubIntelligence((await db.query('SELECT club_intelligence_read(90,now()) result')).rows[0].result, '90d');
    assert.equal(result.calendar.rows.length, 30); assert.equal(result.calendar.rows[0].cells.length, 90);
  });
  await t.test('member refresh never replaces complete club endpoints and partial metadata preserves knowledge', async () => {
    await reset(); await save(); const before = (await db.query('SELECT * FROM club_roster_snapshots')).rows[0];
    await save(payload([member('#AA', 500)]), 'member'); assert.deepEqual((await db.query('SELECT * FROM club_roster_snapshots')).rows[0], before);
    const partial = payload(); partial.club_snapshot.metadata = { name: 'New name', description: 42, requiredTrophies: null, secret: 'hidden' };
    partial.club_snapshot.members[0].owner_user_id = 'private';
    await save(partial); const profile = (await db.query('SELECT metadata FROM club_profiles')).rows[0].metadata;
    assert.equal(profile.name, 'New name'); assert.equal(profile.description, 'Hello'); assert.equal(profile.requiredTrophies, 1000);
    assert.equal(JSON.stringify((await db.query('SELECT * FROM club_profile_events')).rows).includes('hidden'), false);
    assert.equal(JSON.stringify((await db.query('SELECT * FROM club_roster_snapshots')).rows).includes('owner_user_id'), false);
  });
  await t.test('incomplete optional roster cannot fabricate a complete baseline', async () => {
    await reset(); const body = payload([member('#AA'), member('#BB')]); body.club_snapshot.members.pop();
    assert.equal((await save(body)).success, true); assert.equal(await count('club_roster_snapshots'), 0);
  });
  await t.test('capture failure rolls back member changes and success markers in the same transaction', async () => {
    await reset(); await save(); const before = (await db.query("SELECT value FROM settings WHERE key='last_sync_time'")).rows[0].value;
    await db.query("CREATE FUNCTION fail_club_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER fail_capture BEFORE UPDATE ON club_profiles FOR EACH ROW EXECUTE FUNCTION fail_club_capture()");
    await assert.rejects(save(payload([member('#AA', 900)])), /fixture/);
    assert.equal((await db.query("SELECT trophies FROM members WHERE player_tag='#AA'")).rows[0].trophies, 100);
    assert.equal((await db.query("SELECT value FROM settings WHERE key='last_sync_time'")).rows[0].value, before);
    assert.equal((await db.query('SELECT last_members FROM club_roster_snapshots')).rows[0].last_members[0].trophies, 100);
    await db.query('DROP TRIGGER fail_capture ON club_profiles; DROP FUNCTION fail_club_capture()');
  });
  await t.test('public roles cannot inspect raw objects or invoke capture and service readers remain read-only', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      try {
        await assert.rejects(db.query('SELECT * FROM club_profiles'), e => e.code === '42501');
        await assert.rejects(db.query('SELECT club_intelligence_read()'), e => e.code === '42501');
        await assert.rejects(db.query("SELECT capture_club_intelligence(NULL,'{}',now())"), e => e.code === '42501');
      } finally { await db.query('RESET ROLE'); }
    }
    await db.query('SET ROLE service_role');
    try { assert.ok((await db.query('SELECT club_intelligence_read() result')).rows[0].result); await assert.rejects(db.query("UPDATE club_profile_events SET changed_fields='{}'"), e => e.code === '42501'); }
    finally { await db.query('RESET ROLE'); }
  });
  await t.test('read model isolates club history and preserves null before genuine monitoring', async () => {
    await reset(); await save();
    await db.query("INSERT INTO club_profiles VALUES('#OTHER','{\"name\":\"Other private club\"}',now(),now())");
    const body = (await db.query('SELECT club_intelligence_read(7,now()) result')).rows[0].result;
    const result = buildClubIntelligence(body, '7d');
    assert.equal(result.growth.status, 'insufficient_history'); assert.equal(result.growth.totalChange, null);
    assert.equal(result.calendar.rows[0].cells[0].battles, null); assert.equal(result.calendar.rows[0].cells[0].coverage, 'before_tracking');
    assert.equal(result.club.memberCount, 1); assert.equal(result.club.metadata.name, 'النادي');
    assert.equal(JSON.stringify(result).includes('Other private club'), false);
  });
  await t.test('maintenance bounds daily roster history and preserves immutable metadata history', async () => {
    await reset(); await save();
    await db.query("INSERT INTO club_roster_snapshots SELECT club_tag,current_date-93,now()-interval '93 days',now()-interval '93 days',first_members,last_members,first_run_id,last_run_id FROM club_roster_snapshots");
    assert.equal(await count('club_roster_snapshots'), 2); await db.query('SELECT run_sync_maintenance()');
    assert.equal(await count('club_roster_snapshots'), 1); assert.equal(await count('club_profile_events'), 1);
  });
  await t.test('a changed club cannot relabel the old global roster before its first accepted sync', async () => {
    await reset(); await save();
    await db.query("UPDATE settings SET value='#OTHER' WHERE key='club_tag'; UPDATE settings SET value='' WHERE key IN('last_sync_time','last_roster_sync_time')");
    const result = buildClubIntelligence((await db.query('SELECT club_intelligence_read(7,now()) result')).rows[0].result, '7d');
    assert.equal(result.club.tag, '#OTHER'); assert.equal(result.club.metadata, null);
    assert.equal(result.club.memberCount, 0); assert.equal(result.calendar.rows.length, 0); assert.equal(result.strength.members, 0);
    assert.equal(result.growth.availableFrom, null); assert.equal(result.retention.spells.length, 0);
    assert.equal(await count('members'), 1);
  });
});
