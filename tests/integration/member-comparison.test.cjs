const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { randomUUID } = require('node:crypto');
const source = process.env.SECURITY_TEST_DATABASE_URL;
const root = path.resolve(__dirname, '../..');
const now = '2026-09-17T12:00:00.000Z';

test('private member comparison reads coherent bounded evidence without inventing missing activity', { skip: !source }, async t => {
  const url = new URL(source);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/brawl_security_tests');
  assert.equal(url.search, '');
  const local = db => assert.ok(['127.0.0.1', '::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/, '')));
  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.href }); await admin.connect(); local(admin);
  try {
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_member_comparison_tests'")).rowCount) {
      await admin.query("CREATE DATABASE brawl_member_comparison_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
    }
  } finally { await admin.end(); }
  url.pathname = '/brawl_member_comparison_tests';
  const db = new Client({ connectionString: url.href }); await db.connect(); local(db); t.after(() => db.end());
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  for (const file of fs.readdirSync(path.join(root, 'supabase/migrations')).filter(name => /^20260916\d{4}_.*\.sql$/.test(name)).sort()) {
    await db.query(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'));
  }
  await db.query(`
    ALTER TABLE members ADD COLUMN owner_user_id text DEFAULT 'PRIVATE OWNER';
    INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('last_roster_sync_time','${now}'),('last_sync_time','2026-09-17T11:30:00Z'),('api_key','PRIVATE KEY') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    INSERT INTO members(player_tag,player_name,role,trophies,brawlers_count,last_updated,rank_current,ranked_points,ranked_season_id,ranked_provenance)
      VALUES('#PYLQ','عضو','member',30000,2,'${now}','Diamond I',3000,48,'{"ranked_points":{"source":"profile","checked_at":"2026-09-17T11:30:00Z"}}'),
      ('#PYLR','Second','vicePresident',25000,1,'${now}',NULL,NULL,NULL,NULL);
    INSERT INTO member_history(player_tag,player_name,is_current_member,notes) VALUES('#PYLQ','عضو',true,'PRIVATE OLD NOTE'),('#PYLR','Second',true,'PRIVATE NOTE');
    INSERT INTO member_reviews(player_tag,notes) VALUES('#PYLQ','PRIVATE REVIEW');
    INSERT INTO club_administration_settings(club_tag,grace_hours) VALUES('#CLUB',48);
    INSERT INTO membership_change_events(club_tag,player_tag,player_name,event_type,source,occurred_at,trigger_source,actor)
      VALUES('#CLUB','#PYLQ','عضو','join','recorded','2026-07-01T00:00:00Z','fixture','unknown'),
      ('#CLUB','#PYLR','Second','join','reconstructed','2026-08-01T00:00:00Z','fixture','unknown');
    INSERT INTO member_activity_state(player_tag,last_activity_at,last_battle_at) VALUES('#PYLQ','2026-09-15T01:00:00Z','2026-09-15T01:00:00Z');
    INSERT INTO player_profile_details(player_tag,observed_at) VALUES('#PYLQ','2026-09-17T11:30:00Z');
    INSERT INTO player_brawler_details(player_tag,brawler_id,brawler_name,power_level,trophies,observed_at)
      VALUES('#PYLQ',1,'BRAWLER A',11,100,'2026-09-01T00:00:00Z'),('#PYLQ',2,'BRAWLER B',9,200,'2026-09-01T00:00:00Z');
    INSERT INTO daily_stats(player_tag,date,battles,wins,losses) VALUES('#PYLQ','2026-09-15',3,2,1),('#PYLQ','2026-09-16',0,0,0),('#PYLQ','2026-09-17',99,99,0);
    INSERT INTO sync_runs(id,club_tag,source,scope,fence,status) VALUES('00000000-0000-4000-8000-000000000036','#CLUB','cron','full',1,'succeeded');
    INSERT INTO sync_battle_coverage(club_tag,player_tag,baseline_started_at,last_observed_at,last_attempt_at,last_observation_status,last_run_id)
      VALUES('#CLUB','#PYLQ','2026-07-01T00:00:00Z','${now}','${now}','observed','00000000-0000-4000-8000-000000000036');
    INSERT INTO sync_battle_gaps(club_tag,player_tag,run_id,detected_at,gap_start_at,gap_end_at,previous_observed_at,window_size,scope)
      VALUES('#CLUB','#PYLQ','00000000-0000-4000-8000-000000000036','2026-09-15T04:00:00Z','2026-09-15T01:00:00Z','2026-09-15T02:00:00Z','2026-09-15T00:00:00Z',25,'full');
    INSERT INTO member_absences(club_tag,player_tag,starts_at,ends_at,cancelled_at,reason,request_id)
      VALUES('#CLUB','#PYLQ','2026-09-12T00:00:00Z','2026-09-16T00:00:00Z','2026-09-14T00:00:00Z','PRIVATE REASON',gen_random_uuid()),
      ('#CLUB','#PYLR','2026-09-17T00:00:00Z','2026-09-19T00:00:00Z',NULL,'PRIVATE REASON',gen_random_uuid());
    INSERT INTO recruitment_candidates(player_tag,status,notes,profile,profile_checked_at) VALUES
      ('#PYLC','shortlisted','PRIVATE CANDIDATE','{"name":"Candidate","trophies":32000,"power11":3,"rank":"Mythic I","rankedPoints":4500,"secret":"PRIVATE PROFILE"}','2026-09-17T11:00:00Z'),
      ('#PYLQ','watching','CURRENT MEMBER',NULL,NULL),('#PYLV','archived','ARCHIVED',NULL,NULL),('#PYLJ','watching','NO PROFILE',NULL,'2026-09-17T11:00:00Z');
  `);
  const event = async ({ club = '#CLUB', tag = '#PYLQ', attendance = 'present', ends = '2026-09-16T08:00:00Z', status = 'completed', observed = '2026-09-16T07:30:00Z' } = {}) => {
    const id = randomUUID();
    await db.query("INSERT INTO club_planned_events(id,club_tag,title,kind,cycle_label,starts_at,ends_at,team_size,status,notes) VALUES($1,$2,'Private title','custom','Cycle',$3::timestamptz-interval '1 hour',$3,3,$4,'PRIVATE EVENT')", [id, club, ends, status]);
    if (tag) await db.query("INSERT INTO club_event_entries(event_id,player_tag,player_name,team,slot,attendance,observed_at,notes) VALUES($1,$2,'Name',1,'starter',$3,$4,'PRIVATE ENTRY')", [id, tag, attendance, observed]);
    return id;
  };
  const attended = await event(); await event({ attendance: 'invited', observed: null }); await event({ tag: null }); await event({ club: '#OTHER' });
  const read = async (days = 7, club = '#CLUB', client = db) => (await client.query('SELECT public.member_comparison_read($1,$2,$3) value', [club, days, now])).rows[0].value;
  const roster = (tags = ['#PYLQ', '#PYLR']) => tags.map(tag => ({ tag, name: 'Observed member', role: 'member', trophies: 30000 }));
  const snapshot = async (first, last = first, firstMembers = roster(), lastMembers = firstMembers, club = '#CLUB') => {
    await db.query(`INSERT INTO club_roster_snapshots(club_tag,snapshot_day,first_observed_at,last_observed_at,first_members,last_members,first_run_id,last_run_id)
      VALUES($1,($2::timestamptz AT TIME ZONE 'UTC')::date,$2,$3,$4,$5,$6,$6)
      ON CONFLICT(club_tag,snapshot_day) DO UPDATE SET first_observed_at=excluded.first_observed_at,last_observed_at=excluded.last_observed_at,
        first_members=excluded.first_members,last_members=excluded.last_members`, [club, first, last, JSON.stringify(firstMembers), JSON.stringify(lastMembers), '00000000-0000-4000-8000-000000000036']);
  };

  await t.test('completed UTC range, explicit zero and missing rows stay distinct; profile counts have real freshness', async () => {
    for (const days of [7, 30, 90]) {
      const result = await read(days), member = result.members[0];
      assert.equal(result.range, `${days}d`); assert.equal(member.days.length, days);
      assert.equal(member.days.at(-1).date, '2026-09-16'); assert.equal(member.days.at(-1).battles, 0);
      assert.equal(member.days.at(-2).battles, 3); assert.equal(member.days.at(-3).battles, null);
      assert.ok(member.days.every(day => day.date < '2026-09-17'));
      assert.equal(member.profile.power11, 1); assert.equal(Date.parse(member.profile.profileCheckedAt), Date.parse('2026-09-17T11:30:00Z'));
      assert.equal(result.members[1].profile.power11, null); assert.equal(result.members[1].profile.profileCheckedAt, null);
      assert.equal(member.days.find(day => day.date === '2026-09-15').possibleGap, true);
      assert.equal(member.days.find(day => day.date === '2026-09-16').possibleGap, false);
    }
  });
  await t.test('only assigned current-club events are returned, and invitations remain unknown attendance', async () => {
    const result = await read();
    assert.equal(result.members[0].events.length, 2); assert.equal(result.members[1].events.length, 0);
    assert.ok(result.members[0].events.some(e => e.id === attended && e.attendance === 'present' && e.title === 'Private title'));
    assert.ok(result.members[0].events.some(e => e.attendance === 'invited' && e.observedAt === null));
    assert.equal(result.members[0].eventsTruncated, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|notes|reason|owner_user_id|refresh_token|api_key|secret/);
  });
  await t.test('effective cancelled absence preserves past excuses, and current absence stays private without its reason', async () => {
    const result = await read(), first = result.members[0], second = result.members[1];
    assert.equal(first.days.find(day => day.date === '2026-09-13').absenceOverlap, true);
    assert.equal(first.days.find(day => day.date === '2026-09-14').absenceOverlap, false);
    assert.equal(first.absence, null); assert.ok(second.absence); assert.equal(second.coverage.trailing48hExcused, true);
    assert.equal(second.spell.source, 'reconstructed'); assert.equal(second.spell.uncertain, true);
    await db.query("INSERT INTO member_absences(club_tag,player_tag,starts_at,ends_at,request_id) VALUES('#CLUB','#PYLQ','2026-09-16T00:00:00Z','2026-09-17T01:00:00Z',gen_random_uuid())");
    assert.equal((await read()).members[0].coverage.trailing48hExcused, true, 'Just-ended absence still excuses part of the48h interval');
  });
  await t.test('candidate data excludes current/archived members, never invents season or timestamp without a profile', async () => {
    const candidates = (await read()).candidates;
    assert.deepEqual(candidates.map(c => c.tag), ['#PYLC', '#PYLJ']);
    assert.equal(candidates[0].profile.rankedSeasonId, null); assert.equal(candidates[0].commitment, 'unknown');
    assert.equal(candidates[1].profile.profileCheckedAt, null); assert.equal(candidates[1].profile.power11, null);
    assert.equal((await read()).members[0].profile.rankedSeasonId, null, 'Unproven season timestamp is not enough for an Elo difference');
    await db.query("UPDATE members SET ranked_provenance=ranked_provenance||'{\"ranked_season_id\":{\"source\":\"profile\",\"checked_at\":\"2026-09-17T11:30:00Z\"}}'::jsonb WHERE player_tag='#PYLQ'");
    assert.equal((await read()).members[0].profile.rankedSeasonId, 48);
    assert.equal((await read()).members[0].profile.rank, null, 'An old rank label must not inherit the fresh points timestamp');
    await db.query("UPDATE members SET ranked_provenance=ranked_provenance||'{\"rank_current\":{\"source\":\"profile\",\"checked_at\":\"2026-09-16T11:30:00Z\"}}'::jsonb WHERE player_tag='#PYLQ'");
    assert.equal((await read()).members[0].profile.rank, null);
    await db.query("UPDATE members SET ranked_provenance=ranked_provenance||'{\"rank_current\":{\"source\":\"profile\",\"checked_at\":\"2026-09-17T11:30:00Z\"}}'::jsonb WHERE player_tag='#PYLQ'");
    assert.equal((await read()).members[0].profile.rank, 'Diamond I');
    await db.query("UPDATE members SET brawlers_count=3 WHERE player_tag='#PYLQ'");
    assert.equal((await read()).members[0].profile.power11, null);
    await db.query("UPDATE members SET brawlers_count=2 WHERE player_tag='#PYLQ'");
  });
  await t.test('a later departure makes a stale current flag uncertain instead of reusing an older join', async () => {
    await db.query('BEGIN');
    try {
      await db.query("INSERT INTO membership_change_events(club_tag,player_tag,player_name,event_type,source,occurred_at,trigger_source,actor) VALUES('#CLUB','#PYLQ','Name','leave','recorded','2026-09-17T10:00:00Z','fixture','unknown')");
      const spell = (await read()).members[0].spell;
      assert.equal(spell.startedAt, null); assert.equal(spell.kind, 'unknown'); assert.equal(spell.uncertain, true);
    } finally { await db.query('ROLLBACK'); }
  });
  await t.test('legacy membership gains a separate real observation anchor without rewriting a reconstructed join', async () => {
    await db.query('BEGIN');
    try {
      await snapshot('2026-09-10T12:34:56Z', '2026-09-10T23:00:00Z');
      await snapshot('2026-09-17T11:50:00Z');
      const [recorded, legacy] = (await read()).members;
      assert.equal(recorded.membershipObservation.source, 'recorded_event');
      assert.equal(Date.parse(recorded.membershipObservation.observedSince), Date.parse('2026-07-01T00:00:00Z'));
      assert.equal(legacy.spell.source, 'reconstructed'); assert.equal(legacy.spell.uncertain, true);
      assert.equal(Date.parse(legacy.spell.startedAt), Date.parse('2026-08-01T00:00:00Z'));
      assert.equal(legacy.membershipObservation.source, 'roster_snapshot');
      assert.equal(Date.parse(legacy.membershipObservation.observedSince), Date.parse('2026-09-10T12:34:56Z'));
      assert.equal(Date.parse(legacy.membershipObservation.checkedAt), Date.parse('2026-09-17T11:50:00Z'));
      assert.equal(Date.parse(legacy.membershipObservation.graceUntil), Date.parse('2026-09-12T12:34:56Z'));
      // Reapplying this read-only migration changes neither facts nor its ACL.
      await db.query('ROLLBACK');
      await db.query(fs.readFileSync(path.join(root, 'supabase/migrations/202609160036_member_comparison.sql'), 'utf8'));
      assert.equal((await read()).members[1].membershipObservation.source, null);
    } finally { await db.query('ROLLBACK'); }
  });
  await t.test('latest membership event and snapshot omission bound the current observed period, including same-day first/last', async () => {
    await db.query('BEGIN');
    try {
      await snapshot('2026-09-10T00:00:00Z');
      await snapshot('2026-09-12T06:00:00Z', '2026-09-12T18:00:00Z');
      await snapshot('2026-09-17T11:50:00Z');
      await db.query("INSERT INTO membership_change_events(club_tag,player_tag,player_name,event_type,source,occurred_at,trigger_source,actor) VALUES('#CLUB','#PYLR','Name','leave','recorded','2026-09-12T12:00:00Z','fixture','unknown')");
      let legacy = (await read()).members[1];
      assert.equal(legacy.spell.startedAt, null); assert.equal(legacy.spell.kind, 'unknown');
      assert.equal(Date.parse(legacy.membershipObservation.observedSince), Date.parse('2026-09-12T18:00:00Z'));
      // A later complete omission invalidates even an older recorded join.
      await snapshot('2026-09-14T01:00:00Z', '2026-09-14T11:00:00Z', [], roster());
      const [recorded, afterOmission] = (await read()).members;
      assert.equal(recorded.spell.source, 'recorded'); assert.equal(recorded.spell.uncertain, true);
      assert.equal(Date.parse(recorded.spell.startedAt), Date.parse('2026-07-01T00:00:00Z'));
      for (const member of [recorded, afterOmission]) {
        assert.equal(member.membershipObservation.source, 'roster_snapshot');
        assert.equal(Date.parse(member.membershipObservation.observedSince), Date.parse('2026-09-14T11:00:00Z'));
        assert.equal(member.coverage.trailing48hExcused, true, 'Recently expired observation grace still excuses the trailing48h window');
      }
      await snapshot('2026-09-17T11:55:00Z', '2026-09-17T11:55:00Z', []);
      legacy = (await read()).members[1]; assert.equal(legacy.membershipObservation.source, null);
      assert.equal((await read()).members[0].spell.uncertain, true, 'A recorded join cannot bypass a latest omission');
    } finally { await db.query('ROLLBACK'); }
  });
  await t.test('malformed full snapshots, duplicate tags and conflicting same-time observations never establish membership', async () => {
    const invalidRosters = [null, '#PYLR', {}, { tag: 123 }, { ...roster()[1], name: null }, { ...roster()[1], role: null },
      { ...roster()[1], trophies: 2147483648 }, { ...roster()[1], trophies: '30000' }].map(value => [roster()[0], value]);
    invalidRosters.push([roster()[0], roster()[1], roster()[1]], Array.from({ length: 31 }, (_, i) => ({ ...roster()[0], tag: `#ROW${i}` })));
    for (const invalidMembers of invalidRosters) {
      await db.query('BEGIN');
      try {
        await snapshot('2026-09-10T00:00:00Z');
        await snapshot('2026-09-17T11:50:00Z', '2026-09-17T11:50:00Z', invalidMembers);
        const result = await read();
        assert.equal(result.members[1].membershipObservation.source, null);
        assert.equal(result.members[0].spell.uncertain, true, 'Malformed roster invalidates continuity for all members');
      } finally { await db.query('ROLLBACK'); }
    }
    await db.query('BEGIN');
    try {
      await snapshot('2026-09-10T00:00:00Z');
      await snapshot('2026-09-17T11:50:00Z', '2026-09-17T11:50:00Z', roster(), []);
      assert.equal((await read()).members[1].membershipObservation.source, null, 'All latest tied observations must include the member');
      await snapshot('2026-09-17T11:50:00Z', '2026-09-17T12:01:00Z');
      assert.equal((await read()).members[1].membershipObservation.source, null, 'Future data is uncertainty, not current proof');
    } finally { await db.query('ROLLBACK'); }
  });
  await t.test('fallback needs fresh same-club evidence and starts after malformed or reconstructed boundaries', async () => {
    await db.query('BEGIN');
    try {
      await snapshot('2026-06-01T00:00:00Z'); // outside the92retained day window
      await snapshot('2026-09-10T00:00:00Z');
      await snapshot('2026-09-17T09:59:59Z');
      await snapshot('2026-09-17T11:59:00Z', undefined, undefined, undefined, '#OTHER');
      assert.equal((await read()).members[1].membershipObservation.source, null, 'Other club cannot make a stale observation fresh');
      await snapshot('2026-09-17T10:00:00Z');
      assert.equal(Date.parse((await read()).members[1].membershipObservation.observedSince), Date.parse('2026-09-10T00:00:00Z'));
      await snapshot('2026-09-12T00:00:00Z', undefined, [null]);
      assert.equal(Date.parse((await read()).members[1].membershipObservation.observedSince), Date.parse('2026-09-17T10:00:00Z'));
      await db.query("INSERT INTO membership_change_events(club_tag,player_tag,player_name,event_type,source,occurred_at,trigger_source,actor) VALUES('#CLUB','#PYLR','Name','join','reconstructed','2026-09-17T10:00:00Z','fixture','unknown')");
      assert.equal((await read()).members[1].membershipObservation.source, null, 'Equal timestamps are not proof after the boundary');
      await snapshot('2026-09-17T10:00:00Z', '2026-09-17T11:50:00Z');
      assert.equal(Date.parse((await read()).members[1].membershipObservation.observedSince), Date.parse('2026-09-17T11:50:00Z'));
    } finally { await db.query('ROLLBACK'); }
  });
  await t.test('invalid ranges, stale club selection and cleared/future acceptance reject before data leaves the function', async () => {
    await assert.rejects(read(1), e => e.code === '22023'); await assert.rejects(read(7, '#OTHER'), e => e.code === '40001');
    await db.query('BEGIN');
    try {
      await db.query("UPDATE settings SET value='' WHERE key IN('last_sync_time','last_roster_sync_time')");
      await assert.rejects(read(), e => e.code === '40001');
    } finally { await db.query('ROLLBACK'); }
    await db.query('BEGIN');
    try {
      await db.query("UPDATE settings SET value='invalid' WHERE key='last_roster_sync_time'");
      assert.equal((await read()).members.length, 2, 'A valid legacy full marker still suffices');
    } finally { await db.query('ROLLBACK'); }
  });
  await t.test('STABLE snapshot does not wait for or mix an uncommitted roster change', async () => {
    const other = new Client({ connectionString: url.href }); await other.connect(); local(other);
    try {
      await other.query('BEGIN'); await other.query("UPDATE settings SET value='#OTHER' WHERE key='club_tag'; UPDATE member_history SET is_current_member=false; UPDATE members SET trophies=1");
      const result = await read(); assert.equal(result.clubTag, '#CLUB'); assert.equal(result.members.length, 2); assert.equal(result.members[0].profile.trophies, 30000);
      await other.query('COMMIT'); await assert.rejects(read(), e => e.code === '40001');
      await db.query("UPDATE settings SET value='#CLUB' WHERE key='club_tag'; UPDATE member_history SET is_current_member=true; UPDATE members SET trophies=30000 WHERE player_tag='#PYLQ'");
    } finally { await other.query('ROLLBACK'); await other.end(); }
  });
  await t.test('read-only transaction works and both public roles are denied even with permissive default grants', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.query('BEGIN'); try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(read(), e => e.code === '42501'); }
      finally { await db.query('ROLLBACK'); }
    }
    await db.query('BEGIN READ ONLY');
    try { await db.query('SET LOCAL ROLE service_role'); assert.equal((await read()).members.length, 2); }
    finally { await db.query('ROLLBACK'); }
    const fn = (await db.query("SELECT provolatile,prosecdef,proconfig FROM pg_proc WHERE oid='public.member_comparison_read(text,integer,timestamptz)'::regprocedure")).rows[0];
    assert.equal(fn.provolatile, 's'); assert.equal(fn.prosecdef, true); assert.ok(fn.proconfig.includes('search_path=pg_catalog'));
  });
  await t.test('more than30 current members fails closed instead of silently ranking a partial roster', async () => {
    await db.query('BEGIN');
    try {
      await db.query("INSERT INTO member_history(player_tag,player_name,is_current_member) SELECT '#EXTRA'||i,'Extra',true FROM generate_series(1,29)i");
      await assert.rejects(read(), e => e.code === '54000');
    } finally { await db.query('ROLLBACK'); }
  });
  await t.test('event overflow is explicit and30members by90days plus100candidates remain bounded', async () => {
    await db.query('BEGIN');
    try {
      await db.query("INSERT INTO member_history(player_tag,player_name,is_current_member) SELECT '#EXTRA'||i,'Extra',true FROM generate_series(1,28)i");
      await db.query("INSERT INTO recruitment_candidates(player_tag) SELECT '#R'||substr('0289PYLQGRJCUV',((i-1)/14)+1,1)||substr('0289PYLQGRJCUV',((i-1)%14)+1,1) FROM generate_series(1,96)i");
      const current = roster(['#PYLQ', '#PYLR', ...Array.from({ length: 28 }, (_, i) => `#EXTRA${i + 1}`)]);
      await db.query(`INSERT INTO club_roster_snapshots(club_tag,snapshot_day,first_observed_at,last_observed_at,first_members,last_members,first_run_id,last_run_id)
        SELECT '#CLUB',date, date::timestamp AT TIME ZONE 'UTC', date::timestamp AT TIME ZONE 'UTC'+interval '11 hours 50 minutes',
          $1,$1,'00000000-0000-4000-8000-000000000036','00000000-0000-4000-8000-000000000036'
        FROM generate_series('2026-06-18'::date,'2026-09-17'::date,interval '1 day')date`, [JSON.stringify(current)]);
      for (let i = 0; i < 100; i++) await event();
      const started = performance.now(), result = await read(90), elapsedMs = Math.round(performance.now() - started);
      assert.equal(result.members.length, 30); assert.equal(result.members.reduce((n,m) => n+m.days.length,0), 2700);
      assert.equal(result.candidates.length, 98); assert.equal(result.members.find(m=>m.tag==='#PYLQ').events.length,100);
      assert.equal(result.members.find(m=>m.tag==='#PYLQ').eventsTruncated,true);
      const bytes = Buffer.byteLength(JSON.stringify(result)); assert.ok(bytes<1000000);
      t.diagnostic(`Bounded comparison fixture:30members/90days/100candidate rows/92roster snapshots; ${elapsedMs}ms, ${bytes}response bytes`);
      await db.query("INSERT INTO recruitment_candidates(player_tag) VALUES('#CCCC')");
      await assert.rejects(read(),e=>e.code==='54000');
    } finally { await db.query('ROLLBACK'); }
  });
});
