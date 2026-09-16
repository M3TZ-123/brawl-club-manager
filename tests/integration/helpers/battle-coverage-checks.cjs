const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function runBattleCoverageChecks(t, db) {
  await db.query(fs.readFileSync(path.resolve(__dirname, "../../../supabase/migrations/202609160009_battle_coverage.sql"), "utf8"));
  const reset = async () => {
    await db.query("TRUNCATE sync_battle_coverage,sync_battle_gaps,sync_leases,sync_runs,membership_change_events,notification_outbox,member_activity_state,player_brawler_state,members,member_history,activity_log,club_events,battle_history,daily_stats,player_tracking,brawler_snapshots,notifications,settings RESTART IDENTITY CASCADE");
    await db.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('notifications_enabled','false'),('inactivity_threshold','48')");
  };
  const origin = Date.now() - 12 * 60 * 60 * 1000;
  const window = (start = 0, size = 25) => Array.from({ length: size }, (_, index) => new Date(origin + (start + index) * 60000).toISOString());
  const observed = (times = window(), tag = "#PLAYER", success = true) => ({ player_tag: tag, success, battle_times: times });
  const member = tag => ({ player_tag: tag, player_name: tag, role: "member", icon_id: 1, trophies: 100, highest_trophies: 100,
    exp_level: 10, rank_available: false, win_rate: 50, brawlers_count: 1, solo_victories: 1, duo_victories: 2, trio_victories: 3 });
  const payload = (observations = [observed()]) => ({ members: observations.map(o => member(o.player_tag)), battle_observations: observations,
    battles: observations.flatMap(o => [...new Set(o.battle_times)].map(time => ({ player_tag: o.player_tag, battle_time: time,
      mode: "gemGrab", map: "Coverage", result: "victory", trophy_change: 8 }))),
    brawlers: observations.map(o => ({ player_tag: o.player_tag, brawler_id: 1, brawler_name: "SHELLY", power_level: 2, trophies: 100, rank: 1, gadgets_count: 0, star_powers_count: 0, gears_count: 0 })),
    battle_logs_complete: observations.every(o => o.success), ranked_complete: false, ranked_attempted: false });
  const acquire = async (scope = "full", key = null, club = "#CLUB", tag = "#PLAYER") => (await db.query("SELECT acquire_sync_run($1,$2,$3,$4,$5) result",
    [club, scope === "member" ? "member" : "manual", scope, scope === "member" ? tag : null, key])).rows[0].result;
  const commit = async (run, body, scope = "full") => (await db.query(`SELECT ${scope === "roster" ? "commit_roster_snapshot" : "commit_sync_snapshot"}($1,$2,$3) result`, [run.run_id, run.fence, body])).rows[0].result;
  const sync = async (observations = [observed()], scope = "full", club = "#CLUB") => commit(await acquire(scope, null, club), payload(observations), scope);
  const state = async (club = "#CLUB", tag = "#PLAYER") => (await db.query("SELECT to_jsonb(c) value FROM sync_battle_coverage c WHERE club_tag=$1 AND player_tag=$2", [club, tag])).rows[0]?.value;
  const summary = async (club = "#CLUB", tags = ["#PLAYER"], now = new Date()) => (await db.query("SELECT * FROM sync_battle_coverage_summary($1,$2,$3) ORDER BY player_tag", [club, tags, now])).rows;
  const gaps = async () => (await db.query("SELECT to_jsonb(g) value FROM sync_battle_gaps g ORDER BY detected_at,id")).rows.map(row => row.value);
  const evidence = async () => {
    const result = {};
    for (const table of ["sync_battle_coverage", "sync_battle_gaps", "notifications", "notification_outbox", "settings", "members", "battle_history"]) {
      result[table] = (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') value FROM ${table} t`)).rows[0].value;
    }
    return result;
  };
  const releaseFailed = run => db.query("SELECT fail_sync_run($1,$2,'snapshot_rejected','Coverage test rollback')", [run.run_id, run.fence]);

  await t.test("coverage starts unknown and the first successful window is only a baseline", async () => {
    await reset();
    assert.equal((await summary())[0].last_observation_status, "unknown");
    const legacy = payload(); delete legacy.battle_observations;
    await commit(await acquire(), legacy);
    assert.equal(await state(), undefined);
    const first = await sync([observed(window(30))]);
    assert.equal(first.warnings.includes("battle_history_gap"), false);
    const row = await state(); assert.equal(row.last_observation_status, "baseline");
    assert.ok(row.baseline_started_at); assert.ok(row.last_observed_at);
    assert.equal(row.recent_battle_times.length, 25); assert.equal((await gaps()).length, 0);
  });

  await t.test("25 disjoint newer battles record candidate gap bounds and a durable report warning", async () => {
    await reset(); await sync(); const baseline = await state();
    const result = await sync([observed(window(25))]);
    assert.deepEqual(result.warnings, ["battle_history_gap"]);
    const rows = await gaps(); assert.equal(rows.length, 1); assert.equal(rows[0].window_size, 25);
    assert.equal(Date.parse(rows[0].gap_start_at), Date.parse(window()[24]));
    assert.equal(Date.parse(rows[0].gap_end_at), Date.parse(window(25)[0]));
    assert.equal(rows[0].previous_observed_at, baseline.last_observed_at);
    assert.equal(rows[0].scope, "full"); assert.equal(rows[0].lost_battles, undefined);
    assert.equal((await summary())[0].possible_gap, true);
    const healthy = await sync([observed(window(26))]);
    assert.equal((await state()).last_observation_status, "observed");
    assert.equal(healthy.warnings.includes("battle_history_gap"), true);
    assert.equal((await gaps()).length, 1);
    assert.equal((await summary("#CLUB", ["#PLAYER"], new Date(Date.now() + 27 * 86400000)))[0].possible_gap, true);
    assert.equal((await summary("#CLUB", ["#PLAYER"], new Date(Date.now() + 29 * 86400000)))[0].possible_gap, false);
    assert.equal((await gaps()).length, 1, "expired report warning must not erase the observed gap record");
  });

  await t.test("24 unique entries, overlapping windows, duplicates and ordering do not invent a gap", async () => {
    await reset(); await sync();
    await sync([observed([...window()].reverse().concat(window()[0]))]);
    assert.equal((await state()).recent_battle_times.length, 25);
    await sync([observed(window(1))]); assert.equal((await gaps()).length, 0);
    await sync([observed(window(26, 24).concat(window(26, 24)[0]))]);
    assert.equal((await state()).recent_battle_times.length, 24);
    assert.equal((await gaps()).length, 0, "25 raw entries with one duplicate are not a full unique window");
  });

  await t.test("failed, empty and regressing responses preserve the accepted window and previous gaps", async () => {
    await reset(); await sync(); await sync([observed(window(25))]);
    const baseline = await state(); const savedGaps = await gaps();
    for (const [observation, status] of [[observed([], "#PLAYER", false), "failed"], [observed([]), "empty"], [observed(window()), "regressing"]]) {
      const result = await sync([observation]); const row = await state();
      assert.equal(row.last_observation_status, status);
      for (const field of ["baseline_started_at", "last_observed_at", "recent_battle_times"]) assert.deepEqual(row[field], baseline[field]);
      assert.deepEqual(await gaps(), savedGaps); assert.equal(result.warnings.includes("battle_history_gap"), true);
      assert.equal((await summary())[0].possible_gap, true);
    }
  });

  await t.test("an initially empty or failed log never claims a checked historical baseline", async () => {
    await reset();
    for (const observation of [observed([], "#PLAYER", false), observed([])]) {
      await sync([observation]); const row = await state();
      assert.equal(row.baseline_started_at, null); assert.equal(row.last_observed_at, null);
      assert.deepEqual(row.recent_battle_times, []); assert.ok(row.last_attempt_at);
    }
    await sync(); assert.equal((await state()).last_observation_status, "baseline"); assert.equal((await gaps()).length, 0);
  });

  await t.test("late snapshot failure rolls back coverage, gap, notification and gameplay data together", async () => {
    await reset(); await db.query("UPDATE settings SET value='true' WHERE key='notifications_enabled'"); await sync();
    const before = await evidence(); const body = payload([observed(window(25))]); body.brawlers[0].brawler_name = "X".repeat(100);
    const run = await acquire(); await assert.rejects(commit(run, body), /value too long/);
    assert.deepEqual(await evidence(), before); await releaseFailed(run);
    assert.equal((await summary())[0].possible_gap, false);
  });

  await t.test("concurrent commit and idempotency replay create one gap and one notification", async () => {
    await reset(); await db.query("UPDATE settings SET value='true' WHERE key='notifications_enabled'"); await sync();
    const run = await acquire("full", "coverage-replay"); const body = payload([observed(window(25))]);
    const [first, second] = await Promise.all([commit(run, body), commit(run, body)]);
    assert.deepEqual(first, second); assert.deepEqual((await acquire("full", "coverage-replay")).result, first);
    assert.equal((await gaps()).length, 1);
    assert.equal((await db.query("SELECT count(*)::int n FROM notification_outbox WHERE event_key LIKE 'battle-gap:%'")).rows[0].n, 1);
  });

  await t.test("member coverage is supported while roster refresh and stale workers cannot change it", async () => {
    await reset(); await sync([observed(), observed(window(), "#SECOND")]);
    const memberResult = await sync([observed(window(25))], "member");
    assert.equal(memberResult.warnings.includes("battle_history_gap"), true); assert.equal((await gaps())[0].scope, "member");
    const before = await state(); const savedGaps = await gaps();
    await commit(await acquire("roster"), payload([observed(window(100)), observed(window(100), "#SECOND")]), "roster");
    assert.deepEqual(await state(), before); assert.deepEqual(await gaps(), savedGaps);
    const old = await acquire(); await db.query("UPDATE sync_leases SET expires_at=now()-interval '1 second'");
    const replacement = await acquire();
    await assert.rejects(commit(old, payload([observed(window(100))])), /stale_sync_fence/);
    assert.deepEqual(await state(), before); await releaseFailed(replacement);
  });

  await t.test("coverage and gap summaries isolate the same player between different clubs", async () => {
    await reset(); await sync(); await sync([observed(window(25))]);
    await db.query("UPDATE settings SET value='#OTHER' WHERE key='club_tag'");
    assert.equal((await summary("#OTHER"))[0].last_observation_status, "unknown");
    await sync([observed(window(50))], "full", "#OTHER");
    assert.equal((await summary("#OTHER"))[0].possible_gap, false);
    assert.equal((await summary("#OTHER"))[0].last_observation_status, "baseline");
    assert.equal((await summary("#CLUB"))[0].possible_gap, true);
    assert.equal((await summary("#CLUB", ["#UNTRACKED"]))[0].possible_gap, false);
  });

  await t.test("new gaps aggregate one Arabic club notification and observe rolling24h dedupe and the disable switch", async () => {
    await reset(); await db.query("UPDATE settings SET value='true' WHERE key='notifications_enabled'");
    await sync([observed(), observed(window(), "#SECOND")]);
    await sync([observed(window(25)), observed(window(25), "#SECOND")]);
    const alerts = async () => (await db.query("SELECT payload FROM notification_outbox WHERE event_key LIKE 'battle-gap:%' ORDER BY created_at")).rows;
    assert.equal((await alerts()).length, 1);
    const first = (await alerts())[0].payload; assert.deepEqual(first.allowed_mentions.parse, []);
    assert.match(first.embeds[0].description, /2 من أعضاء النادي/); assert.match(first.embeds[0].description, /احتمال/);
    await sync([observed(window(50)), observed(window(50), "#SECOND")]);
    assert.equal((await gaps()).length, 4); assert.equal((await alerts()).length, 1);
    await db.query("UPDATE notification_outbox SET created_at=now()-interval '25 hours' WHERE event_key LIKE 'battle-gap:%'");
    await sync([observed(window(75)), observed(window(75), "#SECOND")]);
    assert.equal((await alerts()).length, 2);
    await db.query("UPDATE settings SET value='false' WHERE key='notifications_enabled'; UPDATE notification_outbox SET created_at=now()-interval '25 hours' WHERE event_key LIKE 'battle-gap:%'");
    await sync([observed(window(100)), observed(window(100), "#SECOND")]);
    assert.equal((await gaps()).length, 8); assert.equal((await alerts()).length, 2);
  });

  await t.test("malformed observations cannot attach coverage to another member or bypass input bounds", async () => {
    await reset(); await sync();
    const invalid = [
      [observed(window(), "#OTHER")], [observed(), observed()], [{ ...observed(), success: "true" }],
      [observed(["not-a-date"])], [observed(window(), "#PLAYER", false)], [observed(window(0, 101))],
      [observed([new Date(Date.now() + 3600000).toISOString()])], [observed(["infinity"])],
    ];
    for (const observations of invalid) {
      const before = await evidence(); const body = payload(); body.battle_observations = observations;
      const run = await acquire(); await assert.rejects(commit(run, body), /invalid_battle_observations/);
      assert.deepEqual(await evidence(), before); await releaseFailed(run);
    }
  });

  await t.test("coverage tables and helper stay private while service role can only read summaries", async () => {
    await reset(); await sync();
    const client = await db.connect();
    try {
      for (const role of ["anon", "authenticated"]) {
        for (const query of ["SELECT * FROM sync_battle_coverage", "SELECT * FROM sync_battle_gaps", "SELECT * FROM sync_battle_coverage_summary('#CLUB',ARRAY['#PLAYER'])"]) {
          await client.query(`BEGIN; SET LOCAL ROLE ${role}`); await assert.rejects(client.query(query), /permission denied/); await client.query("ROLLBACK");
        }
      }
      await client.query("BEGIN; SET LOCAL ROLE service_role");
      assert.equal((await client.query("SELECT * FROM sync_battle_coverage_summary('#CLUB',ARRAY['#PLAYER'])")).rows[0].last_observation_status, "baseline");
      await client.query("ROLLBACK");
      for (const query of ["DELETE FROM sync_battle_gaps", "UPDATE sync_battle_coverage SET last_observation_status='empty'", "SELECT sync_record_battle_observations(NULL,NULL,NULL,now())"]) {
        await client.query("BEGIN; SET LOCAL ROLE service_role"); await assert.rejects(client.query(query), /permission denied/); await client.query("ROLLBACK");
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
}

module.exports = { runBattleCoverageChecks };
