const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const sourceUrl = process.env.REPORTING_TEST_DATABASE_URL || process.env.SECURITY_TEST_DATABASE_URL;
const root = path.resolve(__dirname, "../..");
const now = "2026-09-16T12:00:00.000Z";
const before = days => new Date(Date.parse(now) - days * 86_400_000).toISOString();

test("range reporting uses real account baselines with private, bounded SQL queries", { skip: !sourceUrl }, async t => {
  const target = new URL(sourceUrl);
  assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  assert.match(target.pathname, /^\/brawl_(reporting|security)_tests$/);
  assert.equal(target.search, ""); assert.equal(target.hash, "");
  const loopback = db => assert.ok(["127.0.0.1", "::1"].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/i, "")));
  target.pathname = "/postgres";
  const admin = new Client({ connectionString: target.href });
  await admin.connect();
  try {
    loopback(admin);
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_reporting_tests'")).rowCount) {
      await admin.query("CREATE DATABASE brawl_reporting_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
    }
  } finally { await admin.end(); }
  target.pathname = "/brawl_reporting_tests";
  const db = new Client({ connectionString: target.href });
  await db.connect(); t.after(() => db.end()); loopback(db);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role");
  for (const file of ["supabase/schema.sql", "supabase/migrations/202609160001_sync_durability.sql", "supabase/migrations/202609160012_reporting_ranges.sql"]) {
    await db.query(fs.readFileSync(path.join(root, file), "utf8"));
  }
  const maintenancePermissions = (await db.query("SELECT proname,prosecdef,proacl::text FROM pg_proc WHERE oid IN ('public.run_sync_maintenance()'::regprocedure,'public.cleanup_old_activity_logs()'::regprocedure) ORDER BY proname")).rows;
  const retentionMigration = fs.readFileSync(path.join(root,"supabase/migrations/202609160013_activity_baseline_retention.sql"),"utf8");
  await db.query(retentionMigration);
  await db.query(retentionMigration);
  assert.deepEqual((await db.query("SELECT proname,prosecdef,proacl::text FROM pg_proc WHERE oid IN ('public.run_sync_maintenance()'::regprocedure,'public.cleanup_old_activity_logs()'::regprocedure) ORDER BY proname")).rows,maintenancePermissions);
  // Reapplying the migration must preserve both function contracts.
  await db.query(fs.readFileSync(path.join(root, "supabase/migrations/202609160012_reporting_ranges.sql"), "utf8"));
  await db.query("ALTER TABLE activity_log ADD COLUMN owner_user_id uuid");
  const reset = async () => {
    await db.query("TRUNCATE members,activity_log,member_activity_state,battle_history CASCADE");
    await db.query("INSERT INTO members(player_tag,player_name,trophies) VALUES('#A','علي',1000),('#B','B',2000),('#FORMER','Former',5000)");
  };
  const observe = (tag, trophies, timestamp) => db.query("INSERT INTO activity_log(player_tag,trophies,recorded_at) VALUES($1,$2,$3)", [tag, trophies, timestamp]);
  const summary = async (tags = ["#A", "#B"]) => (await db.query("SELECT * FROM sync_activity_summary_v2($1,$2)", [tags, now])).rows;

  await t.test("all five ranges compare stored account balances and preserve the original RPC shape", async () => {
    await reset();
    for (const days of [1,3,7,30,90]) await observe("#A", 1000 - days * 2, before(days));
    await db.query("INSERT INTO member_activity_state(player_tag,last_battle_at,last_activity_at) VALUES('#A',$1,$1)", [now]);
    await db.query("INSERT INTO battle_history(player_tag,battle_time,mode,result,trophy_change) VALUES('#B',$1,'brawlBall','victory',999)", [before(1)]);
    const rows = await summary(); const a = rows.find(row => row.player_tag === "#A"), b = rows.find(row => row.player_tag === "#B");
    for (const [key, days] of [["24h",1],["3d",3],["7d",7],["30d",30],["90d",90]]) {
      assert.equal(a[`trophies_${key}`], days * 2);
      assert.equal(Date.parse(a.trophy_baselines[key]), Date.parse(before(days)));
      assert.equal(b[`trophies_${key}`], null, "Battle net must not substitute for missing account balances");
    }
    assert.equal(a.last_battle_at.toISOString(), now);
    const legacy = (await db.query("SELECT * FROM sync_activity_summary(ARRAY['#A'],$1)", [now])).rows[0];
    assert.deepEqual(Object.keys(legacy), ["player_tag","last_battle_at","last_activity_at","trophies_24h","trophies_3d","trophies_7d"]);
    assert.equal(legacy.trophies_7d, 14);
  });

  await t.test("a later or excessively stale baseline never claims a complete30-day period", async () => {
    await reset();
    await observe("#A", 900, before(30 + 1/48));
    await observe("#A", 950, before(30 - 1/1440));
    await observe("#B", 1900, before(31 + 1/86400));
    await observe("#B", 1990, before(30 - 1/1440));
    const rows = await summary();
    assert.equal(rows.find(row => row.player_tag === "#A").trophies_30d, 100);
    assert.equal(rows.find(row => row.player_tag === "#B").trophies_30d, null);
    assert.ok(rows.every(row => row.trophies_90d === null));
  });

  await t.test("daily trend uses actual selected-member balances, excludes future data and marks gaps", async () => {
    await reset();
    await observe("#A", 800, "2026-09-15T23:50:00Z");
    await observe("#B", 1800, "2026-09-15T23:55:00Z");
    await observe("#A", 1000, now);
    await observe("#B", 2000, now);
    await observe("#FORMER", 5000, now);
    await observe("#A", 9999, "2026-09-16T12:00:01Z");
    const trend = (await db.query("SELECT date::text,trophies,observed_members,total_members FROM report_account_trophy_trend($1,3,$2)", [["#A","#B"], now])).rows;
    assert.deepEqual(trend, [
      { date:"2026-09-14", trophies:null, observed_members:0,total_members:2 },
      { date:"2026-09-15", trophies:"2600", observed_members:2,total_members:2 },
      { date:"2026-09-16", trophies:"3000", observed_members:2,total_members:2 },
    ]);
    await db.query("DELETE FROM activity_log WHERE player_tag='#B'");
    const partial = (await db.query("SELECT * FROM report_account_trophy_trend($1,1,$2)", [["#A","#B"],now])).rows[0];
    assert.equal(partial.trophies, null); assert.equal(partial.observed_members, 1);
    const empty = (await db.query("SELECT * FROM report_account_trophy_trend('{}',1,$1)", [now])).rows[0];
    assert.equal(empty.trophies, null); assert.equal(empty.total_members, 0);
  });

  await t.test("90-day minute-level history produces at most90 real chart observations and no private columns", async () => {
    await reset();
    await db.query("INSERT INTO activity_log(player_tag,trophies,recorded_at,owner_user_id) SELECT '#A',1000+i%100,$1::timestamptz-i*interval '1 minute','00000000-0000-0000-0000-000000000001' FROM generate_series(0,90*24*60) i", [now]);
    for (const [days, cap] of [[1,24],[3,24],[7,28],[30,30],[90,90]]) {
      const rows = (await db.query("SELECT * FROM report_member_activity_history('#A',$1,$2)", [days,now])).rows;
      assert.ok(rows.length <= cap); assert.ok(rows.length > 0);
      assert.equal(rows[0].recorded_at.toISOString(), now);
      assert.deepEqual(Object.keys(rows[0]), ["id","player_tag","trophies","trophy_change","activity_type","recorded_at"]);
      assert.ok(rows.every(row => row.trophies >= 1000 && row.trophies < 1100));
    }
  });

  await t.test("service-only RPC permissions and bounded input remain enforced", async () => {
    for (const role of ["anon","authenticated"]) {
      await db.query("BEGIN");
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(db.query("SELECT * FROM sync_activity_summary_v2(ARRAY['#A'])"), error => error.code === "42501");
      } finally { await db.query("ROLLBACK"); }
      for (const query of ["SELECT * FROM report_account_trophy_trend(ARRAY['#A'],7)", "SELECT * FROM report_member_activity_history('#A',7)"]) {
        await db.query("BEGIN");
        try { await db.query(`SET LOCAL ROLE ${role}`); await assert.rejects(db.query(query), error => error.code === "42501"); }
        finally { await db.query("ROLLBACK"); }
      }
    }
    await db.query("BEGIN; SET LOCAL ROLE service_role");
    try { assert.equal((await db.query("SELECT * FROM sync_activity_summary_v2(ARRAY['#A'],$1)", [now])).rowCount, 1); }
    finally { await db.query("ROLLBACK"); }
    await assert.rejects(db.query("SELECT * FROM report_account_trophy_trend(ARRAY['#A'],91)"), error => error.code === "22023");
    await assert.rejects(db.query("SELECT * FROM report_member_activity_history('#A',1000)"), error => error.code === "22023");
  });

  await t.test("both cleanup paths retain90-day account baselines, keep the91-day boundary and prune only older activity", async () => {
    for (const cleanup of ["run_sync_maintenance", "cleanup_old_activity_logs"]) {
      await reset();
      await db.query("BEGIN");
      try {
        await db.query(`INSERT INTO activity_log(player_tag,trophies,recorded_at) VALUES
          ('#A',900,now()-interval '90 days 12 hours'),
          ('#A',800,now()-interval '91 days'-interval '1 microsecond'),
          ('#B',1900,now()-interval '91 days')`);
        const before = (await db.query("SELECT player_tag,trophies_90d FROM sync_activity_summary_v2(ARRAY['#A','#B'],now()) ORDER BY player_tag")).rows;
        assert.deepEqual(before,[{player_tag:"#A",trophies_90d:100},{player_tag:"#B",trophies_90d:100}]);
        const result = (await db.query(`SELECT public.${cleanup}() result`)).rows[0].result;
        if(cleanup==="run_sync_maintenance") assert.equal(result.activity,1);
        assert.deepEqual((await db.query("SELECT trophies FROM activity_log ORDER BY trophies")).rows,[{trophies:900},{trophies:1900}]);
        assert.deepEqual((await db.query("SELECT player_tag,trophies_90d FROM sync_activity_summary_v2(ARRAY['#A','#B'],now()) ORDER BY player_tag")).rows,before);
      } finally { await db.query("ROLLBACK"); }
    }
  });

  await t.test("canonical cleanup keeps its advisory guard, other retentions and exhausted-delivery handling", async () => {
    await reset();
    await db.query("TRUNCATE daily_stats,brawler_snapshots,notifications,notification_outbox CASCADE");
    await db.query(`INSERT INTO activity_log(player_tag,trophies,recorded_at) VALUES('#A',900,now()-interval '90 days 12 hours'),('#A',800,now()-interval '92 days');
      INSERT INTO battle_history(player_tag,battle_time) VALUES('#A',now()-interval '90 days 12 hours'),('#A',now()-interval '89 days');
      INSERT INTO daily_stats(player_tag,date,battles) VALUES('#A',(now() AT TIME ZONE 'UTC')::date-365,1),('#A',(now() AT TIME ZONE 'UTC')::date-366,1);
      INSERT INTO brawler_snapshots(player_tag,brawler_id,brawler_name,power_level,trophies,rank,recorded_at) VALUES('#A',1,'SHELLY',1,1,1,now()-interval '90 days 12 hours'),('#A',2,'COLT',1,1,1,now()-interval '89 days');
      INSERT INTO notifications(type,title,message,dedupe_key,created_at) VALUES('join','Old','Old','retention-old',now()-interval '90 days 12 hours'),('join','Recent','Recent','retention-recent',now()-interval '89 days');
      INSERT INTO notification_outbox(event_key,payload,status,delivered_at,attempts,locked_until) VALUES
        ('old-sent','{}','sent',now()-interval '90 days 12 hours',1,NULL),
        ('recent-sent','{}','sent',now()-interval '89 days',1,NULL),
        ('exhausted','{}','in_flight',NULL,8,now()-interval '1 minute')`);
    const locker = new Client({connectionString:target.href});
    await locker.connect();
    try {
      await locker.query("BEGIN; SELECT pg_advisory_xact_lock(702946183)");
      assert.deepEqual((await db.query("SELECT run_sync_maintenance() result")).rows[0].result,{skipped:true});
      assert.equal((await db.query("SELECT count(*)::int n FROM activity_log")).rows[0].n,2);
      assert.equal((await db.query("SELECT status FROM notification_outbox WHERE event_key='exhausted'")).rows[0].status,"in_flight");
    } finally { await locker.query("ROLLBACK"); await locker.end(); }
    const result = (await db.query("SELECT run_sync_maintenance() result")).rows[0].result;
    assert.deepEqual(result,{battles:1,dailyStats:1,activity:1,snapshots:1,notifications:1});
    assert.equal((await db.query("SELECT trophies_90d FROM sync_activity_summary_v2(ARRAY['#A'])")).rows[0].trophies_90d,100);
    assert.equal((await db.query("SELECT count(*)::int n FROM notification_outbox WHERE event_key='old-sent'")).rows[0].n,0);
    assert.equal((await db.query("SELECT count(*)::int n FROM notification_outbox WHERE event_key='recent-sent'")).rows[0].n,1);
    assert.deepEqual((await db.query("SELECT status,last_error_code,locked_by,locked_until FROM notification_outbox WHERE event_key='exhausted'")).rows[0],{status:"failed",last_error_code:"delivery_lease_expired",locked_by:null,locked_until:null});
    await db.query("BEGIN; SET LOCAL ROLE anon");
    try { await assert.rejects(db.query("SELECT run_sync_maintenance()"),error=>error.code==="42501"); }
    finally { await db.query("ROLLBACK"); }
  });
});
