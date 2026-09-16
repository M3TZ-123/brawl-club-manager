const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client, Pool } = require("pg");

const sourceUrl = process.env.CAPACITY_TEST_DATABASE_URL || process.env.SECURITY_TEST_DATABASE_URL;
const root = path.resolve(__dirname, "../..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/202609160010_capacity_monitor.sql"), "utf8");

function loopback(client) {
  const peer = client.connection?.stream?.remoteAddress?.replace(/^::ffff:/i, "");
  assert.ok(peer === "127.0.0.1" || peer === "::1", "A local test PostgreSQL transport is required");
}

test("capacity sampling measures real local storage and enforces private, bounded alerts", { skip: !sourceUrl }, async t => {
  const target = new URL(sourceUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  assert.match(target.pathname, /^\/brawl_(capacity|security)_tests$/);
  assert.equal(target.search, ""); assert.equal(target.hash, "");
  target.pathname = "/postgres";
  const admin = new Client({ connectionString: target.href });
  await admin.connect();
  try {
    loopback(admin);
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_capacity_tests'")).rowCount) {
      await admin.query("CREATE DATABASE brawl_capacity_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
    }
  } finally { await admin.end(); }
  target.pathname = "/brawl_capacity_tests";
  const db = new Client({ connectionString: target.href });
  await db.connect(); t.after(() => db.end()); loopback(db);
  assert.equal((await db.query("SELECT current_database() name,pg_encoding_to_char(encoding) encoding FROM pg_database WHERE datname=current_database()")).rows[0].encoding, "UTF8");
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role");
  for (const file of ["supabase/schema.sql", "supabase/migrations/202609160001_sync_durability.sql", "supabase/migrations/202609160002_admin_privacy.sql"]) {
    await db.query(fs.readFileSync(path.join(root, file), "utf8"));
  }
  await db.query(migration);
  const sample = async () => (await db.query("SELECT public.sample_database_capacity() result")).rows[0].result;
  const latest = async () => (await db.query("SELECT * FROM public.capacity_samples ORDER BY sampled_at DESC LIMIT 1")).rows[0];
  const counts = async () => (await db.query("SELECT (SELECT count(*)::int FROM notifications WHERE type='capacity') notifications,(SELECT count(*)::int FROM notification_outbox WHERE event_key LIKE 'capacity:%') outbox")).rows[0];
  const setting = (key, value) => db.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, String(value)]);
  async function targetPercent(percent) {
    const bytes = BigInt((await db.query("SELECT pg_database_size(current_database()) bytes")).rows[0].bytes);
    await setting("capacity_budget_bytes", (bytes * 100n / BigInt(percent)).toString());
  }
  async function asRole(role, sql) {
    assert.ok(["anon", "authenticated", "service_role"].includes(role));
    await db.query("BEGIN");
    try { await db.query(`SET LOCAL ROLE ${role}`); return await db.query(sql); }
    finally { await db.query("ROLLBACK"); }
  }

  await t.test("defaults use the operational500MB budget and low storage creates no alert", async () => {
    assert.equal((await db.query("SELECT value FROM settings WHERE key='capacity_budget_bytes'")).rows[0].value, "500000000");
    await setting("notifications_enabled", true); await setting("sync_scheduler_enabled", false);
    const result = await sample(); const row = await latest();
    assert.equal(result.sampled, true); assert.equal(result.level, "normal"); assert.equal(result.alertEnqueued, false);
    assert.ok(BigInt(row.database_bytes) > 0n); assert.ok(BigInt(row.database_bytes) < 350000000n);
    assert.ok(!Object.hasOwn(result, "database_bytes")); assert.deepEqual(await counts(), { notifications: 0, outbox: 0 });
    assert.equal((await db.query("SELECT count(*)::int n FROM pg_extension WHERE extname='pg_cron'")).rows[0].n, 0);
  });

  await t.test("exact thresholds use numeric arithmetic and reject invalid measurements", async () => {
    for (const [used, expected] of [[0, "normal"], [349999999, "normal"], [350000000, "warning"], [449999999, "warning"], [450000000, "critical"], [600000000, "critical"]]) {
      assert.equal((await db.query("SELECT public.capacity_usage_level($1,500000000) level", [used])).rows[0].level, expected);
    }
    await assert.rejects(db.query("SELECT public.capacity_usage_level(-1,500000000)"), error => error.code === "22023");
    await assert.rejects(db.query("SELECT public.capacity_usage_level(1,0)"), error => error.code === "22023");
    assert.equal((await db.query("SELECT public.capacity_usage_level(9223372036854775807,9223372036854775807) level")).rows[0].level, "critical");
  });

  await t.test("warnings deduplicate; critical escalation is immediate; recovery does not spam", async () => {
    await targetPercent(75);
    const first = await sample(); assert.equal(first.level, "warning"); assert.equal(first.alertEnqueued, true);
    const warning = await latest();
    assert.equal((await sample()).alertEnqueued, false); assert.deepEqual(await counts(), { notifications: 1, outbox: 1 });
    await targetPercent(95);
    assert.equal((await sample()).alertEnqueued, true); assert.equal((await latest()).last_alert_level, "critical");
    assert.deepEqual(await counts(), { notifications: 2, outbox: 2 });
    await targetPercent(25); const recovery = await sample();
    assert.equal(recovery.level, "normal"); assert.equal(recovery.alertEnqueued, false);
    await targetPercent(75); assert.equal((await sample()).alertEnqueued, false);
    await targetPercent(95); assert.equal((await sample()).alertEnqueued, false);
    assert.deepEqual(await counts(), { notifications: 2, outbox: 2 });
    assert.ok((await latest()).last_alert_at >= warning.last_alert_at);
    const publicRows = await asRole("anon", "SELECT type,title,message FROM notifications WHERE type='capacity'");
    assert.equal(publicRows.rowCount, 2); assert.ok(publicRows.rows.every(row => !/[0-9%]/.test(row.message)));
    const payloads = (await db.query("SELECT payload::text payload FROM notification_outbox WHERE event_key LIKE 'capacity:%'")).rows;
    assert.ok(payloads.every(row => row.payload.includes("بايت") && row.payload.includes("ليست قياسًا لحصة المزود")));
  });

  await t.test("ongoing alerts repeat only after24 hours and state survives UTC day boundaries", async () => {
    await db.query("UPDATE capacity_samples SET last_alert_at=clock_timestamp()-interval '23 hours 59 minutes'");
    assert.equal((await sample()).alertEnqueued, false);
    await db.query("UPDATE capacity_samples SET sample_date=(clock_timestamp() AT TIME ZONE 'UTC')::date-1,sampled_at=clock_timestamp()-interval '1 day',last_alert_at=clock_timestamp()-interval '25 hours'");
    const previous = await latest(); assert.equal(previous.last_alert_level, "critical");
    const reminder = await sample(); assert.equal(reminder.alertEnqueued, true);
    assert.equal((await latest()).last_alert_level, "critical");
    assert.equal((await db.query("SELECT count(*)::int n FROM capacity_samples")).rows[0].n, 2);
    assert.equal((await sample()).alertEnqueued, false); assert.deepEqual(await counts(), { notifications: 3, outbox: 3 });
  });

  await t.test("sampling respects notification disablement while remaining independent of sync pause", async () => {
    await setting("notifications_enabled", false);
    await db.query("UPDATE capacity_samples SET last_alert_at=clock_timestamp()-interval '25 hours'");
    const before = await counts(); const disabled = await sample();
    assert.equal(disabled.sampled, true); assert.equal(disabled.level, "critical"); assert.equal(disabled.alertEnqueued, false);
    assert.deepEqual(await counts(), before);
    await setting("notifications_enabled", true);
    assert.equal((await sample()).alertEnqueued, true);
    assert.equal((await db.query("SELECT value FROM settings WHERE key='sync_scheduler_enabled'")).rows[0].value, "false");
  });

  await t.test("concurrent owner sampling cannot duplicate alerts or rows", async () => {
    await db.query("UPDATE capacity_samples SET last_alert_at=clock_timestamp()-interval '25 hours'");
    const before = await counts(); const pool = new Pool({ connectionString: target.href, max: 6 });
    let results;
    try { results = await Promise.all(Array.from({ length: 6 }, () => pool.query("SELECT public.sample_database_capacity() result"))); }
    finally { await pool.end(); }
    assert.equal(results.filter(result => result.rows[0].result.alertEnqueued).length, 1);
    assert.deepEqual(await counts(), { notifications: before.notifications + 1, outbox: before.outbox + 1 });
    assert.equal((await db.query("SELECT count(*)::int n FROM capacity_samples WHERE sample_date=(clock_timestamp() AT TIME ZONE 'UTC')::date")).rows[0].n, 1);
  });

  await t.test("public roles cannot inspect sizes or invoke measurements; service role can only read", async () => {
    assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.capacity_samples'::regclass")).rows[0].relrowsecurity, true);
    for (const role of ["anon", "authenticated", "service_role"]) {
      await assert.rejects(asRole(role, "SELECT public.sample_database_capacity()"), error => error.code === "42501");
      await assert.rejects(asRole(role, "SELECT public.capacity_usage_level(1,2)"), error => error.code === "42501");
      await assert.rejects(asRole(role, "DELETE FROM capacity_samples"), error => error.code === "42501");
      await assert.rejects(asRole(role, "UPDATE capacity_samples SET database_bytes=0"), error => error.code === "42501");
      await assert.rejects(asRole(role, "INSERT INTO capacity_samples(sample_date,sampled_at,database_bytes,peak_database_bytes,budget_bytes,level) VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,clock_timestamp(),0,0,1,'normal')"), error => error.code === "42501");
      if (role !== "service_role") {
        await assert.rejects(asRole(role, "SELECT database_bytes FROM capacity_samples"), error => error.code === "42501");
        assert.equal((await asRole(role, "SELECT value FROM settings WHERE key='capacity_budget_bytes'")).rowCount, 0);
      }
    }
    assert.ok((await asRole("service_role", "SELECT database_bytes FROM capacity_samples")).rowCount > 0);
  });

  await t.test("invalid budgets do not emit false alerts or replace the previous measurement", async () => {
    const before = await latest(); const alerts = await counts();
    for (const budget of ["invalid", "0", "-10", "9999999999999999999999999999999"]) {
      await setting("capacity_budget_bytes", budget);
      await assert.rejects(sample(), error => error.code === "22023" && error.message === "invalid_capacity_budget");
      assert.deepEqual(await latest(), before); assert.deepEqual(await counts(), alerts);
    }
    await setting("capacity_budget_bytes", 500000000);
  });

  await t.test("retention caps only the new daily metric table and preserves historical application data", async () => {
    await db.query("INSERT INTO member_history(player_tag,player_name,first_seen,notes) VALUES('#KEPT','Historical member','2000-01-01','private history'); INSERT INTO members(player_tag,player_name) VALUES('#KEPT','Historical member'); INSERT INTO activity_log(player_tag,trophies,recorded_at) VALUES('#KEPT',100,'2000-01-01')");
    await db.query("INSERT INTO capacity_samples(sample_date,sampled_at,database_bytes,peak_database_bytes,budget_bytes,level) SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date-i,((clock_timestamp() AT TIME ZONE 'UTC')::date-i)::timestamp AT TIME ZONE 'UTC',1,1,500000000,'normal' FROM generate_series(2,150) i ON CONFLICT DO NOTHING");
    await db.query("UPDATE capacity_samples SET peak_database_bytes=999999999 WHERE sample_date=(clock_timestamp() AT TIME ZONE 'UTC')::date");
    await sample(); const row = await latest(); assert.equal(row.peak_database_bytes, "999999999");
    assert.equal((await db.query("SELECT count(*)::int n FROM capacity_samples")).rows[0].n, 90);
    assert.equal((await db.query("SELECT notes FROM member_history WHERE player_tag='#KEPT'")).rows[0].notes, "private history");
    assert.equal((await db.query("SELECT count(*)::int n FROM activity_log WHERE recorded_at='2000-01-01'")).rows[0].n, 1);
    await db.query(migration); assert.equal((await db.query("SELECT count(*)::int n FROM capacity_samples")).rows[0].n, 90);
  });
});
