const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const source = process.env.SYNC_TEST_DATABASE_URL || process.env.SECURITY_TEST_DATABASE_URL;
const root = path.resolve(__dirname, '../..');

test('accepted sync respects administrative alert exemptions without changing recorded activity', { skip: !source }, async t => {
  const target = new URL(source);
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.match(target.pathname, /^\/brawl_[a-z_]+_tests$/); assert.equal(target.search, ''); assert.equal(target.hash, '');
  const loopback = db => assert.ok(['127.0.0.1', '::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/i, '')));
  target.pathname = '/postgres'; const admin = new Client({ connectionString: target.href }); await admin.connect();
  try {
    loopback(admin);
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_inactivity_tests'")).rowCount)
      await admin.query("CREATE DATABASE brawl_inactivity_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
  } finally { await admin.end(); }
  target.pathname = '/brawl_inactivity_tests'; const db = new Client({ connectionString: target.href }); await db.connect(); t.after(() => db.end()); loopback(db);
  assert.equal((await db.query('SELECT current_database() name')).rows[0].name, 'brawl_inactivity_tests');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  await db.query('ALTER TABLE members ADD COLUMN owner_user_id uuid');
  let beforeDefinition;
  for (const file of fs.readdirSync(path.join(root, 'supabase/migrations')).filter(name => /^20260916\d{4}_.*\.sql$/.test(name) && name < '202609160035_').sort()) {
    if (file.startsWith('202609160034_')) beforeDefinition = (await db.query("SELECT pg_get_functiondef('public.commit_sync_snapshot(uuid,bigint,jsonb)'::regprocedure) value")).rows[0].value;
    await db.query(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'));
  }

  const tags = ['#ABS', '#NEW', '#FIRST', '#EXP', '#OLD', '#CAN', '#ELSE', '#REC'];
  const members = tags.map(player_tag => ({ player_tag, player_name: player_tag.slice(1), role: 'member', trophies: 100, highest_trophies: 100,
    exp_level: 1, brawlers_count: 0, solo_victories: 0, duo_victories: 0, trio_victories: 0 }));
  const body = { members, brawlers: [], battles: [], club_snapshot: { metadata: { name: 'Club' },
    members: members.map(row => ({ tag: row.player_tag, name: row.player_name, role: row.role, trophies: row.trophies })) } };
  const run = async (scope = 'full') => {
    const lease = (await db.query('SELECT acquire_sync_run($1,$2,$3,$4,$5) result', ['#CLUB', 'cron', scope, scope === 'member' ? '#ABS' : null, null])).rows[0].result;
    assert.equal(lease.acquired, true);
    const payload = scope === 'member' ? { ...body, members: [members[0]] } : body;
    const result = (await db.query(`SELECT ${scope === 'roster' ? 'commit_roster_snapshot' : 'commit_sync_snapshot'}($1,$2,$3) result`, [lease.run_id, lease.fence, payload])).rows[0].result;
    assert.equal(result.success, true); return result;
  };
  const inactiveAlerts = async () => (await db.query("SELECT payload FROM notification_outbox WHERE event_key LIKE 'inactive:#CLUB:%' ORDER BY created_at")).rows;
  const declare = async (tag, startHours, endHours) => (await db.query('SELECT declare_member_absence($1,now()+make_interval(hours=>$2),now()+make_interval(hours=>$3),$4,$5) id',
    [tag, startHours, endHours, 'PRIVATE ABSENCE REASON', randomUUID()])).rows[0].id;

  await t.test('migration changes only the inactive recipient selection and keeps service-only commit permissions', async () => {
    const after = (await db.query("SELECT pg_get_functiondef('public.commit_sync_snapshot(uuid,bigint,jsonb)'::regprocedure) value")).rows[0].value;
    assert.ok(beforeDefinition);
    assert.equal(after.replace('AND NOT public.member_inactivity_exempt(v_run.club_tag,player_tag,v_now);', ';').replace('NOT is_active ;', 'NOT is_active;'), beforeDefinition);
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      try { await assert.rejects(db.query("SELECT commit_sync_snapshot(NULL,NULL,'{}')"), error => error.code === '42501'); }
      finally { await db.query('RESET ROLE'); }
    }
  });

  let activeAbsence;
  await t.test('actual full outbox excludes active absences and recorded join grace, while all activity stays inactive', async () => {
    await db.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('notifications_enabled','true'),('inactivity_threshold','48'); INSERT INTO club_administration_settings(club_tag,grace_hours) VALUES('#CLUB',48)");
    for (const row of members) {
      await db.query("INSERT INTO members(player_tag,player_name,role,trophies,highest_trophies,is_active,last_updated) VALUES($1,$2,'member',100,100,false,now()-interval '5 days');", [row.player_tag, row.player_name]);
      await db.query("INSERT INTO member_history(player_tag,player_name,is_current_member,first_seen,last_seen) VALUES($1,$2,true,now()-interval '60 days',now()-interval '1 hour')", [row.player_tag, row.player_name]);
      await db.query("INSERT INTO member_activity_state VALUES($1,now()-interval '5 days',now()-interval '5 days')", [row.player_tag]);
      await db.query("INSERT INTO daily_stats(player_tag,date,battles,wins,losses,star_player,trophies_gained,trophies_lost) VALUES($1,current_date-5,4,3,1,0,0,0)", [row.player_tag]);
      const recent = ['#NEW', '#FIRST', '#REC'].includes(row.player_tag);
      await db.query("INSERT INTO membership_change_events(club_tag,player_tag,player_name,event_type,source,occurred_at,trigger_source,actor) VALUES('#CLUB',$1,$2,$3,$4,now()-make_interval(hours=>$5),'cron','system')", [row.player_tag, row.player_name, row.player_tag === '#FIRST' ? 'initial_seen' : 'join', row.player_tag === '#REC' ? 'reconstructed' : 'recorded', recent ? 1 : 1440]);
    }
    activeAbsence = await declare('#ABS', -24, 24);
    await declare('#EXP', -48, -24);
    const cancelled = await declare('#CAN', -24, 24); await db.query('SELECT cancel_member_absence($1)', [cancelled]);
    await db.query("INSERT INTO member_absences(club_tag,player_tag,starts_at,ends_at,reason,request_id) VALUES('#OTHER','#ELSE',now()-interval '1 day',now()+interval '1 day','PRIVATE ELSEWHERE',$1)", [randomUUID()]);
    const before = (await db.query('SELECT * FROM member_activity_state ORDER BY player_tag')).rows;
    await run();
    const alerts = await inactiveAlerts(); assert.equal(alerts.length, 1);
    const embed = alerts[0].payload.embeds[0]; assert.equal(embed.title, '5 Inactive Member(s)');
    for (const tag of ['#EXP', '#OLD', '#CAN', '#ELSE', '#REC']) assert.ok(embed.description.includes(`(${tag})`));
    for (const tag of ['#ABS', '#NEW', '#FIRST']) assert.ok(!embed.description.includes(`(${tag})`));
    assert.doesNotMatch(JSON.stringify(alerts), /PRIVATE|absence|excused/i);
    const stored = (await db.query('SELECT player_tag,is_active FROM members ORDER BY player_tag')).rows;
    assert.equal(stored.length, tags.length); assert.ok(stored.every(row => row.is_active === false));
    assert.deepEqual((await db.query('SELECT * FROM member_activity_state ORDER BY player_tag')).rows, before);
    assert.ok((await db.query('SELECT total_battles,total_wins FROM player_tracking')).rows.every(row => row.total_battles === 4 && row.total_wins === 3));
    assert.equal((await db.query("SELECT count(*)::int n FROM notifications WHERE type='inactive'")).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int n FROM club_roster_snapshots')).rows[0].n, 1);
  });

  await t.test('same-day full and single-member refreshes do not bypass existing alert deduplication', async () => {
    await run(); await run('member'); await run('roster');
    assert.equal((await inactiveAlerts()).length, 1);
  });

  await t.test('an expired absence is included again on the next eligible alert without changing inactivity evidence', async () => {
    await db.query("UPDATE member_absences SET ends_at=now()-interval '1 minute' WHERE id=$1", [activeAbsence]);
    await db.query("UPDATE notification_outbox SET created_at=now()-interval '25 hours' WHERE event_key LIKE 'inactive:#CLUB:%'");
    await run();
    const alerts = await inactiveAlerts(); assert.equal(alerts.length, 2);
    const latest = alerts.at(-1).payload.embeds[0]; assert.equal(latest.title, '6 Inactive Member(s)'); assert.ok(latest.description.includes('(#ABS)'));
    assert.ok(!latest.description.includes('(#NEW)')); assert.ok(!latest.description.includes('(#FIRST)'));
    assert.ok((await db.query('SELECT is_active FROM members')).rows.every(row => row.is_active === false));
  });

  await t.test('notifications disabled prevents all new alert rows even when exemptions expire', async () => {
    await db.query("UPDATE settings SET value='false' WHERE key='notifications_enabled'; UPDATE notification_outbox SET created_at=now()-interval '25 hours' WHERE event_key LIKE 'inactive:#CLUB:%'");
    const before = await inactiveAlerts(); await run(); assert.equal((await inactiveAlerts()).length, before.length);
  });
});
