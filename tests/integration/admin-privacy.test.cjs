const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Client, Pool } = require("pg");

const connectionString = process.env.SECURITY_TEST_DATABASE_URL;
const root = path.resolve(__dirname, "../..");
const privacySql = ["202609160002_admin_privacy.sql", "202609160019_login_retry_clock.sql"]
  .map(file => fs.readFileSync(path.join(root, "supabase/migrations", file), "utf8")).join("\n");
const key = value => createHash("sha256").update(value).digest("hex");

test("private reviews and login limits enforce real database permissions", { skip: !connectionString }, async t => {
  // This suite resets public only in a dedicated local test database. Never
  // accept a production/Supabase connection string or a general-purpose DB.
  const address = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(address.hostname), "Only loopback test databases are permitted");
  assert.match(address.pathname, /^\/brawl_[a-z_]+_tests$/, "Use a dedicated brawl_*_tests database");
  const client = new Client({ connectionString });
  await client.connect();
  t.after(() => client.end());
  await client.query("DROP PUBLICATION IF EXISTS supabase_realtime; DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role");
  // Reproduce Supabase-style broad default grants and older PUBLIC/column ACLs.
  await client.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role");
  await client.query(fs.readFileSync(path.join(root, "supabase/schema.sql"), "utf8"));
  for (const table of ["members", "member_history", "activity_log", "club_events", "battle_history", "brawler_snapshots", "daily_stats", "notifications", "player_tracking"]) {
    await client.query(`ALTER TABLE public.${table} ADD COLUMN owner_user_id text DEFAULT 'private-owner'; GRANT SELECT(owner_user_id) ON public.${table} TO PUBLIC,anon,authenticated`);
  }
  await client.query(`
    CREATE TABLE public.profiles (id text PRIMARY KEY, notes text);
    CREATE TABLE public.clubs (id text PRIMARY KEY, notes text);
    CREATE TABLE public.user_clubs (id text PRIMARY KEY, notes text);
    INSERT INTO public.profiles VALUES ('legacy', 'preserved');
    INSERT INTO public.clubs VALUES ('legacy', 'preserved');
    INSERT INTO public.user_clubs VALUES ('legacy', 'preserved');
    GRANT ALL ON public.member_history, public.profiles, public.clubs, public.user_clubs TO PUBLIC;
    GRANT SELECT (notes), UPDATE (notes) ON public.member_history, public.profiles, public.clubs, public.user_clubs TO anon, authenticated, PUBLIC;
    CREATE PUBLICATION supabase_realtime FOR TABLE public.member_history,public.battle_history;
  `);
  const legacyNote = `Original Arabic note ملاحظة ${"x".repeat(1001)}`;
  await client.query("INSERT INTO public.member_history(player_tag,player_name,notes) VALUES ('#PLAYER','Player',$1),('#EMPTY','Empty',''),('#NONE','None',NULL)", [legacyNote]);
  await client.query(privacySql);

  async function asRole(role, sql, values = []) {
    assert.ok(["anon", "authenticated", "service_role"].includes(role));
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL ROLE ${role}`);
      return await client.query(sql, values);
    } finally { await client.query("ROLLBACK"); }
  }
  const denied = (role, sql, values) => assert.rejects(asRole(role, sql, values), error => error.code === "42501");

  await t.test("migrates notes exactly and preserves original data", async () => {
    const saved = await client.query("SELECT player_tag,notes,status FROM public.member_reviews ORDER BY player_tag");
    assert.deepEqual(saved.rows, [{ player_tag: "#EMPTY", notes: "", status: "pending" }, { player_tag: "#PLAYER", notes: legacyNote, status: "pending" }]);
    assert.equal((await client.query("SELECT notes FROM public.member_history WHERE player_tag='#PLAYER'")).rows[0].notes, legacyNote);
    for (const table of ["profiles", "clubs", "user_clubs"]) assert.equal((await client.query(`SELECT notes FROM public.${table}`)).rows[0].notes, "preserved");
  });

  await t.test("anonymous and Supabase-authenticated tokens can read public history columns only", async () => {
    for (const role of ["anon", "authenticated"]) {
      assert.equal((await asRole(role, "SELECT player_tag,player_name FROM public.member_history")).rowCount, 3);
      await denied(role, "SELECT notes FROM public.member_history");
      await denied(role, "SELECT * FROM public.member_history");
      await denied(role, "UPDATE public.member_history SET notes='bad' WHERE player_tag='#PLAYER'");
      await denied(role, "INSERT INTO public.member_history(player_tag,player_name) VALUES ('#BAD','bad')");
      await denied(role, "DELETE FROM public.member_history WHERE player_tag='#PLAYER'");
      await denied(role, "SELECT * FROM public.member_reviews");
      await denied(role, "INSERT INTO public.member_reviews(player_tag,notes) VALUES ('#NONE','bad')");
      await denied(role, "UPDATE public.member_reviews SET notes='bad'");
      await denied(role, "DELETE FROM public.member_reviews");
      for (const table of ["members", "member_history", "activity_log", "club_events", "battle_history", "brawler_snapshots", "daily_stats", "notifications", "player_tracking"]) {
        await denied(role, `SELECT owner_user_id FROM public.${table}`);
      }
    }
    const publication = (await client.query("SELECT attnames FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='battle_history'")).rows[0];
    assert.ok(publication.attnames.includes("id"));
    assert.equal(publication.attnames.includes("owner_user_id"), false);
  });

  await t.test("legacy account tables have RLS and no inherited or column-level public access", async () => {
    for (const table of ["profiles", "clubs", "user_clubs"]) {
      assert.equal((await client.query("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [`public.${table}`])).rows[0].relrowsecurity, true);
      for (const role of ["anon", "authenticated"]) {
        await denied(role, `SELECT notes FROM public.${table}`);
        await denied(role, `INSERT INTO public.${table}(id) VALUES ('bad')`);
        await denied(role, `UPDATE public.${table} SET notes='bad'`);
        await denied(role, `DELETE FROM public.${table}`);
      }
      assert.equal((await asRole("service_role", `SELECT * FROM public.${table}`)).rowCount, 1);
    }
  });

  await t.test("service-role review edits enforce state constraints and preserve omitted values", async () => {
    await client.query("SET ROLE service_role");
    try {
      await client.query("UPDATE public.member_reviews SET status='follow_up',follow_up_at='2026-10-01T00:00:00Z' WHERE player_tag='#PLAYER'");
      const updated = await client.query("INSERT INTO public.member_reviews(player_tag,notes) VALUES ('#PLAYER','Private replacement') ON CONFLICT(player_tag) DO UPDATE SET notes=EXCLUDED.notes RETURNING status,follow_up_at,updated_at");
      assert.equal(updated.rows[0].status, "follow_up");
      assert.equal(updated.rows[0].follow_up_at.toISOString(), "2026-10-01T00:00:00.000Z");
      assert.ok(updated.rows[0].updated_at instanceof Date);
      await assert.rejects(client.query("INSERT INTO public.member_reviews(player_tag,status) VALUES ('#NONE','follow_up')"), error => error.code === "23514");
      await assert.rejects(client.query("INSERT INTO public.member_reviews(player_tag,status) VALUES ('#NONE','invalid')"), error => error.code === "23514");
      await assert.rejects(client.query("INSERT INTO public.member_reviews(player_tag) VALUES ('#UNKNOWN')"), error => error.code === "23503");
    } finally { await client.query("RESET ROLE"); }
    // Simulate publication exposure before a repeat apply; both are removed.
    await client.query("ALTER PUBLICATION supabase_realtime ADD TABLE public.member_history, public.member_reviews");
    await client.query(privacySql);
    assert.equal((await client.query("SELECT notes FROM public.member_reviews WHERE player_tag='#PLAYER'")).rows[0].notes, "Private replacement");
    assert.equal((await client.query("SELECT notes FROM public.member_history WHERE player_tag='#PLAYER'")).rows[0].notes, legacyNote);
    assert.equal((await client.query("SELECT * FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename IN ('member_history','member_reviews')")).rowCount, 0);
  });

  await t.test("public roles cannot inspect, reset, consume, or bypass persisted limiter state", async () => {
    for (const role of ["anon", "authenticated"]) {
      await denied(role, "SELECT * FROM public.admin_login_attempts");
      await denied(role, "DELETE FROM public.admin_login_attempts");
      await denied(role, "UPDATE public.admin_login_attempts SET attempt_count=1");
      await denied(role, "INSERT INTO public.admin_login_attempts VALUES ($1,1,now())", [key("bad")]);
      await denied(role, "SELECT * FROM public.consume_admin_login_attempt($1)", [key("bad")]);
    }
    const functions = await client.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.consume_admin_login_attempt(text)'::regprocedure");
    assert.equal(functions.rows[0].prosecdef, true);
    assert.deepEqual(functions.rows[0].proconfig, ["search_path=pg_catalog"]);
    await assert.rejects(asRole("service_role", "SELECT * FROM public.consume_admin_login_attempt('invalid')"), error => error.code === "22023");
  });

  await t.test("simultaneous service-role calls allow exactly eight attempts across database sessions", async () => {
    const pool = new Pool({ connectionString, max: 12 });
    try {
      const results = await Promise.all(Array.from({ length: 12 }, async () => {
        const session = await pool.connect();
        try {
          await session.query("SET ROLE service_role");
          return (await session.query("SELECT * FROM public.consume_admin_login_attempt($1)", [key("concurrent")])).rows[0];
        } finally { await session.query("RESET ROLE"); session.release(); }
      }));
      assert.equal(results.filter(row => row.allowed).length, 8);
      assert.equal(results.filter(row => !row.allowed).length, 4);
      assert.ok(results.filter(row => !row.allowed).every(row => row.retry_after > 0 && row.retry_after <= 600));
      assert.equal((await client.query("SELECT attempt_count FROM public.admin_login_attempts WHERE client_key=$1", [key("concurrent")])).rows[0].attempt_count, 9);
    } finally { await pool.end(); }
  });

  await t.test("expiry resets the budget and each call removes at most 100 expired records", async () => {
    await client.query("UPDATE public.admin_login_attempts SET expires_at=now()-interval '1 second' WHERE client_key=$1", [key("concurrent")]);
    await client.query("SET ROLE service_role");
    try { assert.equal((await client.query("SELECT * FROM public.consume_admin_login_attempt($1)", [key("concurrent")])).rows[0].allowed, true); }
    finally { await client.query("RESET ROLE"); }
    for (let index = 0; index < 250; index++) await client.query("INSERT INTO public.admin_login_attempts VALUES ($1,9,now()-interval '1 hour')", [key(`expired-${index}`)]);
    await asRole("service_role", "SELECT * FROM public.consume_admin_login_attempt($1)", [key("cleanup-rolled-back")]);
    // asRole rolls back; use a committed request to measure cleanup.
    await client.query("SELECT * FROM public.consume_admin_login_attempt($1)", [key("cleanup")]);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM public.admin_login_attempts WHERE expires_at < now()")).rows[0].count, 150);
  });

  await t.test("a waiting login measures retry time after a competing transaction establishes the window", async () => {
    const locker = new Client({ connectionString }), waiting = new Client({ connectionString });
    await Promise.all([locker.connect(), waiting.connect()]);
    let attempt;
    try {
      await locker.query("BEGIN; LOCK TABLE public.admin_login_attempts IN SHARE ROW EXCLUSIVE MODE");
      await waiting.query("SET ROLE service_role");
      const pid = (await waiting.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      attempt = waiting.query("SELECT * FROM public.consume_admin_login_attempt($1)", [key("waited-window")]);
      // Observe the lock wait instead of relying on scheduler timing. The
      // function has captured its initial clock before its first DELETE waits.
      let blocked = false;
      const deadline = Date.now() + 5000;
      while (!blocked && Date.now() < deadline) {
        blocked = (await client.query("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, "The login must be waiting inside the function before the competing write");
      await locker.query("INSERT INTO public.admin_login_attempts(client_key,attempt_count,expires_at) VALUES($1,8,clock_timestamp()+interval '10 minutes')", [key("waited-window")]);
      await locker.query("COMMIT");
      const result = (await attempt).rows[0];
      assert.equal(result.allowed, false);
      assert.ok(result.retry_after > 0 && result.retry_after <= 600, `Retry after lock wait: ${result.retry_after}`);
      assert.equal((await client.query("SELECT attempt_count FROM public.admin_login_attempts WHERE client_key=$1", [key("waited-window")])).rows[0].attempt_count, 9);
    } finally {
      await locker.query("ROLLBACK");
      await attempt?.catch(() => {});
      await Promise.all([locker.end(), waiting.end()]);
    }
  });
});
