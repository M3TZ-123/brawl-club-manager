const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { randomUUID } = require('node:crypto');
const source = process.env.SECURITY_TEST_DATABASE_URL || process.env.SYNC_TEST_DATABASE_URL;
const root = path.resolve(__dirname, '../..');
const now = '2026-09-17T12:00:00.000Z';

test('private club event observations use saved evidence without mutating attendance or counters', { skip: !source }, async t => {
  const url = new URL(source);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/brawl_(security|sync|event_observations)_tests$/); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const local = db => assert.ok(['127.0.0.1', '::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/, '')));
  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.href }); await admin.connect(); local(admin);
  try {
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_event_observations_tests'")).rowCount) {
      await admin.query("CREATE DATABASE brawl_event_observations_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
    }
  } finally { await admin.end(); }
  url.pathname = '/brawl_event_observations_tests';
  const db = new Client({ connectionString: url.href }); await db.connect(); local(db); t.after(() => db.end());
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  for (const file of fs.readdirSync(path.join(root, 'supabase/migrations')).filter(name => /^20260916\d{4}_.*\.sql$/.test(name)).sort()) {
    await db.query(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'));
  }
  await db.query(`
    INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('last_roster_sync_time','${now}'),('last_sync_time','2026-09-17T11:30:00Z'),
      ('last_full_sync_time','2026-09-17T11:30:00Z'),('last_battle_sync_time','2026-09-17T11:30:00Z'),('api_key','PRIVATE KEY')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    INSERT INTO members(player_tag,player_name,trophies) VALUES('#PYLQ','عضو',1000),('#PYLR','Second',2000),('#PYLC','Unassigned',3000);
    INSERT INTO member_history(player_tag,player_name,is_current_member,notes) VALUES('#PYLQ','عضو',true,'PRIVATE NOTE'),('#PYLR','Second',true,'PRIVATE NOTE');
    INSERT INTO sync_runs(id,club_tag,source,scope,fence,status) VALUES('00000000-0000-4000-8000-000000000037','#CLUB','cron','full',1,'succeeded');
    INSERT INTO sync_battle_coverage(club_tag,player_tag,baseline_started_at,last_observed_at,last_attempt_at,last_observation_status,last_run_id)
      VALUES('#CLUB','#PYLQ','2026-09-16T00:00:00Z','${now}','${now}','observed','00000000-0000-4000-8000-000000000037');
    INSERT INTO sync_battle_gaps(club_tag,player_tag,run_id,detected_at,gap_start_at,gap_end_at,previous_observed_at,window_size,scope)
      VALUES('#CLUB','#PYLQ','00000000-0000-4000-8000-000000000037','2026-09-16T04:00:00Z','2026-09-16T01:00:00Z','2026-09-16T02:00:00Z','2026-09-16T00:00:00Z',25,'full');
  `);
  const makeEvent = async ({ club = '#CLUB', kind = 'mega_pig', start = '2026-09-15T00:00:00Z', end = '2026-09-19T00:00:00Z', status = 'planned', tags = ['#PYLQ', '#PYLR'] } = {}) => {
    const id = randomUUID();
    await db.query("INSERT INTO club_planned_events(id,club_tag,title,kind,cycle_label,starts_at,ends_at,team_size,status,version,notes) VALUES($1,$2,'Club event',$3,'Cycle',$4,$5,3,$6,2,'PRIVATE EVENT')", [id, club, kind, start, end, status]);
    for (const tag of tags) await db.query("INSERT INTO club_event_entries(event_id,player_tag,player_name,team,slot,attendance,wins,tickets_remaining,observed_at,notes) VALUES($1,$2,$2,1,'starter','present',5,2,$3,'PRIVATE ENTRY')", [id, tag, start]);
    return id;
  };
  const eventId = await makeEvent();
  const putBattle = async (at, type, tag = '#PYLQ') => db.query("INSERT INTO battle_history(player_tag,battle_time,mode,map,result,trophy_change,battle_type,event_id,event_mode_id) VALUES($1,$2,'gemGrab','Mega Pig','victory',0,$3,15000005,0) ON CONFLICT(player_tag,battle_time) DO UPDATE SET battle_type=excluded.battle_type", [tag, at, type]);
  await putBattle('2026-09-14T23:59:59Z', 'megaPig');
  await putBattle('2026-09-15T00:00:00Z', 'megaPig');
  await putBattle('2026-09-15T01:00:00Z', 'casual');
  await putBattle('2026-09-15T02:00:00Z', 'clubLeague');
  await putBattle('2026-09-16T00:00:00Z', 'challenge');
  await putBattle('2026-09-16T01:00:00Z', 'friendly');
  await putBattle('2026-09-16T02:00:00Z', 'mega_pig');
  await putBattle('2026-09-16T03:00:00Z', null);
  await putBattle('2026-09-17T11:59:59Z', ' MegaPig ');
  await putBattle(now, 'megaPig');
  await putBattle('2026-09-17T12:00:01Z', 'megaPig');
  await putBattle('2026-09-16T03:00:00Z', 'megaPig', '#PYLC');
  const read = async (id = eventId, at = now, club = '#CLUB') => (await db.query('SELECT public.club_event_observations_read($1,$2,$3) value', [club, id, at])).rows[0].value;
  const setting = (key, value) => db.query('UPDATE settings SET value=$2 WHERE key=$1', [key, value]);

  await t.test('only assigned saved player battles inside half-open event/now boundaries count; explicit marker has no heuristics', async () => {
    const result = await read(), member = result.members[0];
    assert.equal(result.eventVersion, 2); assert.equal(result.historyLimited, true); assert.equal(result.members.length, 2);
    assert.equal(result.classification, 'explicit_battle_type_only'); assert.equal(member.observedBattles, 8);
    assert.equal(member.explicitMegaPigBattles, 2, 'Map, event ID, trophy zero, casual, clubLeague and mega_pig do not identify Mega Pig');
    assert.equal(Date.parse(member.lastObservedBattleAt), Date.parse('2026-09-17T11:59:59Z'));
    assert.equal(Date.parse(member.lastExplicitMegaPigBattleAt), Date.parse('2026-09-17T11:59:59Z'));
    assert.equal(member.authoritativeWins, null); assert.equal(member.ticketsRemaining, null);
    assert.equal(member.coverage.possibleGap, true); assert.equal(result.members[1].coverage.status, 'unknown');
    assert.equal(result.members[1].observedBattles, 0); assert.equal(result.members[1].lastObservedBattleAt, null);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|attendance|revisions|owner_user_id/);
    await putBattle('2026-09-15T00:00:00Z', 'megaPig'); assert.equal((await read()).members[0].observedBattles, 8, 'Replay never doubles an existing player/time observation');
  });
  await t.test('read succeeds in a read-only transaction and leaves manual attendance/counters unchanged', async () => {
    const before = (await db.query('SELECT to_jsonb(e) value FROM club_event_entries e WHERE event_id=$1 ORDER BY player_tag', [eventId])).rows;
    await db.query('BEGIN READ ONLY');
    try { await db.query('SET LOCAL ROLE service_role'); const result = await read(); assert.equal(result.members[0].authoritativeWins, null); }
    finally { await db.query('ROLLBACK'); }
    const after = (await db.query('SELECT to_jsonb(e) value FROM club_event_entries e WHERE event_id=$1 ORDER BY player_tag', [eventId])).rows;
    assert.deepEqual(after, before); assert.equal(after[0].value.wins, 5); assert.equal(after[0].value.tickets_remaining, 2);
  });
  await t.test('future, ended and cancelled event windows retain honest lifecycle state', async () => {
    const upcoming = await makeEvent({ start: '2026-09-18T00:00:00Z', end: '2026-09-19T00:00:00Z' });
    assert.equal((await read(upcoming)).hasStarted, false); assert.equal((await read(upcoming)).members[0].observedBattles, 0);
    const ended = await makeEvent({ end: '2026-09-16T00:00:00Z', status: 'completed' });
    const result = await read(ended); assert.equal(result.status, 'completed'); assert.equal(result.members[0].observedBattles, 3);
    assert.equal(result.members[0].explicitMegaPigBattles, 1, 'The exact event end is excluded');
    const cancelled = await makeEvent({ status: 'cancelled' }); assert.equal((await read(cancelled)).status, 'cancelled');
  });
  await t.test('another club, wrong kind and missing event share not-found handling; unaccepted club cannot read', async () => {
    for (const id of [await makeEvent({ club: '#OTHER' }), await makeEvent({ kind: 'custom' }), randomUUID()]) {
      await assert.rejects(read(id), error => error.code === 'P0002');
    }
    await assert.rejects(read(eventId, now, '#OTHER'), error => error.code === '40001');
    await setting('last_roster_sync_time', ''); await setting('last_sync_time', ''); await setting('last_full_sync_time', '');
    await assert.rejects(read(), error => error.code === '40001');
    await setting('last_roster_sync_time', now); await setting('last_sync_time', '2026-09-17T11:30:00Z'); await setting('last_full_sync_time', '2026-09-17T11:30:00Z');
  });
  await t.test('battle freshness never falls back to the roster marker and malformed/future markers stay unknown', async () => {
    await setting('last_battle_sync_time', ''); let result = await read();
    assert.equal(result.sync.stale, true); assert.equal(result.sync.lastBattleSyncAt, null); assert.ok(result.sync.lastFullSyncAt);
    for (const value of ['bad timestamp', 'infinity', '2099-01-01T00:00:00Z']) {
      await setting('last_battle_sync_time', value); result = await read(); assert.equal(result.sync.lastBattleSyncAt, null); assert.equal(result.sync.stale, true);
    }
    await setting('last_battle_sync_time', '2026-09-17T11:25:00Z'); assert.equal((await read()).sync.stale, false);
    await setting('last_battle_sync_time', '2026-09-17T11:24:59Z'); assert.equal((await read()).sync.stale, true);
  });
  await t.test('input and member bounds fail closed', async () => {
    for (const [club, id, at] of [['bad', eventId, now], ['#CLUB', null, now], ['#CLUB', eventId, 'infinity']]) {
      await assert.rejects(db.query('SELECT public.club_event_observations_read($1,$2,$3)', [club, id, at]), error => error.code === '22023');
    }
    const tooMany = await makeEvent({ tags: Array.from({ length: 31 }, (_, i) => `#PLAYER${i}`) });
    await assert.rejects(read(tooMany), error => error.code === '54000');
  });
  await t.test('private execution ACL and stable fixed search path survive permissive default privileges', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.query('BEGIN');
      try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(read(), error => error.code === '42501'); }
      finally { await db.query('ROLLBACK'); }
    }
    const fn = (await db.query("SELECT provolatile,prosecdef,proconfig,has_function_privilege('service_role',oid,'EXECUTE') allowed FROM pg_proc WHERE oid='public.club_event_observations_read(text,uuid,timestamptz)'::regprocedure")).rows[0];
    assert.equal(fn.provolatile, 's'); assert.equal(fn.prosecdef, true); assert.equal(fn.allowed, true);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog')); assert.ok(fn.proconfig.includes('statement_timeout=5s'));
  });
});
