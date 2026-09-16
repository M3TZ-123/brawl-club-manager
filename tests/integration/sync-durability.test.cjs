const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");

const connectionString = process.env.SYNC_TEST_DATABASE_URL;
if (connectionString) {
  const url = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Integration tests require local PostgreSQL");
  assert.ok(url.pathname.endsWith("_tests"), "Integration database name must end with _tests");
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
}

test("durable sync PostgreSQL integration", { skip: !connectionString }, async (t) => {
  const db = new Pool({ connectionString, max: 10 });
  const root = path.resolve(__dirname, "../..");
  try {
    // This database is explicitly reserved for tests; never use app credentials.
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;");
    await db.query(fs.readFileSync(path.join(root, "supabase/schema.sql"), "utf8"));
    // Production retains a legacy tenant identifier that is not a public field.
    await db.query("ALTER TABLE members ADD COLUMN owner_user_id uuid");
    await db.query(fs.readFileSync(path.join(root, "supabase/migrations/202609160001_sync_durability.sql"), "utf8"));
    const reset = async () => {
      await db.query("TRUNCATE sync_leases,sync_runs,membership_change_events,notification_outbox,member_activity_state,player_brawler_state,members,member_history,activity_log,club_events,battle_history,daily_stats,player_tracking,brawler_snapshots,notifications,settings RESTART IDENTITY CASCADE");
      await db.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('notifications_enabled','true'),('inactivity_threshold','48')");
    };
    const acquire = async (options = {}) => (await db.query("SELECT acquire_sync_run($1,$2,$3,$4,$5) x", ["#CLUB", options.source || "manual", options.scope || "full", options.playerTag || null, options.key || null])).rows[0].x;
    const member = (tag = "#PLAYER", extra = {}) => ({ player_tag: tag, player_name: tag, role: "member", trophies: 100, highest_trophies: 100, exp_level: 10,
      rank_current: "Gold I", rank_highest: "Gold II", win_rate: 50, brawlers_count: 1, solo_victories: 0, duo_victories: 0, trio_victories: 5, ...extra });
    const payload = (members = [member()], extra = {}) => ({ members, initial_setup: false, required_trophies: 1000,
      battles: members.map((m) => ({ player_tag: m.player_tag, battle_time: new Date(Date.now() - 3600000).toISOString(), mode: "gemGrab", map: "Test", result: "victory", trophy_change: 8, is_star_player: true })),
      brawlers: members.map((m) => ({ player_tag: m.player_tag, brawler_id: 1, brawler_name: "SHELLY", power_level: 2, trophies: 100, rank: 1, gadgets_count: 0, star_powers_count: 0, gears_count: 0 })), ...extra });
    const commit = async (run, body) => (await db.query("SELECT commit_sync_snapshot($1,$2,$3) x", [run.run_id, run.fence, body])).rows[0].x;
    const snapshot = async () => {
      const rows = {};
      for (const table of ["members", "member_history", "activity_log", "battle_history", "daily_stats", "player_tracking", "brawler_snapshots", "player_brawler_state", "member_activity_state", "notifications", "notification_outbox", "membership_change_events", "settings"]) {
        rows[table] = (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') data FROM ${table} t`)).rows[0].data;
      }
      return rows;
    };

    await t.test("one lease winner across independent connections; member refresh uses the same lease", async () => {
      await reset();
      const attempts = await Promise.all(Array.from({ length: 8 }, (_, i) => acquire({ key: `parallel-${i}`, scope: i % 2 ? "member" : "full", playerTag: i % 2 ? "#PLAYER" : null })));
      assert.equal(attempts.filter((r) => r.acquired).length, 1);
      assert.equal(attempts.filter((r) => r.busy).length, 7);
    });
    await t.test("expired worker is fenced out and cannot release the replacement lease", async () => {
      await reset(); const old = await acquire();
      await db.query("UPDATE sync_leases SET expires_at=now()-interval '1 second'");
      const fresh = await acquire(); assert.ok(fresh.fence > old.fence);
      await assert.rejects(commit(old, payload()), /stale_sync_fence/);
      await db.query("SELECT fail_sync_run($1,$2,'upstream_unavailable','Safe message')", [old.run_id, old.fence]);
      assert.equal((await db.query("SELECT run_id FROM sync_leases")).rows[0].run_id, fresh.run_id);
      assert.equal((await db.query("SELECT status FROM sync_runs WHERE id=$1", [old.run_id])).rows[0].status, "superseded");
      assert.equal((await commit(fresh, payload())).success, true);
    });
    await t.test("same-key retry after worker death returns a terminal outcome and permits a replacement key", async () => {
      await reset(); const expired = await acquire({ key: "crashed-request" });
      await db.query("UPDATE sync_leases SET expires_at=now()-interval '1 second'");
      const replay = await acquire({ key: "crashed-request" });
      assert.equal(replay.replayed, true); assert.equal(replay.status, "superseded"); assert.equal(replay.error_code, "lease_expired");
      const fresh = await acquire({ key: "replacement-request" }); assert.ok(fresh.acquired);
      await assert.rejects(commit(expired, payload()), /stale_sync_fence/);
      assert.equal((await commit(fresh, payload())).success, true);
    });
    await t.test("a late constraint failure rolls back members, history, battles, counters, outbox, and marker", async () => {
      await reset(); await commit(await acquire(), payload());
      const before = await snapshot(); const run = await acquire();
      const broken = payload([member("#PLAYER", { player_name: "Changed", role: "senior", trophies: 999 })]);
      broken.brawlers[0].brawler_name = "X".repeat(100);
      await assert.rejects(commit(run, broken), /value too long/);
      assert.deepEqual(await snapshot(), before);
      assert.equal((await db.query("SELECT status FROM sync_runs WHERE id=$1", [run.run_id])).rows[0].status, "running");
      await db.query("SELECT fail_sync_run($1,$2,'snapshot_rejected','The snapshot was not committed.')", [run.run_id, run.fence]);
      assert.equal((await db.query("SELECT status FROM sync_runs WHERE id=$1", [run.run_id])).rows[0].status, "failed");
    });
    await t.test("replaying a commit or idempotency key never duplicates observations", async () => {
      await reset(); const run = await acquire({ key: "repeat-request" }); const body = payload();
      const [first, concurrent] = await Promise.all([commit(run, body), commit(run, body)]);
      assert.deepEqual(concurrent, first);
      const before = await snapshot();
      assert.deepEqual(await commit(run, body), first); assert.deepEqual(await snapshot(), before);
      const replay = await acquire({ key: "repeat-request" }); assert.equal(replay.replayed, true); assert.deepEqual(replay.result, first);
      await assert.rejects(acquire({ key: "repeat-request", scope: "member", playerTag: "#PLAYER" }), /idempotency_scope_mismatch/);
    });
    await t.test("history preserves dates/counts/notes and records real name, role, join, and leave provenance", async () => {
      await reset(); await commit(await acquire(), payload([member(), member("#LEFT")]));
      await db.query("UPDATE member_history SET notes='private manager note',first_seen=NULL,times_joined=NULL,times_left=NULL WHERE player_tag='#PLAYER'");
      const run = await acquire(); await commit(run, payload([member("#PLAYER", { player_name: "New name", role: "senior" }), member("#NEW")]));
      const h = (await db.query("SELECT * FROM member_history WHERE player_tag='#PLAYER'")).rows[0];
      assert.equal(h.first_seen, null); assert.equal(h.times_joined, null); assert.equal(h.times_left, null); assert.equal(h.notes, "private manager note");
      const events = (await db.query("SELECT * FROM membership_change_events WHERE run_id=$1", [run.run_id])).rows;
      assert.deepEqual(events.map((e) => e.event_type).sort(), ["join", "leave", "name_change", "promotion"]);
      assert.ok(events.every((e) => e.source === "recorded" && e.trigger_source === "manual" && e.actor === "administrator"));
      const renamed = events.find((e) => e.event_type === "name_change");
      assert.equal(renamed.before_snapshot.player_name, "#PLAYER"); assert.equal(renamed.after_snapshot.player_name, "New name");
      assert.ok(!JSON.stringify(events).includes("private manager note"));
      assert.equal(renamed.provenance.timeMeaning, "observed_at");
      await assert.rejects(db.query("DELETE FROM membership_change_events WHERE id=$1", [renamed.id]), /immutable/);
      await assert.rejects(db.query("UPDATE membership_change_events SET player_name='changed' WHERE id=$1", [renamed.id]), /immutable/);
    });
    await t.test("Unicode names and repair provenance preserve unknown fields without inventing join times", async () => {
      await reset(); await commit(await acquire(), payload([member("#PLAYER", { player_name: "محمد" })]));
      const first = (await db.query("SELECT player_name,provenance FROM membership_change_events WHERE event_type='initial_seen'")).rows[0];
      assert.equal(first.player_name, "محمد"); assert.equal(first.provenance.firstSeenMeaning, "first_observed");
      await db.query("INSERT INTO membership_change_events(club_tag,event_type,player_tag,player_name,occurred_at,source,trigger_source,actor,before_snapshot,after_snapshot,provenance) VALUES('#CLUB','data_repair','#PLAYER','محمد',now(),'reconstructed','data_repair','administrator',$1,$2,$3)",
        [{ first_seen: null, role_at_leave: null }, { first_seen: "2026-01-01T00:00:00Z", role_at_leave: null }, { sourceCategory: "prior_record", recordTimestamp: "2026-01-01T00:00:00Z" }]);
      const repaired = (await db.query("SELECT * FROM membership_change_events WHERE event_type='data_repair'")).rows[0];
      assert.equal(repaired.after_snapshot.role_at_leave, null); assert.equal(repaired.source, "reconstructed");
      await db.query("UPDATE members SET role=NULL WHERE player_tag='#PLAYER'");
      const run = await acquire(); await commit(run, payload());
      const role = (await db.query("SELECT event_type,before_snapshot,after_snapshot FROM membership_change_events WHERE run_id=$1 AND event_type IN ('role_change','promotion','demotion')", [run.run_id])).rows[0];
      assert.equal(role.event_type, "role_change"); assert.equal(role.before_snapshot.role, null); assert.equal(role.after_snapshot.role, "member");
    });
    await t.test("member refresh keeps membership role and full-sync marker while updating tracking atomically", async () => {
      await reset(); await commit(await acquire(), payload());
      const marker = (await db.query("SELECT value FROM settings WHERE key='last_sync_time'")).rows[0].value;
      await db.query("UPDATE members SET owner_user_id='00000000-0000-0000-0000-000000000001'");
      const run = await acquire({ source: "member", scope: "member", playerTag: "#PLAYER" });
      const body = payload([member("#PLAYER", { player_name: "Refreshed name", role: "president", trophies: 108 })]); body.brawlers[0].power_level = 4;
      const result = await commit(run, body);
      assert.equal(result.member.role, "member"); assert.equal(result.member.trophies, 108);
      assert.equal(Object.hasOwn(result.member, "owner_user_id"), false);
      assert.equal((await db.query("SELECT count(*)::int n FROM membership_change_events WHERE before_snapshot ? 'owner_user_id' OR after_snapshot ? 'owner_user_id'")).rows[0].n, 0);
      assert.equal((await db.query("SELECT value FROM settings WHERE key='last_sync_time'")).rows[0].value, marker);
      assert.equal((await db.query("SELECT power_ups FROM player_tracking WHERE player_tag='#PLAYER'")).rows[0].power_ups, 2);
    });
    await t.test("old status labels cannot renew activity; current deltas and stored battle times can", async () => {
      await reset(); await commit(await acquire(), payload());
      await db.query("UPDATE member_activity_state SET last_battle_at=now()-interval '49 hours',last_activity_at=now()-interval '49 hours'; INSERT INTO activity_log(player_tag,trophies,trophy_change,activity_type) VALUES('#PLAYER',100,0,'minimal')");
      await commit(await acquire(), payload([member()], { battles: [] }));
      assert.equal((await db.query("SELECT is_active FROM members WHERE player_tag='#PLAYER'")).rows[0].is_active, false);
      await commit(await acquire(), payload([member("#PLAYER", { trophies: 101 })], { battles: [] }));
      assert.equal((await db.query("SELECT is_active FROM members WHERE player_tag='#PLAYER'")).rows[0].is_active, true);
      const summary = (await db.query("SELECT * FROM sync_activity_summary(ARRAY['#PLAYER'])")).rows[0];
      assert.ok(summary.last_activity_at > summary.last_battle_at);
    });
    await t.test("disabled notifications still record audit events without enqueuing Discord messages", async () => {
      await reset(); await commit(await acquire(), payload());
      await db.query("UPDATE settings SET value='false' WHERE key='notifications_enabled'");
      const run = await acquire(); await commit(run, payload([member("#PLAYER", { player_name: "New name" }), member("#NEW")]));
      assert.equal((await db.query("SELECT count(*)::int n FROM membership_change_events WHERE run_id=$1", [run.run_id])).rows[0].n, 2);
      assert.equal((await db.query("SELECT count(*)::int n FROM notification_outbox")).rows[0].n, 0);
    });
    await t.test("outbox claim is exclusive, acknowledgements are fenced, and exhausted retries become failed", async () => {
      await reset();
      await db.query("INSERT INTO notification_outbox(event_key,payload) SELECT 'message-'||i,'{}' FROM generate_series(1,8) i");
      const one = randomUUID(), two = randomUUID();
      const [a, b] = await Promise.all([db.query("SELECT * FROM claim_notification_outbox($1,4)", [one]), db.query("SELECT * FROM claim_notification_outbox($1,4)", [two])]);
      assert.equal(new Set([...a.rows, ...b.rows].map((r) => r.id)).size, 8);
      const id = a.rows[0].id;
      await db.query("UPDATE notification_outbox SET locked_until=now()-interval '1 second' WHERE id=$1", [id]);
      assert.equal((await db.query("SELECT complete_notification_outbox($1,$2,true) ok", [id, one])).rows[0].ok, false);
      assert.equal((await db.query("SELECT * FROM claim_notification_outbox($1,1)", [two])).rows[0].id, id);
      assert.equal((await db.query("SELECT complete_notification_outbox($1,$2,true,204) ok", [id, two])).rows[0].ok, true);
      await db.query("UPDATE notification_outbox SET status='pending',attempts=7,available_at=now(),locked_by=NULL,locked_until=NULL WHERE id=$1", [b.rows[0].id]);
      const exhausted = (await db.query("SELECT * FROM claim_notification_outbox($1,1)", [one])).rows[0];
      await db.query("SELECT complete_notification_outbox($1,$2,false,429,'http_429',120)", [exhausted.id, one]);
      assert.equal((await db.query("SELECT status FROM notification_outbox WHERE id=$1", [exhausted.id])).rows[0].status, "failed");
    });
    await t.test("maintenance keeps annual daily aggregates and indefinite audit while dropping 90-day raw data", async () => {
      await reset(); await commit(await acquire(), payload());
      await db.query("INSERT INTO battle_history(player_tag,battle_time) VALUES('#PLAYER',now()-interval '95 days'); INSERT INTO daily_stats(player_tag,date,battles) VALUES('#PLAYER',current_date-95,50),('#PLAYER',current_date-400,50); INSERT INTO membership_change_events(club_tag,event_type,player_tag,player_name,occurred_at,source,trigger_source,actor) VALUES('#CLUB','join','#OLD','Historical',now()-interval '500 days','reconstructed','legacy','unknown')");
      await db.query("SELECT run_sync_maintenance()");
      assert.equal((await db.query("SELECT count(*)::int n FROM battle_history WHERE battle_time<now()-interval '90 days'")).rows[0].n, 0);
      assert.equal((await db.query("SELECT count(*)::int n FROM daily_stats WHERE date=current_date-95")).rows[0].n, 1);
      assert.equal((await db.query("SELECT count(*)::int n FROM daily_stats WHERE date=current_date-400")).rows[0].n, 0);
      assert.equal((await db.query("SELECT count(*)::int n FROM membership_change_events WHERE player_tag='#OLD'")).rows[0].n, 1);
    });
    await t.test("anon cannot inspect private run/outbox state or execute privileged RPCs", async () => {
      const client = await db.connect();
      try {
        await client.query("BEGIN; SET LOCAL ROLE anon");
        await assert.rejects(client.query("SELECT * FROM sync_runs"), /permission denied/); await client.query("ROLLBACK");
        await client.query("BEGIN; SET LOCAL ROLE anon");
        await assert.rejects(client.query("SELECT acquire_sync_run('#CLUB','manual','full')"), /permission denied/); await client.query("ROLLBACK");
      } finally { client.release(); }
    });
    await require("./helpers/adaptive-sync-checks.cjs").runAdaptiveSyncChecks(t, db);
  } finally { await db.end(); }
});
