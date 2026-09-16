const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function runAdaptiveSyncChecks(t, db) {
  const migration = fs.readFileSync(path.resolve(__dirname, "../../../supabase/migrations/202609160005_adaptive_sync.sql"), "utf8");
  const previous = (await db.query("SELECT value FROM settings WHERE key='last_sync_time'")).rows[0]?.value;
  await db.query(migration);
  await db.query(fs.readFileSync(path.resolve(__dirname, "../../../supabase/migrations/202609160006_upstream_cooldowns.sql"), "utf8"));
  const markers = async () => Object.fromEntries((await db.query("SELECT key,value FROM settings WHERE key LIKE 'last_%sync_time'")).rows.map(row => [row.key, row.value]));
  const initial = await markers();
  assert.equal(initial.last_full_sync_time, previous); assert.equal(initial.last_roster_sync_time, previous);
  assert.equal(initial.last_battle_sync_time, undefined); assert.equal(initial.last_ranked_sync_time, undefined);
  const reset = async () => {
    await db.query("TRUNCATE sync_leases,sync_runs,membership_change_events,notification_outbox,member_activity_state,player_brawler_state,members,member_history,activity_log,club_events,battle_history,daily_stats,player_tracking,brawler_snapshots,notifications,settings RESTART IDENTITY CASCADE");
    await db.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('notifications_enabled','true'),('inactivity_threshold','48')");
  };
  const acquire = async (scope = "roster", key = null) => (await db.query("SELECT acquire_sync_run('#CLUB','cron',$1,$2,$3) result", [scope, scope === "member" ? "#PLAYER" : null, key])).rows[0].result;
  const member = (tag = "#PLAYER", extra = {}) => ({ player_tag: tag, player_name: tag, role: "member", icon_id: 7, trophies: 100, highest_trophies: 500, exp_level: 50,
    rank_current: "Gold I", rank_highest: "Diamond II", win_rate: 75, brawlers_count: 1, solo_victories: 10, duo_victories: 20, trio_victories: 50, ...extra });
  const battleTime = new Date(Date.now() - 3600000).toISOString();
  const fullPayload = (members = [member()], extra = {}) => ({ members, required_trophies: 1000, initial_setup: false,
    battles: members.map(m => ({ player_tag: m.player_tag, battle_time: battleTime, mode: "gemGrab", map: "Map", result: "victory", trophy_change: 8, is_star_player: true, brawler_name: "SHELLY", brawler_power: 2, brawler_trophies: 100, teams_json: [] })),
    brawlers: members.map(m => ({ player_tag: m.player_tag, brawler_id: 1, brawler_name: "SHELLY", power_level: 2, trophies: 100, rank: 1, gadgets_count: 1, star_powers_count: 0, gears_count: 0 })), ...extra });
  const rosterPayload = (members = [member()], extra = {}) => ({ members: members.map(({ player_tag, player_name, trophies, role, icon_id }) => ({ player_tag, player_name, trophies, role, icon_id })), ...extra });
  const commit = async (run, body, scope = "roster") => (await db.query(`SELECT ${scope === "roster" ? "commit_roster_snapshot" : "commit_sync_snapshot"}($1,$2,$3) result`, [run.run_id, run.fence, body])).rows[0].result;
  const full = async (body = fullPayload()) => commit(await acquire("full"), body, "full");
  const roster = async (body = rosterPayload()) => commit(await acquire(), body);
  const tableRows = async (table, physical = false) => (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') rows FROM (SELECT ${physical ? "xmin::text AS row_version," : ""} * FROM ${table}) t`)).rows[0].rows;
  const snapshot = async () => {
    const rows = {};
    for (const table of ["members", "member_history", "activity_log", "battle_history", "daily_stats", "player_tracking", "brawler_snapshots", "player_brawler_state", "member_activity_state", "notifications", "notification_outbox", "membership_change_events", "settings"]) rows[table] = await tableRows(table);
    return rows;
  };

  await t.test("adaptive roster preserves detailed profiles and records membership changes with unknown history intact", async () => {
    await reset(); await full(fullPayload([member(), member("#LEFT")]));
    await db.query("UPDATE members SET owner_user_id='00000000-0000-0000-0000-000000000001'; UPDATE members SET role=NULL WHERE player_tag='#LEFT'; UPDATE member_history SET first_seen=NULL,times_joined=NULL,times_left=NULL,notes='private note' WHERE player_tag='#PLAYER'");
    const oldMember = (await db.query("SELECT * FROM members WHERE player_tag='#PLAYER'")).rows[0];
    const oldDetailed = {};
    for (const table of ["battle_history", "daily_stats", "player_tracking", "brawler_snapshots", "player_brawler_state"]) oldDetailed[table] = await tableRows(table, true);
    const beforeMarkers = await markers();
    const result = await roster(rosterPayload([member("#PLAYER", { player_name: "Renamed", role: "senior", trophies: 108 }), member("#NEW")]));
    assert.equal(result.scope, "roster"); assert.equal(result.synced, 2); assert.equal(result.events, 4);
    const updated = (await db.query("SELECT * FROM members WHERE player_tag='#PLAYER'")).rows[0];
    for (const key of ["highest_trophies", "exp_level", "rank_current", "rank_highest", "win_rate", "brawlers_count", "solo_victories", "duo_victories", "trio_victories", "owner_user_id"]) assert.equal(updated[key], oldMember[key], key);
    for (const [table, rows] of Object.entries(oldDetailed)) assert.deepEqual(await tableRows(table, true), rows, table);
    const history = (await db.query("SELECT * FROM member_history WHERE player_tag='#PLAYER'")).rows[0];
    assert.equal(history.first_seen, null); assert.equal(history.times_joined, null); assert.equal(history.times_left, null); assert.equal(history.notes, "private note");
    const left = (await db.query("SELECT * FROM member_history WHERE player_tag='#LEFT'")).rows[0];
    assert.equal(left.role_at_leave, null); assert.equal(left.is_current_member, false);
    const events = (await db.query("SELECT * FROM membership_change_events WHERE run_id=$1", [result.runId])).rows;
    assert.deepEqual(events.map(event => event.event_type).sort(), ["join", "leave", "name_change", "promotion"]);
    assert.ok(events.every(event => event.provenance.sourceCategory === "club_roster_snapshot" && event.source === "recorded"));
    assert.equal(/owner_user_id|private note/.test(JSON.stringify(events)), false);
    const afterMarkers = await markers();
    assert.equal(afterMarkers.last_sync_time, beforeMarkers.last_sync_time); assert.equal(afterMarkers.last_full_sync_time, beforeMarkers.last_full_sync_time);
    assert.equal(afterMarkers.last_battle_sync_time, beforeMarkers.last_battle_sync_time); assert.ok(afterMarkers.last_roster_sync_time);
    assert.equal((await db.query("SELECT count(*)::int n FROM member_history")).rows[0].n, 3);
  });

  await t.test("roster and full sync use one lease; wrong RPC scopes and stale workers cannot write", async () => {
    await reset();
    const contenders = await Promise.all(Array.from({ length: 8 }, (_, index) => acquire(index % 2 ? "full" : "roster", `adaptive-${index}`)));
    assert.equal(contenders.filter(result => result.acquired).length, 1); assert.equal(contenders.filter(result => result.busy).length, 7);
    await reset(); const old = await acquire();
    await assert.rejects(db.query("SELECT acquire_sync_run('#CLUB','cron','roster','#PLAYER')"), /invalid_sync_request/);
    await assert.rejects(commit(old, fullPayload(), "full"), /sync_scope_mismatch/);
    await db.query("UPDATE sync_leases SET expires_at=now()-interval '1 second'");
    const replacement = await acquire("full");
    await assert.rejects(commit(old, rosterPayload()), /stale_sync_fence/);
    await assert.rejects(commit(replacement, rosterPayload()), /sync_scope_mismatch/);
    assert.equal((await commit(replacement, fullPayload(), "full")).scope, "full");
  });

  await t.test("concurrent roster retries and request replay do not duplicate observations or membership events", async () => {
    await reset(); const run = await acquire("roster", "same-roster-request"); const body = rosterPayload();
    const [first, second] = await Promise.all([commit(run, body), commit(run, body)]);
    assert.deepEqual(second, first); assert.deepEqual((await acquire("roster", "same-roster-request")).result, first);
    assert.equal((await db.query("SELECT count(*)::int n FROM activity_log")).rows[0].n, 1);
    assert.equal((await db.query("SELECT count(*)::int n FROM membership_change_events")).rows[0].n, 1);
  });

  await t.test("a late roster constraint failure rolls back history, events, outbox, activity, and freshness", async () => {
    await reset(); await full(); const before = await snapshot(); const run = await acquire();
    const broken = rosterPayload([member("#PLAYER", { player_name: "Renamed", trophies: 999 }), member("#BAD", { player_name: "X".repeat(100) })]);
    await assert.rejects(commit(run, broken), /value too long/);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.query("SELECT status FROM sync_runs WHERE id=$1", [run.run_id])).rows[0].status, "running");
  });

  await t.test("roster trophy changes remain actual activity and are counted once when the following full sync has delta zero", async () => {
    await reset(); await full();
    await db.query("UPDATE member_activity_state SET last_battle_at=now()-interval '49 hours',last_activity_at=now()-interval '49 hours'; INSERT INTO activity_log(player_tag,trophies,trophy_change,recorded_at) VALUES('#PLAYER',100,0,now()-interval '24 hours')");
    await roster(rosterPayload([member("#PLAYER", { trophies: 108 })]));
    const actual = (await db.query("SELECT last_activity_at FROM member_activity_state WHERE player_tag='#PLAYER'")).rows[0].last_activity_at;
    await full(fullPayload([member("#PLAYER", { trophies: 108 })]));
    assert.equal((await db.query("SELECT sum(trophy_change)::int delta FROM activity_log")).rows[0].delta, 8);
    const summary = (await db.query("SELECT * FROM sync_activity_summary(ARRAY['#PLAYER'])")).rows[0];
    assert.equal(summary.trophies_24h, 8); assert.equal(summary.last_activity_at.getTime(), actual.getTime());
    assert.equal((await db.query("SELECT is_active FROM members WHERE player_tag='#PLAYER'")).rows[0].is_active, true);
  });

  await t.test("unchanged full sync skips battle and brawler writes; actual corrections update the same daily rows", async () => {
    await reset(); const body = fullPayload(); await full(body);
    const unchanged = {};
    for (const table of ["battle_history", "brawler_snapshots", "player_brawler_state", "daily_stats"]) unchanged[table] = await tableRows(table, true);
    await full(body); await full(body);
    for (const [table, rows] of Object.entries(unchanged)) assert.deepEqual(await tableRows(table, true), rows, table);
    assert.equal((await db.query("SELECT count(*)::int n FROM activity_log")).rows[0].n, 1);
    body.battles[0].trophy_change = 9; body.brawlers[0].power_level = 4;
    await full(body);
    const changed = await tableRows("brawler_snapshots", true);
    assert.equal(changed.length, 1); assert.equal(changed[0].id, unchanged.brawler_snapshots[0].id); assert.equal(changed[0].power_level, 4);
    assert.notEqual(changed[0].row_version, unchanged.brawler_snapshots[0].row_version);
    assert.equal((await db.query("SELECT trophy_change FROM battle_history")).rows[0].trophy_change, 9);
    assert.equal((await db.query("SELECT trophies_gained FROM daily_stats")).rows[0].trophies_gained, 9);
    assert.equal((await db.query("SELECT power_ups FROM player_tracking")).rows[0].power_ups, 2);
    await full(body); assert.equal((await db.query("SELECT power_ups FROM player_tracking")).rows[0].power_ups, 2);
  });

  await t.test("unchanged observations retain a baseline at least every thirty minutes without renewing activity", async () => {
    await reset(); await roster(); await roster(); await full(fullPayload(undefined, { battles: [] }));
    assert.equal((await db.query("SELECT count(*)::int n FROM activity_log")).rows[0].n, 1);
    await db.query("UPDATE activity_log SET recorded_at=now()-interval '30 minutes 1 second'");
    await roster();
    assert.equal((await db.query("SELECT count(*)::int n FROM activity_log")).rows[0].n, 2);
    assert.equal((await db.query("SELECT last_activity_at FROM member_activity_state")).rows[0].last_activity_at, null);
    assert.equal((await db.query("SELECT is_active FROM members")).rows[0].is_active, false);
  });

  await t.test("unavailable ranked data preserves cache but explicit available zero can reset current and highest rank", async () => {
    await reset(); await full();
    const ranks = async () => (await db.query("SELECT rank_current,rank_highest FROM members WHERE player_tag='#PLAYER'")).rows[0];
    const cached = await ranks();
    await full(fullPayload([member("#PLAYER", { rank_available: false, rank_current: "Masters", rank_highest: "Masters" })]));
    assert.deepEqual(await ranks(), cached);
    await full(fullPayload([member("#PLAYER", { rank_current: "Unranked", rank_highest: "Unranked" })]));
    assert.deepEqual(await ranks(), cached);
    await full(fullPayload([member("#PLAYER", { rank_available: true, rank_current: "Unranked", rank_highest: "Unranked" })]));
    assert.deepEqual(await ranks(), { rank_current: "Unranked", rank_highest: "Unranked" });
  });

  await t.test("full, battle, ranked and roster markers reflect their own successful scope and completeness", async () => {
    await reset();
    const result = await full(fullPayload(undefined, { battle_logs_complete: false, ranked_complete: false,
      warnings: ["battle_logs_incomplete", "secret-value", { api_key: "never expose" }, "ranked_unavailable", "ranked_unavailable", "ranked_rate_limited", "battle_logs_rate_limited"] }));
    assert.deepEqual(result.warnings, ["battle_logs_incomplete", "ranked_unavailable", "ranked_rate_limited", "battle_logs_rate_limited"]);
    const initial = await markers();
    assert.equal(initial.last_full_sync_time, initial.last_sync_time); assert.equal(initial.last_roster_sync_time, initial.last_sync_time);
    assert.equal(initial.last_battle_sync_time, undefined); assert.equal(initial.last_ranked_sync_time, undefined);
    await roster(rosterPayload(undefined, { battle_logs_complete: true, ranked_complete: true }));
    const afterRoster = await markers(); assert.equal(afterRoster.last_full_sync_time, initial.last_full_sync_time); assert.equal(afterRoster.last_battle_sync_time, undefined);
    await commit(await acquire("member"), fullPayload(undefined, { battle_logs_complete: true, ranked_complete: true }), "full");
    assert.deepEqual(await markers(), afterRoster);
    await full(fullPayload(undefined, { battle_logs_complete: true, ranked_complete: true }));
    const complete = await markers(); assert.ok(complete.last_battle_sync_time); assert.ok(complete.last_ranked_sync_time);
    await full(fullPayload(undefined, { battle_logs_complete: false, ranked_complete: false }));
    const partial = await markers(); assert.equal(partial.last_battle_sync_time, complete.last_battle_sync_time); assert.equal(partial.last_ranked_sync_time, complete.last_ranked_sync_time);
    await reset(); await full(); const legacy = await markers(); assert.ok(legacy.last_battle_sync_time); assert.equal(legacy.last_ranked_sync_time, undefined);
  });

  await t.test("adaptive SQL helpers and commit are private and migration reapplication preserves newer markers", async () => {
    const before = await markers(); await db.query(migration); assert.deepEqual(await markers(), before);
    const permissions = (await db.query("SELECT has_function_privilege('anon','public.commit_roster_snapshot(uuid,bigint,jsonb)','EXECUTE') anon_commit,has_function_privilege('authenticated','public.sync_record_activity_sample(text,integer,integer,text,timestamptz)','EXECUTE') user_sample,has_function_privilege('service_role','public.commit_roster_snapshot(uuid,bigint,jsonb)','EXECUTE') service_commit")).rows[0];
    assert.equal(permissions.anon_commit, false); assert.equal(permissions.user_sample, false); assert.equal(permissions.service_commit, true);
  });

  await t.test("parallel upstream cooldown extensions keep the longest pause and isolate providers", async () => {
    await reset();
    const start = Date.now();
    const requested = [600, 60, 300, 120, 480, 30, 240, 90].map(seconds => new Date(start + seconds * 1000));
    await Promise.all(requested.map(until => db.query("SELECT defer_sync_upstream('brawl',$1)", [until])));
    const max = (await db.query("SELECT value::timestamptz value FROM settings WHERE key='sync_upstream_cooldown_until'")).rows[0].value;
    assert.equal(max.getTime(), start + 600000);
    const shorter = (await db.query("SELECT defer_sync_upstream('brawl',$1) value", [new Date(start + 5000)])).rows[0].value;
    assert.equal(shorter.getTime(), max.getTime());
    await db.query("SELECT defer_sync_upstream('rnt',$1)", [new Date(start + 10000)]);
    const values = Object.fromEntries((await db.query("SELECT key,value::timestamptz value FROM settings WHERE key IN ('sync_upstream_cooldown_until','sync_ranked_cooldown_until')")).rows.map(row => [row.key, row.value.getTime()]));
    assert.equal(values.sync_upstream_cooldown_until, start + 600000); assert.equal(values.sync_ranked_cooldown_until, start + 10000);
  });

  await t.test("upstream cooldown RPC rejects invalid providers and unprivileged callers", async () => {
    for (const provider of [null, "unknown"]) await assert.rejects(db.query("SELECT defer_sync_upstream($1,now())", [provider]), /invalid_upstream_cooldown/);
    await assert.rejects(db.query("SELECT defer_sync_upstream('brawl','infinity'::timestamptz)"), /invalid_upstream_cooldown/);
    const client = await db.connect();
    try {
      await client.query("BEGIN; SET LOCAL ROLE anon");
      await assert.rejects(client.query("SELECT defer_sync_upstream('brawl',now())"), /permission denied/);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    const permissions = (await db.query("SELECT has_function_privilege('authenticated','public.defer_sync_upstream(text,timestamptz)','EXECUTE') authenticated,has_function_privilege('service_role','public.defer_sync_upstream(text,timestamptz)','EXECUTE') service")).rows[0];
    assert.equal(permissions.authenticated, false); assert.equal(permissions.service, true);
  });
}

module.exports = { runAdaptiveSyncChecks };
