const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomBytes, randomUUID } = require("node:crypto");
const { Client } = require("pg");
const { writeEncryptedBackup, readEncryptedBackup } = require("../../scripts/backup-format.cjs");
const { restoreBackup, validateRestoreTarget } = require("../../scripts/restore-backup.cjs");
const connectionString = process.env.BACKUP_TEST_DATABASE_URL;
const root = path.resolve(__dirname, "../..");
const clubFeatureTables = ["club_roster_snapshots","club_profiles","club_profile_events","member_decision_log","member_absences",
  "club_administration_settings","recruitment_applications","recruitment_application_limits","club_goals","club_goal_members",
  "club_goal_snapshots","club_planned_events","club_event_entries","club_event_revisions","club_rivals","club_rival_snapshots","club_rank_history","club_planning_create_requests","club_mega_pig_source_cache"];
const sourcePayload = { clubTag: "#PYLQ", totalWins: 5, reportedPlayersPlayed: 2, members: [
  { playerTag: "#GGRR", playerName: "لاعب المصدر", reportedWins: 3, reportedTicketsRemaining: 3 },
  { playerTag: "#Q2L0", playerName: "Second player", reportedWins: 2, reportedTicketsRemaining: 4 },
] };
const previousSourcePayload = { ...sourcePayload, totalWins: 3, members: sourcePayload.members.map(member => ({ ...member, reportedWins: member.reportedWins - 1, reportedTicketsRemaining: member.reportedTicketsRemaining + 1 })) };
const sourceRpcNames = ["claim_mega_pig_source_cache", "claim_mega_pig_brawltools_cache", "claim_mega_pig_provider_cache", "finish_mega_pig_source_cache"];
const archiveTables = ["club_mega_pig_observations", "club_mega_pig_cycles", "club_mega_pig_cycle_members", "club_mega_pig_cycle_revisions"];
const archiveRpcNames = ["mega_pig_archive_payload", "mega_pig_archive_ready", "mega_pig_archive_apply", "mega_pig_archive_capture",
  "mega_pig_archive_observation_summary", "mega_pig_archive_write", "mega_pig_archive_read"];
const archiveObservationId = "00000000-0000-4000-8000-000000000039";
const archiveCycleId = "00000000-0000-4000-8000-000000000139";

test("encrypted backup restores actual schema, rows and private permissions into an empty local database", { skip: !connectionString }, async t => {
  validateRestoreTarget(connectionString);
  const client = new Client({ connectionString });
  await client.connect();
  t.after(() => client.end());
  assert.equal((await client.query("SHOW server_encoding")).rows[0].server_encoding, "UTF8");
  await client.query("DROP PUBLICATION IF EXISTS supabase_realtime; DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role");
  await client.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role");
  await client.query(await fs.readFile(path.join(root, "supabase/schema.sql"), "utf8"));
  await client.query("ALTER TABLE public.members ADD COLUMN owner_user_id text DEFAULT 'private-member-owner'; ALTER TABLE public.battle_history ADD COLUMN owner_user_id text; CREATE PUBLICATION supabase_realtime FOR TABLE public.battle_history");
  await client.query(`
    CREATE TABLE public.profiles(id text PRIMARY KEY,owner_user_id text NOT NULL,code bigint GENERATED ALWAYS AS IDENTITY,normalized_owner text GENERATED ALWAYS AS (upper(owner_user_id)) STORED);
    CREATE TABLE public.clubs(id uuid PRIMARY KEY,owner_user_id text);
    CREATE TABLE public.user_clubs(id bigint PRIMARY KEY,club_id uuid REFERENCES public.clubs(id) ON DELETE CASCADE);
    INSERT INTO public.profiles(id,owner_user_id) VALUES('profile','owner-A');
    INSERT INTO public.clubs VALUES('00000000-0000-4000-8000-000000000001','external-owner');
    INSERT INTO public.user_clubs VALUES(9007199254740993,'00000000-0000-4000-8000-000000000001');
    INSERT INTO public.members(player_tag,player_name,trophies) VALUES('#PLAYER','لاعب عربي',30000);
    INSERT INTO public.member_history(player_tag,player_name,notes) VALUES('#PLAYER','لاعب عربي',repeat('ملاحظة خاصة',50000));
    INSERT INTO public.settings(key,value) VALUES('api_key','private-test-key'),('scheduler_token','private-test-scheduler') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
    INSERT INTO public.activity_log(player_tag,trophies,trophy_change,recorded_at)
      SELECT '#PLAYER',30000+(i%100),i%20,'2026-09-15T00:00:00Z'::timestamptz+i*interval '1 second' FROM generate_series(1,${process.env.BACKUP_LARGE_TEST === "1" ? 307000 : 1501}) i;
  `);
  for (const filename of (await fs.readdir(path.join(root, "supabase/migrations"))).filter(name => /^20260916\d{4}_.*\.sql$/.test(name)).sort()) await client.query(await fs.readFile(path.join(root, "supabase/migrations", filename), "utf8"));
  await client.query(`
    INSERT INTO public.settings(key,value) VALUES('club_tag','#CLUB'),('last_roster_sync_time',now()::text) ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    INSERT INTO public.sync_ranked_fallback_attempts(club_tag,player_tag,attempted_at) VALUES('#CLUB','#PLAYER',now());
    UPDATE public.members SET rank_current='Diamond I',rank_highest='Mythic I',ranked_points=3417,
      ranked_all_time_best_points=4678,ranked_season_id=48,ranked_season_best='Diamond II',ranked_season_best_points=3505,
      ranked_checked_at=now(),ranked_source='profile',ranked_provenance=jsonb_build_object('rank_current',jsonb_build_object('source','profile','checked_at',now()))
      WHERE player_tag='#PLAYER';
    INSERT INTO public.battle_history(player_tag,battle_time,mode,map,result,trophy_change,trophy_change_reported,battle_type,event_id,event_mode_id,battle_mode,event_mode,placement_rank)
      VALUES('#PLAYER',now()-interval '1 hour','trioShowdown','خريطة','defeat',NULL,false,'soloRanked',15001280,38,'duoShowdown','trioShowdown',3);
    INSERT INTO public.sync_runs(id,club_tag,source,scope,fence,status,finished_at)
      VALUES('00000000-0000-4000-8000-000000000009','#CLUB','cron','full',1,'succeeded',now());
    INSERT INTO public.sync_battle_coverage(club_tag,player_tag,baseline_started_at,last_observed_at,recent_battle_times,last_attempt_at,last_observation_status,last_run_id)
      VALUES('#CLUB','#PLAYER',now()-interval '1 day',now(),ARRAY[now()-interval '1 hour'],now(),'possible_gap','00000000-0000-4000-8000-000000000009');
    INSERT INTO public.sync_battle_gaps(club_tag,player_tag,run_id,detected_at,gap_start_at,gap_end_at,previous_observed_at,window_size,scope)
      VALUES('#CLUB','#PLAYER','00000000-0000-4000-8000-000000000009',now(),now()-interval '3 hours',now()-interval '2 hours',now()-interval '4 hours',25,'full');
    SELECT public.sample_database_capacity();
    INSERT INTO public.player_profile_details(player_tag,exp_points,fame,fame_tier_name,total_prestige_level,observed_at)
      VALUES('#PLAYER',12345,99,'Lunar I',3,now());
    INSERT INTO public.player_brawler_details(player_tag,brawler_id,brawler_name,power_level,trophies,highest_trophies,hyper_charges,buffies,observed_at)
      VALUES('#PLAYER',16000000,'SHELLY',11,100,120,'[{"id":23000000,"name":"Fixture"}]','{"gadget":false}',now());
    INSERT INTO public.player_ranked_history(player_tag,run_id,observed_at,kind,season_id,current_rank,points)
      VALUES('#PLAYER','00000000-0000-4000-8000-000000000009',now(),'initial',48,'Diamond I',3417);
    INSERT INTO public.game_api_cache(cache_key,payload,fetched_at,expires_at) VALUES('events','[{"map":"خريطة محفوظة"}]',now(),now()+interval '5 minutes');
    INSERT INTO public.recruitment_candidates(player_tag,notes,status) VALUES('#PYLQ','ملاحظة ترشيح خاصة','shortlisted');
    UPDATE public.battle_history SET duration_seconds=123 WHERE player_tag='#PLAYER';
    INSERT INTO public.club_roster_snapshots VALUES('#CLUB',current_date,now()-interval '1 hour',now(),
      '[{"tag":"#PLAYER","name":"لاعب عربي","role":"member","trophies":29900}]',
      '[{"tag":"#PLAYER","name":"لاعب عربي","role":"member","trophies":30000}]',
      '00000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000009');
    INSERT INTO public.club_profiles VALUES('#CLUB','{"name":"نادي الاختبار","description":"وصف محفوظ","requiredTrophies":12000}',now()-interval '1 day',now());
    INSERT INTO public.club_profile_events(id,club_tag,run_id,observed_at,before_metadata,after_metadata,changed_fields)
      VALUES('00000000-0000-4000-8000-000000000029','#CLUB','00000000-0000-4000-8000-000000000009',now(),NULL,'{"name":"نادي الاختبار"}',ARRAY['name']);
    INSERT INTO public.membership_change_events(id,club_tag,player_tag,player_name,event_type,source,occurred_at,trigger_source,actor)
      VALUES('00000000-0000-4000-8000-000000000030','#CLUB','#PLAYER','لاعب عربي','leave','recorded',now()-interval '2 days','manual','admin');
    INSERT INTO public.club_administration_settings(club_tag,grace_hours,recruitment_open,min_trophies,language) VALUES('#CLUB',24,false,15000,'العربية');
    INSERT INTO public.member_decision_log(id,club_tag,player_tag,kind,body,departure_event_id,request_id)
      VALUES('00000000-0000-4000-8000-000000000130','#CLUB','#PLAYER','departure_reason','سبب مغادرة خاص','00000000-0000-4000-8000-000000000030',gen_random_uuid());
    INSERT INTO public.member_absences(club_tag,player_tag,starts_at,ends_at,reason,request_id)
      VALUES('#CLUB','#PLAYER',now()-interval '1 hour',now()+interval '1 day','غياب معلن خاص',gen_random_uuid());
    INSERT INTO public.recruitment_applications(id,club_tag,player_tag,message,language,availability,private_notes,request_id)
      VALUES('00000000-0000-4000-8000-000000000230','#CLUB','#PYLQ','طلب محفوظ','العربية','المساء','تقييم خاص',gen_random_uuid());
    INSERT INTO public.recruitment_application_limits VALUES('#CLUB',repeat('b',64),current_date,2);
    UPDATE public.recruitment_candidates SET manual_compatibility='{"language":"compatible","time":"unknown","languages":"العربية","availability":"Evening"}' WHERE player_tag='#PYLQ';
    INSERT INTO public.club_goals(id,club_tag,title,metric,cycle,starts_at,ends_at,target,progress,cohort_count,known_members,limited)
      VALUES('00000000-0000-4000-8000-000000000031','#CLUB','هدف محفوظ','trophies','weekly',now()-interval '1 day',now()+interval '6 days',100,50,1,1,false);
    INSERT INTO public.club_goal_members(goal_id,player_tag,player_name,baseline_trophies,baseline_at,latest_trophies,latest_at)
      VALUES('00000000-0000-4000-8000-000000000031','#PLAYER','لاعب عربي',29950,now()-interval '1 day',30000,now());
    INSERT INTO public.club_goal_snapshots VALUES('00000000-0000-4000-8000-000000000031',current_date,now(),50,1,false,false);
    INSERT INTO public.club_planning_create_requests(club_tag,request_id,action,payload_sha256,result_id)
      VALUES('#CLUB','00000000-0000-4000-8000-000000000035','create_goal',
        sha256(convert_to('{"action":"create_goal","title":"هدف محفوظ","metric":"trophies","cycle":"weekly","endsAt":null,"target":100}'::jsonb::text,'UTF8')),
        '00000000-0000-4000-8000-000000000031');
    INSERT INTO public.club_planned_events(id,club_tag,title,kind,cycle_label,starts_at,ends_at,team_size,ticket_allowance,notes)
      VALUES('00000000-0000-4000-8000-000000000131','#CLUB','خطة محفوظة','mega_pig','دورة معلنة',now()-interval '2 hours',now()+interval '23 hours',3,15,'تخطيط يدوي خاص');
    INSERT INTO public.club_event_entries(event_id,player_tag,player_name,team,slot,attendance,wins,tickets_remaining,observed_at,notes)
      VALUES('00000000-0000-4000-8000-000000000131','#PLAYER','لاعب عربي',1,'starter','present',5,2,now(),'إدخال يدوي');
    INSERT INTO public.club_event_revisions VALUES('00000000-0000-4000-8000-000000000131',1,now(),'سجل أولي','{"event":{"title":"خطة محفوظة"},"entries":[{"playerTag":"#PLAYER","wins":5,"ticketsRemaining":2}]}');
    INSERT INTO public.club_rivals(club_tag,rival_tag,profile,fetched_at,expires_at)
      VALUES('#PYLQ','#GGRR','{"tag":"#GGRR","name":"نادي منافس","trophies":500000,"memberCount":25}',now(),now()+interval '6 hours');
    INSERT INTO public.club_rival_snapshots VALUES('#PYLQ','#GGRR',current_date,now(),500000,25);
    INSERT INTO public.club_rank_history VALUES('#PYLQ','#GGRR','global',current_date,now(),NULL,NULL);
  `);
  await client.query(`INSERT INTO public.club_mega_pig_source_cache(club_tag,payload,previous_payload,fetched_at,changed_at,last_attempt_at,next_check_at,
    lease_token,lease_expires_at,error_code,consecutive_failures,source_provider,previous_provider_state)
    VALUES('#PYLQ',$1::jsonb,$2::jsonb,'2026-09-17T10:00:00Z','2026-09-17T09:45:00Z','2026-09-17T10:30:00Z','2026-09-17T11:00:00Z',
      '00000000-0000-4000-8000-000000000038','2026-09-17T10:30:15Z','rate_limited',2,'BrawlTools',
      '{"source_provider":"BrawlAce","error_code":"unavailable","consecutive_failures":4,"last_attempt_at":"2026-09-17T09:30:00Z","next_check_at":"2026-09-17T15:30:00Z","transitioned_at":"2026-09-17T10:00:00Z","lease_expires_at":null}')`, [JSON.stringify(sourcePayload), JSON.stringify(previousSourcePayload)]);
  const savedSourceCache = (await client.query("SELECT to_jsonb(cache) AS entry FROM public.club_mega_pig_source_cache cache WHERE club_tag='#PYLQ'")).rows[0].entry;
  const archivedPayload = { ...sourcePayload, members: [sourcePayload.members[0], { ...sourcePayload.members[1], reportedWins: null, reportedTicketsRemaining: null }] };
  await client.query(`
    INSERT INTO public.club_mega_pig_observations(id,club_tag,payload,first_fetched_at,last_fetched_at,origin,recorded_at)
      VALUES($1,'#PYLQ',$2::jsonb,'2026-09-17T10:00:00.123456Z','2026-09-17T10:20:00.654321Z','source_fetch','2026-09-17T10:20:01Z')
  `, [archiveObservationId, JSON.stringify(archivedPayload)]);
  await client.query(`
    INSERT INTO public.club_mega_pig_cycles(id,club_tag,request_id,create_payload,title,starts_at,ends_at,milestones,notes,version,
      initial_observation_id,capture_enabled,last_captured_at,reported_total_wins,reported_players_played,final_total_wins,
      confirmed_stage,reward_status,finalized_at,created_at,updated_at)
      VALUES($2,'#PYLQ','00000000-0000-4000-8000-000000000239','{"action":"save_cycle","title":"دورة مؤرشفة"}',
        'دورة مؤرشفة','2026-09-14T08:00:00Z','2026-09-17T10:20:00Z',ARRAY[16,32,48,64,80],'تأكيد إداري خاص',2,$1,false,
        '2026-09-17T10:20:00.654321Z',5,2,80,5,'received','2026-09-17T10:30:00Z','2026-09-14T08:00:00Z','2026-09-17T10:30:00Z')
  `, [archiveObservationId, archiveCycleId]);
  await client.query(`
    INSERT INTO public.club_mega_pig_cycle_members(cycle_id,player_tag,first_player_name,player_name,first_observed_at,last_observed_at,
      wins,tickets_remaining,wins_observed_at,tickets_observed_at,latest_wins_unknown,latest_tickets_unknown)
      VALUES($1,'#GGRR','اسم قديم محفوظ','اسم المغادر الأخير','2026-09-14T09:00:00Z','2026-09-16T10:00:00.123456Z',3,NULL,
        '2026-09-16T10:00:00.123456Z',NULL,true,true)
  `, [archiveCycleId]);
  await client.query(`
    INSERT INTO public.club_mega_pig_cycle_revisions(cycle_id,version,action,before_snapshot,after_snapshot,reason,saved_at)
      SELECT id,version,'finalize_cycle',
        (to_jsonb(c)-'create_payload')||'{"final_total_wins":null,"confirmed_stage":4,"reward_status":"unknown","finalized_at":null}'::jsonb,
        to_jsonb(c)-'create_payload','تأكيد الوصول واستلام المكافأة','2026-09-17T10:30:00.123456Z'
      FROM public.club_mega_pig_cycles c WHERE id=$1
  `, [archiveCycleId]);
  const savedArchive = new Map();
  for (const table of archiveTables) savedArchive.set(table, (await client.query(`SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows.map(item => item.row));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "brawl-encrypted-backup-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "test.brawlbackup");
  const key = randomBytes(32);
  const snapshotId = randomUUID();
  let manifest; let receipt; let backup;

  await t.test("anon/authenticated cannot access chunks or invoke snapshot/completion RPCs", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const sql of ["SELECT * FROM public.backup_snapshots", "SELECT * FROM public.backup_chunks", `SELECT public.create_backup_snapshot('${snapshotId}')`, `SELECT public.complete_backup_snapshot('${snapshotId}',repeat('a',64))`]) {
        await client.query("BEGIN");
        try { await client.query(`SET LOCAL ROLE ${role}`); await assert.rejects(client.query(sql), error => error.code === "42501"); }
        finally { await client.query("ROLLBACK"); }
      }
    }
  });

  await t.test("contended table locks fail quickly and leave no partial snapshot", async () => {
    const writer = new Client({ connectionString }); await writer.connect();
    try {
      await writer.query("BEGIN; UPDATE public.members SET trophies=trophies+1 WHERE player_tag='#PLAYER'");
      await assert.rejects(client.query("SELECT public.create_backup_snapshot($1)", [snapshotId]), error => error.code === "55P03");
      assert.equal((await client.query("SELECT count(*)::int AS n FROM public.backup_snapshots")).rows[0].n, 0);
    } finally { await writer.query("ROLLBACK"); await writer.end(); }
  });

  await t.test("transactional snapshot is idempotent and all encoded chunks remain below one MiB", async () => {
    await client.query("SET ROLE service_role");
    try {
      const result = (await client.query("SELECT public.create_backup_snapshot($1) AS result", [snapshotId])).rows[0].result;
      assert.equal(result.snapshot_id, snapshotId);
      assert.equal((await client.query("SELECT public.create_backup_snapshot($1) AS result", [snapshotId])).rows[0].result.snapshot_id, snapshotId);
    } finally { await client.query("RESET ROLE"); }
    manifest = (await client.query("SELECT manifest FROM public.backup_snapshots WHERE id=$1", [snapshotId])).rows[0].manifest;
    assert.equal(manifest.tables.find(table => table.name === "activity_log").row_count, process.env.BACKUP_LARGE_TEST === "1" ? 307000 : 1501);
    for (const name of ["sync_activity_summary_v2", "report_account_trophy_trend", "report_member_activity_history"]) {
      assert.ok(manifest.functions.some(fn => fn.name === name), `Range function ${name} must be captured`);
    }
    assert.equal(manifest.tables.find(table => table.name === "backup_chunks").row_count, 0);
    for (const name of ["sync_battle_coverage", "sync_battle_gaps", "capacity_samples", "sync_ranked_fallback_attempts", "club_sync_signals"]) assert.equal(manifest.tables.find(table => table.name === name).row_count, 1);
    for(const name of clubFeatureTables)assert.equal(manifest.tables.find(table=>table.name===name)?.row_count,1,`${name} must be included with its data`);
    for(const name of sourceRpcNames)assert.ok(manifest.functions.some(fn=>fn.name===name),`${name} must be included in the captured schema`);
    for(const name of archiveTables)assert.equal(manifest.tables.find(table=>table.name===name)?.row_count,1,`${name} archive rows must be captured`);
    for(const name of archiveRpcNames)assert.ok(manifest.functions.some(fn=>fn.name===name),`${name} archive procedure must be captured`);
    assert.ok(manifest.functions.find(fn=>fn.name==='commit_sync_snapshot').definition.includes('member_inactivity_exempt(v_run.club_tag,player_tag,v_now)'),'The backup must capture the live absence hook, not an older sync body');
    assert.ok(manifest.tables.find(table => table.name === "profiles").columns.some(column => column.name === "owner_user_id"));
    assert.ok((await client.query("SELECT max(octet_length(payload)) AS size FROM public.backup_chunks")).rows[0].size < 1024 * 1024);
    assert.ok(manifest.tables.find(table => table.name === "member_reviews").chunks.length > 1, "Large Arabic record must split safely");
    // The original rows can change after the transaction; snapshot chunks remain immutable.
    await client.query("UPDATE public.members SET trophies=99999 WHERE player_tag='#PLAYER'");
    let chunkRead=Promise.resolve();
    receipt = await writeEncryptedBackup(manifest, (table,index)=>{
      // The exporter requests up to four chunks concurrently; a single PG
      // test connection requires an explicit queue instead of driver queuing.
      const read=chunkRead.then(async()=>(await client.query("SELECT payload,sha256,byte_count FROM public.backup_chunks WHERE snapshot_id=$1 AND table_name=$2 AND chunk_index=$3",[snapshotId,table,index])).rows[0]);
      chunkRead=read.then(()=>undefined);return read;
    }, output, key);
    assert.equal(receipt.snapshot_id, snapshotId);
    const ciphertext = await fs.readFile(output);
    assert.equal(ciphertext.includes(Buffer.from("private-test-key")), false);
    assert.equal(ciphertext.includes(Buffer.from("ملاحظة خاصة")), false);
    backup = await readEncryptedBackup(output, key);
    assert.equal(backup.artifact_sha256, receipt.artifact_sha256);
  });

  await t.test("corrupted ciphertext and a wrong key are rejected before restore", async () => {
    const bytes = await fs.readFile(output); bytes[35] ^= 1;
    const corrupt = path.join(directory, "corrupt.brawlbackup"); await fs.writeFile(corrupt, bytes);
    await assert.rejects(readEncryptedBackup(corrupt, key), /authentication failed/);
    await assert.rejects(readEncryptedBackup(output, randomBytes(32)), /authentication failed/);
    await assert.rejects(restoreBackup(backup, connectionString), /not empty/);
  });

  await t.test("catalog dependencies on external identity functions are recorded and refused by app-only restore", async () => {
    await client.query("BEGIN");
    try {
      await client.query("CREATE SCHEMA external_test_identity; CREATE FUNCTION external_test_identity.actor() RETURNS boolean LANGUAGE sql AS 'SELECT true'; CREATE POLICY external_identity_test ON public.members FOR SELECT TO anon USING(external_test_identity.actor())");
      const id = randomUUID();
      await client.query("SELECT public.create_backup_snapshot($1)", [id]);
      const external = (await client.query("SELECT manifest FROM public.backup_snapshots WHERE id=$1", [id])).rows[0].manifest;
      assert.ok(external.external_dependencies.some(item => item.schema === "external_test_identity"));
      await assert.rejects(restoreBackup({ ...backup, manifest: external }, connectionString), /external schemas/);
    } finally { await client.query("ROLLBACK"); }
  });

  await t.test("completion acknowledges artifact hash before deleting private chunks", async () => {
    assert.equal((await client.query("SELECT public.complete_backup_snapshot($1,$2) AS ok", [snapshotId, receipt.artifact_sha256])).rows[0].ok, true);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM public.backup_chunks WHERE snapshot_id=$1", [snapshotId])).rows[0].n, 0);
    assert.equal((await client.query("SELECT public.complete_backup_snapshot($1,$2) AS ok", [snapshotId, "f".repeat(64)])).rows[0].ok, false);
  });

  await t.test("empty local restore reproduces Unicode, bigint, generated fields, sequences, functions, constraints and permissions", async () => {
    await client.query("DROP PUBLICATION IF EXISTS supabase_realtime; DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await client.query("CREATE FUNCTION public.existing_user_work() RETURNS boolean LANGUAGE sql AS 'SELECT true'");
    await assert.rejects(restoreBackup(backup, connectionString), /not empty/);
    await client.query("DROP FUNCTION public.existing_user_work()");
    const exposed={...backup,manifest:{...backup.manifest,tables:backup.manifest.tables.map(table=>table.name==='recruitment_applications'?{...table,grants:[...table.grants,{role:'anon',privilege:'SELECT',grantable:false}]}:table)}};
    await assert.rejects(restoreBackup(exposed,connectionString),/Private permissions verification failed for recruitment_applications/);
    assert.equal((await client.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0,'A failed permissions check must roll back the complete restore');
    assert.ok(backup.manifest.functions.some(fn=>fn.name==='club_event_observations_read'),'New read-only event evidence RPC must be present in the captured schema');
    const exposedEventRpc={...backup,manifest:{...backup.manifest,functions:backup.manifest.functions.map(fn=>fn.name==='club_event_observations_read'?{...fn,grants:[...fn.grants,{role:'anon',privilege:'EXECUTE',grantable:false}]}:fn)}};
    await assert.rejects(restoreBackup(exposedEventRpc,connectionString),/Private function permissions verification failed for club_event_observations_read/);
    assert.equal((await client.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0,'An exposed event RPC must roll back the complete restore');
    const exposedSourceTable={...backup,manifest:{...backup.manifest,tables:backup.manifest.tables.map(table=>table.name==='club_mega_pig_source_cache'?{...table,grants:[...table.grants,{role:'anon',privilege:'SELECT',grantable:false}]}:table)}};
    await assert.rejects(restoreBackup(exposedSourceTable,connectionString),/Private permissions verification failed for club_mega_pig_source_cache/);
    assert.equal((await client.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0,'An exposed provider cache must roll back the complete restore');
    for(const name of sourceRpcNames){
      const exposedSourceRpc={...backup,manifest:{...backup.manifest,functions:backup.manifest.functions.map(fn=>fn.name===name?{...fn,grants:[...fn.grants,{role:'authenticated',privilege:'EXECUTE',grantable:false}]}:fn)}};
      await assert.rejects(restoreBackup(exposedSourceRpc,connectionString),new RegExp(`Private function permissions verification failed for ${name}`));
      assert.equal((await client.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0,`An exposed ${name} must roll back the complete restore`);
    }
    for (const [index, name] of archiveTables.entries()) {
      const grant = index % 2 ? { role: 'authenticated', privilege: 'UPDATE', grantable: false } : { role: 'anon', privilege: 'SELECT', grantable: false };
      const exposedArchive = { ...backup, manifest: { ...backup.manifest, tables: backup.manifest.tables.map(table => table.name === name ? { ...table, grants: [...table.grants, grant] } : table) } };
      await assert.rejects(restoreBackup(exposedArchive, connectionString), new RegExp(`Private permissions verification failed for ${name}`));
      assert.equal((await client.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0, `Exposed ${name} must leave no partial restored data`);
    }
    for (const name of archiveRpcNames) {
      const exposedArchiveRpc = { ...backup, manifest: { ...backup.manifest, functions: backup.manifest.functions.map(fn => fn.name === name ? { ...fn, grants: [...fn.grants, { role: 'PUBLIC', privilege: 'EXECUTE', grantable: false }] } : fn) } };
      await assert.rejects(restoreBackup(exposedArchiveRpc, connectionString), new RegExp(`Private function permissions verification failed for ${name}`));
      assert.equal((await client.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0, `Exposed ${name} must roll back data and schema`);
    }
    const missingArchiveRls = { ...backup, manifest: { ...backup.manifest, tables: backup.manifest.tables.map(table => table.name === 'club_mega_pig_cycles' ? { ...table, rls: false } : table) } };
    await assert.rejects(restoreBackup(missingArchiveRls, connectionString), /Private RLS verification failed for club_mega_pig_cycles/);
    assert.equal((await client.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0, 'Missing archive RLS must roll back the complete restore');
    const result = await restoreBackup(backup, connectionString);
    assert.equal(result.verified, true);
    const restoredBattle = (await client.query("SELECT trophy_change,trophy_change_reported,battle_type,event_id,event_mode_id,battle_mode,event_mode,placement_rank FROM public.battle_history")).rows[0];
    assert.deepEqual(restoredBattle,{trophy_change:null,trophy_change_reported:false,battle_type:"soloRanked",event_id:15001280,event_mode_id:38,battle_mode:"duoShowdown",event_mode:"trioShowdown",placement_rank:3});
    const restoredBattlePage=(await client.query("SELECT * FROM public.battle_feed_page(ARRAY['#PLAYER'],now()-interval '1 day',now())")).rows;
    assert.equal(restoredBattlePage.length,1);assert.equal(restoredBattlePage[0].mode,"trioShowdown");assert.equal(restoredBattlePage[0].event_mode_id,38);
    const restoredFacets=(await client.query("SELECT public.battle_feed_facets(ARRAY['#PLAYER'],now()-interval '1 day',now()) x")).rows[0].x;
    assert.equal(restoredFacets.total,1);assert.deepEqual(restoredFacets.contexts,[{key:"ranked",count:1}]);
    for (const name of ["sync_battle_coverage", "sync_battle_gaps", "capacity_samples", "sync_ranked_fallback_attempts", "club_sync_signals"]) assert.equal((await client.query(`SELECT count(*)::int AS n FROM public.${name}`)).rows[0].n, 1);
    assert.equal((await client.query("SELECT fame FROM public.player_profile_details WHERE player_tag='#PLAYER'")).rows[0].fame,99);
    assert.equal((await client.query("SELECT highest_trophies FROM public.player_brawler_details WHERE player_tag='#PLAYER'")).rows[0].highest_trophies,120);
    assert.equal((await client.query("SELECT points FROM public.player_ranked_history WHERE player_tag='#PLAYER'")).rows[0].points,3417);
    assert.deepEqual((await client.query("SELECT payload FROM public.game_api_cache WHERE cache_key='events'")).rows[0].payload,[{map:'خريطة محفوظة'}]);
    assert.equal((await client.query("SELECT notes FROM public.recruitment_candidates WHERE player_tag='#PYLQ'")).rows[0].notes,'ملاحظة ترشيح خاصة');
    for(const name of clubFeatureTables)assert.equal((await client.query(`SELECT count(*)::int n FROM public.${name}`)).rows[0].n,1,`${name} roundtrip row count`);
    assert.deepEqual((await client.query("SELECT to_jsonb(cache) AS entry FROM public.club_mega_pig_source_cache cache WHERE club_tag='#PYLQ'")).rows[0].entry,savedSourceCache,'Both provider payloads, Unicode, timestamps, cooldown and private lease must roundtrip unchanged');
    assert.deepEqual(savedSourceCache.payload,sourcePayload);assert.deepEqual(savedSourceCache.previous_payload,previousSourcePayload);
    for (const name of archiveTables) {
      const rows = (await client.query(`SELECT to_jsonb(t) AS row FROM public.${name} t ORDER BY to_jsonb(t)::text`)).rows.map(item => item.row);
      assert.deepEqual(rows, savedArchive.get(name), `${name} must preserve every historical field, including microsecond timestamps`);
    }
    const restoredCycle = savedArchive.get('club_mega_pig_cycles')[0];
    assert.deepEqual(restoredCycle.milestones, [16, 32, 48, 64, 80]);
    assert.equal(restoredCycle.final_total_wins, 80); assert.equal(restoredCycle.confirmed_stage, 5); assert.equal(restoredCycle.reward_status, 'received');
    const restoredDeparted = savedArchive.get('club_mega_pig_cycle_members')[0];
    assert.equal(restoredDeparted.first_player_name, 'اسم قديم محفوظ'); assert.equal(restoredDeparted.player_name, 'اسم المغادر الأخير');
    assert.equal(restoredDeparted.wins, 3); assert.equal(restoredDeparted.tickets_remaining, null);
    assert.equal(restoredDeparted.latest_wins_unknown, true); assert.equal(restoredDeparted.tickets_observed_at, null);
    assert.equal((await client.query('SELECT count(*)::int n FROM public.members WHERE player_tag=$1', [restoredDeparted.player_tag])).rows[0].n, 0, 'Historical member survives without a current roster row');
    assert.deepEqual(savedArchive.get('club_mega_pig_observations')[0].payload, archivedPayload);
    assert.equal(savedArchive.get('club_mega_pig_cycle_revisions')[0].before_snapshot.confirmed_stage, 4);
    assert.equal(savedArchive.get('club_mega_pig_cycle_revisions')[0].after_snapshot.reward_status, 'received');
    assert.deepEqual((await client.query("SELECT first_members,last_members FROM public.club_roster_snapshots")).rows[0],{
      first_members:[{tag:'#PLAYER',name:'لاعب عربي',role:'member',trophies:29900}],last_members:[{tag:'#PLAYER',name:'لاعب عربي',role:'member',trophies:30000}]});
    assert.equal((await client.query("SELECT metadata->>'description' description FROM public.club_profiles")).rows[0].description,'وصف محفوظ');
    assert.equal((await client.query("SELECT before_metadata FROM public.club_profile_events")).rows[0].before_metadata,null);
    assert.equal((await client.query("SELECT member_inactivity_exempt('#CLUB','#PLAYER',now()) exempt")).rows[0].exempt,true);
    assert.equal((await client.query("SELECT body,departure_event_id::text FROM public.member_decision_log")).rows[0].departure_event_id,'00000000-0000-4000-8000-000000000030');
    await assert.rejects(client.query("UPDATE public.member_decision_log SET body='erased'"),error=>error.code==='42501');
    await assert.rejects(client.query("TRUNCATE public.member_decision_log"),error=>error.code==='42501');
    assert.equal((await client.query("SELECT has_table_privilege('service_role','public.member_decision_log','TRUNCATE') allowed")).rows[0].allowed,false);
    assert.equal((await client.query("SELECT body FROM public.member_decision_log")).rows[0].body,'سبب مغادرة خاص');
    assert.equal((await client.query("SELECT private_notes FROM public.recruitment_applications")).rows[0].private_notes,'تقييم خاص');
    assert.equal((await client.query("SELECT manual_compatibility->>'language' language FROM public.recruitment_candidates WHERE player_tag='#PYLQ'")).rows[0].language,'compatible');
    assert.equal((await client.query("SELECT baseline_trophies FROM public.club_goal_members")).rows[0].baseline_trophies,29950);
    assert.deepEqual((await client.query("SELECT request_id::text,action,result_id::text,octet_length(payload_sha256) digest_bytes FROM public.club_planning_create_requests")).rows[0],{
      request_id:'00000000-0000-4000-8000-000000000035',action:'create_goal',result_id:'00000000-0000-4000-8000-000000000031',digest_bytes:32});
    assert.equal((await client.query("SELECT public.club_planning_create_once('#CLUB','00000000-0000-4000-8000-000000000035',$1::jsonb) id",[JSON.stringify({action:'create_goal',title:'هدف محفوظ',metric:'trophies',cycle:'weekly',endsAt:null,target:100})])).rows[0].id,'00000000-0000-4000-8000-000000000031');
    assert.deepEqual((await client.query("SELECT wins,tickets_remaining,source FROM public.club_event_entries")).rows[0],{wins:5,tickets_remaining:2,source:'manual'});
    assert.equal((await client.query("SELECT snapshot->'event'->>'title' title FROM public.club_event_revisions")).rows[0].title,'خطة محفوظة');
    assert.equal((await client.query("SELECT profile->>'name' name FROM public.club_rivals")).rows[0].name,'نادي منافس');
    assert.deepEqual((await client.query("SELECT rank,trophies FROM public.club_rank_history")).rows[0],{rank:null,trophies:null});
    assert.equal((await client.query("SELECT duration_seconds FROM public.battle_history WHERE player_tag='#PLAYER'")).rows[0].duration_seconds,123);
    const restoredRank=(await client.query("SELECT rank_current,rank_highest,ranked_points,ranked_all_time_best_points,ranked_season_best_points,ranked_source FROM public.members WHERE player_tag='#PLAYER'")).rows[0];
    assert.deepEqual(restoredRank,{rank_current:'Diamond I',rank_highest:'Mythic I',ranked_points:3417,ranked_all_time_best_points:4678,ranked_season_best_points:3505,ranked_source:'profile'});
    assert.equal((await client.query("SELECT version::text FROM public.club_sync_signals WHERE id=1")).rows[0].version,'00000000-0000-4000-8000-000000000009');
    for(const rpc of ['report_dashboard_read','report_leaderboard_read']) {
      assert.ok(Array.isArray((await client.query(`SELECT public.${rpc}(7,now()) x`)).rows[0].x.members));
    }
    const comparison = (await client.query("SELECT public.member_comparison_read('#CLUB',7,now()) x")).rows[0].x;
    assert.equal(comparison.clubTag,'#CLUB'); assert.ok(Array.isArray(comparison.members)); assert.equal(comparison.candidates.length,1);
    assert.doesNotMatch(JSON.stringify(comparison),/private-member-owner|private-test-key|ملاحظة ترشيح خاصة|سبب مغادرة خاص/);
    await client.query('BEGIN READ ONLY');
    try {
      await client.query('SET LOCAL ROLE service_role');
      const observations=(await client.query("SELECT public.club_event_observations_read('#CLUB','00000000-0000-4000-8000-000000000131',now()) x")).rows[0].x;
      assert.equal(observations.eventVersion,1); assert.equal(observations.members.length,1);
      assert.equal(observations.members[0].observedBattles,1); assert.equal(observations.members[0].explicitMegaPigBattles,0);
      assert.equal(observations.members[0].authoritativeWins,null); assert.equal(observations.members[0].ticketsRemaining,null);
      assert.doesNotMatch(JSON.stringify(observations),/private-member-owner|private-test-key|تخطيط يدوي خاص|إدخال يدوي/);
    } finally { await client.query('ROLLBACK'); }
    assert.deepEqual((await client.query("SELECT wins,tickets_remaining,source FROM public.club_event_entries")).rows[0],{wins:5,tickets_remaining:2,source:'manual'},'Reading automatic evidence never overwrites the restored manual correction');
    assert.equal((await client.query("SELECT possible_gap FROM public.sync_battle_coverage_summary('#CLUB',ARRAY['#PLAYER'])")).rows[0].possible_gap, true);
    assert.equal((await client.query("SELECT owner_user_id,normalized_owner FROM public.profiles")).rows[0].owner_user_id, "owner-A");
    assert.equal((await client.query("SELECT normalized_owner FROM public.profiles")).rows[0].normalized_owner, "OWNER-A");
    assert.equal((await client.query("SELECT id::text FROM public.user_clubs")).rows[0].id, "9007199254740993");
    assert.equal((await client.query("SELECT trophies FROM public.members WHERE player_tag='#PLAYER'")).rows[0].trophies, 30000);
    const restoredMetrics = (await client.query("SELECT * FROM public.sync_activity_summary_v2(ARRAY['#PLAYER'],'2026-09-16T00:25:00Z')")).rows[0];
    assert.equal(restoredMetrics.trophies_24h, 0);
    assert.equal(restoredMetrics.trophies_30d, null);
    assert.equal(restoredMetrics.trophies_90d, null);
    assert.equal((await client.query("SELECT * FROM public.report_account_trophy_trend(ARRAY['#PLAYER'],90,'2026-09-16T00:25:00Z')")).rowCount, 90);
    const restoredObservations = (await client.query("SELECT * FROM public.report_member_activity_history('#PLAYER',7,'2026-09-16T00:25:00Z')")).rows;
    assert.ok(restoredObservations.length > 0 && restoredObservations.length <= 28);
    assert.ok(restoredObservations.every(row => !Object.hasOwn(row, "owner_user_id")));
    assert.equal((await client.query("SELECT owner_user_id FROM public.members WHERE player_tag='#PLAYER'")).rows[0].owner_user_id, "private-member-owner");
    const publication = (await client.query("SELECT attnames FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='battle_history'")).rows[0];
    assert.equal(publication.attnames.includes("owner_user_id"), false);
    assert.equal((await client.query("SELECT notes FROM public.member_reviews WHERE player_tag='#PLAYER'")).rows[0].notes, "ملاحظة خاصة".repeat(50000));
    assert.equal((await client.query("INSERT INTO public.profiles(id,owner_user_id) VALUES('second','new-owner') RETURNING code::text")).rows[0].code, "2");
    await assert.rejects(client.query("INSERT INTO public.user_clubs(id,club_id) VALUES (10,'00000000-0000-4000-8000-000000000099')"), error => error.code === "23503");
    for (const role of ["anon", "authenticated"]) {
      await client.query("SET ROLE " + role);
      try {
        assert.equal((await client.query("SELECT player_tag FROM public.member_history")).rowCount, 1);
        await assert.rejects(client.query("SELECT notes FROM public.member_history"), error => error.code === "42501");
        await assert.rejects(client.query("SELECT * FROM public.member_reviews"), error => error.code === "42501");
        for (const name of ["sync_battle_coverage", "sync_battle_gaps", "capacity_samples", "sync_ranked_fallback_attempts", "player_profile_details", "player_brawler_details", "player_ranked_history", "game_api_cache", "recruitment_candidates"]) await assert.rejects(client.query(`SELECT * FROM public.${name}`), error => error.code === "42501");
        for(const name of clubFeatureTables){
          await assert.rejects(client.query(`SELECT * FROM public.${name}`),error=>error.code==='42501');
          await assert.rejects(client.query(`DELETE FROM public.${name}`),error=>error.code==='42501');
        }
        for (const name of archiveTables) {
          await assert.rejects(client.query(`SELECT * FROM public.${name}`), error => error.code === '42501');
          await assert.rejects(client.query(`DELETE FROM public.${name}`), error => error.code === '42501');
          await assert.rejects(client.query(`TRUNCATE public.${name}`), error => error.code === '42501');
        }
        for (const fn of backup.manifest.functions.filter(item => archiveRpcNames.includes(item.name))) {
          assert.equal((await client.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed", [fn.identity])).rows[0].allowed, false, `${role} cannot invoke ${fn.name}`);
        }
        for(const query of ["SELECT public.member_inactivity_exempt('#CLUB','#PLAYER',now())","SELECT public.club_intelligence_read(7,now())","SELECT public.club_planning_refresh_goals('#CLUB')","SELECT public.claim_club_rival('#PYLQ','#GGRR','00000000-0000-4000-8000-000000000001')","SELECT public.member_comparison_read('#CLUB',7,now())","SELECT public.club_event_observations_read('#CLUB','00000000-0000-4000-8000-000000000131',now())"])
          await assert.rejects(client.query(query),error=>error.code==='42501');
        for(const query of ["SELECT public.claim_mega_pig_source_cache('#PYLQ','00000000-0000-4000-8000-000000000038')",
          "SELECT public.claim_mega_pig_brawltools_cache('#PYLQ','00000000-0000-4000-8000-000000000038')",
          "SELECT public.claim_mega_pig_provider_cache('#PYLQ','00000000-0000-4000-8000-000000000038','BrawlTools')",
          "SELECT public.finish_mega_pig_source_cache('#PYLQ','00000000-0000-4000-8000-000000000038',NULL,'unavailable',NULL)"])
          await assert.rejects(client.query(query),error=>error.code==='42501');
        assert.deepEqual(Object.keys((await client.query("SELECT * FROM public.club_sync_signals")).rows[0]).sort(),['completed_at','datasets','id','version']);
        await assert.rejects(client.query('UPDATE public.club_sync_signals SET version=NULL,completed_at=NULL'),error=>error.code==='42501');
        for(const rpc of ['report_dashboard_read','report_leaderboard_read']) await assert.rejects(client.query(`SELECT public.${rpc}(7,now())`),error=>error.code==='42501');
        await assert.rejects(client.query("SELECT public.sample_database_capacity()"), error => error.code === "42501");
        for(const query of ["SELECT * FROM public.battle_feed_page(ARRAY['#PLAYER'],now()-interval '1 day',now())","SELECT public.battle_feed_facets(ARRAY['#PLAYER'],now()-interval '1 day',now())"]){
          await assert.rejects(client.query(query),error=>error.code==="42501");
        }
        for (const query of ["SELECT * FROM public.sync_activity_summary_v2(ARRAY['#PLAYER'])", "SELECT * FROM public.report_account_trophy_trend(ARRAY['#PLAYER'],90)", "SELECT * FROM public.report_member_activity_history('#PLAYER',90)"]) {
          await assert.rejects(client.query(query), error => error.code === "42501");
        }
        await assert.rejects(client.query("SELECT public.create_backup_snapshot($1)", [randomUUID()]), error => error.code === "42501");
      } finally { await client.query("RESET ROLE"); }
    }
    await client.query("SET ROLE service_role");
    try {
      assert.equal((await client.query("SELECT * FROM public.consume_admin_login_attempt(repeat('a',64))")).rows[0].allowed, true);
      assert.equal((await client.query("SELECT * FROM public.capacity_samples")).rowCount, 1);
      assert.deepEqual((await client.query("SELECT payload,previous_payload FROM public.club_mega_pig_source_cache WHERE club_tag='#PYLQ'")).rows[0],{payload:sourcePayload,previous_payload:previousSourcePayload});
      await assert.rejects(client.query("UPDATE public.club_mega_pig_source_cache SET payload=NULL WHERE club_tag='#PYLQ'"),error=>error.code==='42501');
      for (const name of archiveTables) {
        assert.deepEqual((await client.query(`SELECT to_jsonb(t) AS row FROM public.${name} t ORDER BY to_jsonb(t)::text`)).rows.map(item => item.row), savedArchive.get(name));
        await assert.rejects(client.query(`DELETE FROM public.${name}`), error => error.code === '42501');
        assert.equal((await client.query("SELECT has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE') allowed", [`public.${name}`])).rows[0].allowed, false, `Service role can only read ${name} directly`);
      }
      for (const fn of backup.manifest.functions.filter(item => archiveRpcNames.includes(item.name))) {
        assert.equal((await client.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed", [fn.identity])).rows[0].allowed, ['mega_pig_archive_read', 'mega_pig_archive_write'].includes(fn.name), `Restored service access matches the public RPC boundary for ${fn.name}`);
      }
      for (const fn of backup.manifest.functions.filter(item => sourceRpcNames.includes(item.name))) {
        assert.equal((await client.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed", [fn.identity])).rows[0].allowed,
          fn.name !== 'claim_mega_pig_provider_cache', `Restored service access preserves the provider RPC boundary for ${fn.name}`);
      }
      await assert.rejects(client.query("SELECT public.sample_database_capacity()"), error => error.code === "42501");
    }
    finally { await client.query("RESET ROLE"); }
  });

  await t.test("restored provider cache procedures remain service-only and can claim and finish atomically",async()=>{
    await client.query("BEGIN");
    try{
      await client.query("UPDATE public.settings SET value='#PYLQ' WHERE key='club_tag'; UPDATE public.club_mega_pig_source_cache SET next_check_at=now()-interval '1 hour',lease_token=NULL,lease_expires_at=NULL WHERE club_tag='#PYLQ'");
      await client.query("SET LOCAL ROLE service_role");
      const token=randomUUID();
      assert.equal((await client.query("SELECT public.claim_mega_pig_source_cache('#PYLQ',$1) AS result",[randomUUID()])).rows[0].result.acquired,false);
      const claimed=(await client.query("SELECT public.claim_mega_pig_brawltools_cache('#PYLQ',$1) AS result",[token])).rows[0].result;
      assert.equal(claimed.acquired,true);assert.equal(Object.hasOwn(claimed.entry,'lease_token'),false);
      const toolsPayload={...sourcePayload,source:'BrawlTools',reportedPlayersPlayed:null,reportedBattlesPlayed:128};
      const finished=(await client.query("SELECT public.finish_mega_pig_source_cache('#PYLQ',$1,$2::jsonb) AS result",[token,JSON.stringify(toolsPayload)])).rows[0].result;
      assert.equal(finished.accepted,true);assert.deepEqual(finished.entry.payload,toolsPayload);assert.deepEqual(finished.entry.previous_payload,sourcePayload);
      assert.equal(finished.entry.source_provider,'BrawlTools');assert.deepEqual(finished.entry.previous_provider_state,savedSourceCache.previous_provider_state);
      assert.equal(finished.entry.error_code,null);assert.equal(finished.entry.consecutive_failures,0);assert.equal(Object.hasOwn(finished.entry,'lease_token'),false);
    }finally{await client.query("ROLLBACK");}
    assert.deepEqual((await client.query("SELECT to_jsonb(cache) AS entry FROM public.club_mega_pig_source_cache cache WHERE club_tag='#PYLQ'")).rows[0].entry,savedSourceCache,'Procedure verification must not change the restored snapshot');
  });

  await t.test("restored archive RPCs retain departed members and confirmed outcomes with version-checked corrections", async () => {
    await client.query('BEGIN');
    try {
      await client.query("UPDATE public.settings SET value='#PYLQ' WHERE key='club_tag'; SET LOCAL ROLE service_role");
      const cycle = (await client.query("SELECT public.mega_pig_archive_read('#PYLQ','cycle',$1,NULL,0) value", [archiveCycleId])).rows[0].value;
      assert.equal(cycle.cycle.confirmed_stage, 5); assert.equal(cycle.cycle.final_total_wins, 80); assert.equal(cycle.cycle.reward_status, 'received');
      assert.equal(cycle.members.length, 1); assert.equal(cycle.members[0].is_current_member, false);
      assert.equal(cycle.members[0].wins, 3); assert.equal(cycle.members[0].tickets_remaining, null);
      assert.equal(Object.hasOwn(cycle.cycle, 'request_id'), false); assert.equal(Object.hasOwn(cycle.cycle, 'create_payload'), false);
      const reading = (await client.query("SELECT public.mega_pig_archive_read('#PYLQ','reading',$1,NULL,0) value", [archiveObservationId])).rows[0].value;
      assert.deepEqual(reading.observation.payload, archivedPayload); assert.equal(reading.observation.unknown_members, 1);
      const history = (await client.query("SELECT public.mega_pig_archive_read('#PYLQ','player',NULL,'#GGRR',0) value")).rows[0].value;
      assert.equal(history.history.length, 1); assert.equal(history.history[0].cycle.id, archiveCycleId);
      const correction = { id: archiveCycleId, version: 2, reason: 'تصحيح مؤرخ لا يمحو التأكيد السابق' };
      const reopened = (await client.query("SELECT public.mega_pig_archive_write('#PYLQ','reopen_cycle',$1::jsonb) value", [JSON.stringify(correction)])).rows[0].value;
      assert.equal(reopened.version, 3);
      const updated = (await client.query("SELECT public.mega_pig_archive_read('#PYLQ','cycle',$1,NULL,0) value", [archiveCycleId])).rows[0].value;
      assert.equal(updated.cycle.finalized_at, null); assert.equal(updated.cycle.reward_status, 'unknown');
      assert.equal((await client.query('SELECT count(*)::int n FROM public.club_mega_pig_cycle_revisions WHERE cycle_id=$1', [archiveCycleId])).rows[0].n, 2);
      await client.query('SAVEPOINT stale_archive_revision');
      await assert.rejects(client.query("SELECT public.mega_pig_archive_write('#PYLQ','reopen_cycle',$1::jsonb)", [JSON.stringify(correction)]), error => error.code === '40001');
      await client.query('ROLLBACK TO SAVEPOINT stale_archive_revision');
    } finally { await client.query('ROLLBACK'); }
    for (const table of archiveTables) {
      assert.deepEqual((await client.query(`SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows.map(item => item.row), savedArchive.get(table), 'Archive procedure rehearsal must not alter the restored snapshot');
    }
  });

  await t.test("restored maintenance definitions keep the extra day required by90-day comparisons", async () => {
    for (const cleanup of ["run_sync_maintenance", "cleanup_old_activity_logs"]) {
      await client.query("BEGIN");
      try {
        await client.query("INSERT INTO activity_log(player_tag,trophies,recorded_at) VALUES('#PLAYER',29000,now()-interval '90 days 12 hours'),('#PLAYER',28000,now()-interval '92 days')");
        await client.query(`SELECT public.${cleanup}()`);
        assert.equal((await client.query("SELECT trophies_90d FROM public.sync_activity_summary_v2(ARRAY['#PLAYER'],now())")).rows[0].trophies_90d,1000);
        assert.equal((await client.query("SELECT count(*)::int n FROM activity_log WHERE recorded_at<now()-interval '91 days'")).rows[0].n,0);
      } finally { await client.query("ROLLBACK"); }
    }
  });
});
