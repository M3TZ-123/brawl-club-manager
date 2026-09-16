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
    INSERT INTO public.settings(key,value) VALUES('club_tag','#CLUB') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
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
  `);
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
    assert.ok(manifest.tables.find(table => table.name === "profiles").columns.some(column => column.name === "owner_user_id"));
    assert.ok((await client.query("SELECT max(octet_length(payload)) AS size FROM public.backup_chunks")).rows[0].size < 1024 * 1024);
    assert.ok(manifest.tables.find(table => table.name === "member_reviews").chunks.length > 1, "Large Arabic record must split safely");
    // The original rows can change after the transaction; snapshot chunks remain immutable.
    await client.query("UPDATE public.members SET trophies=99999 WHERE player_tag='#PLAYER'");
    receipt = await writeEncryptedBackup(manifest, async (table, index) => (await client.query("SELECT payload,sha256,byte_count FROM public.backup_chunks WHERE snapshot_id=$1 AND table_name=$2 AND chunk_index=$3", [snapshotId, table, index])).rows[0], output, key);
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
    const result = await restoreBackup(backup, connectionString);
    assert.equal(result.verified, true);
    const restoredBattle = (await client.query("SELECT trophy_change,trophy_change_reported,battle_type,event_id,event_mode_id,battle_mode,event_mode,placement_rank FROM public.battle_history")).rows[0];
    assert.deepEqual(restoredBattle,{trophy_change:null,trophy_change_reported:false,battle_type:"soloRanked",event_id:15001280,event_mode_id:38,battle_mode:"duoShowdown",event_mode:"trioShowdown",placement_rank:3});
    const restoredBattlePage=(await client.query("SELECT * FROM public.battle_feed_page(ARRAY['#PLAYER'],now()-interval '1 day',now())")).rows;
    assert.equal(restoredBattlePage.length,1);assert.equal(restoredBattlePage[0].mode,"trioShowdown");assert.equal(restoredBattlePage[0].event_mode_id,38);
    const restoredFacets=(await client.query("SELECT public.battle_feed_facets(ARRAY['#PLAYER'],now()-interval '1 day',now()) x")).rows[0].x;
    assert.equal(restoredFacets.total,1);assert.deepEqual(restoredFacets.contexts,[{key:"ranked",count:1}]);
    for (const name of ["sync_battle_coverage", "sync_battle_gaps", "capacity_samples", "sync_ranked_fallback_attempts", "club_sync_signals"]) assert.equal((await client.query(`SELECT count(*)::int AS n FROM public.${name}`)).rows[0].n, 1);
    const restoredRank=(await client.query("SELECT rank_current,rank_highest,ranked_points,ranked_all_time_best_points,ranked_season_best_points,ranked_source FROM public.members WHERE player_tag='#PLAYER'")).rows[0];
    assert.deepEqual(restoredRank,{rank_current:'Diamond I',rank_highest:'Mythic I',ranked_points:3417,ranked_all_time_best_points:4678,ranked_season_best_points:3505,ranked_source:'profile'});
    assert.equal((await client.query("SELECT version::text FROM public.club_sync_signals WHERE id=1")).rows[0].version,'00000000-0000-4000-8000-000000000009');
    for(const rpc of ['report_dashboard_read','report_leaderboard_read']) {
      assert.ok(Array.isArray((await client.query(`SELECT public.${rpc}(7,now()) x`)).rows[0].x.members));
    }
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
        for (const name of ["sync_battle_coverage", "sync_battle_gaps", "capacity_samples", "sync_ranked_fallback_attempts"]) await assert.rejects(client.query(`SELECT * FROM public.${name}`), error => error.code === "42501");
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
      await assert.rejects(client.query("SELECT public.sample_database_capacity()"), error => error.code === "42501");
    }
    finally { await client.query("RESET ROLE"); }
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
