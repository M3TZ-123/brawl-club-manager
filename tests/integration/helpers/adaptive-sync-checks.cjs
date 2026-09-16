const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function runAdaptiveSyncChecks(t, db) {
  const migration = fs.readFileSync(path.resolve(__dirname, "../../../supabase/migrations/202609160005_adaptive_sync.sql"), "utf8");
  const previous = (await db.query("SELECT value FROM settings WHERE key='last_sync_time'")).rows[0]?.value;
  await db.query(migration);
  await db.query(fs.readFileSync(path.resolve(__dirname, "../../../supabase/migrations/202609160006_upstream_cooldowns.sql"), "utf8"));
  const portableMigration = fs.readFileSync(path.resolve(__dirname, "../../../supabase/migrations/202609160007_portable_brawler_snapshots.sql"), "utf8");
  await db.query(portableMigration);
  await db.query(fs.readFileSync(path.resolve(__dirname, "../../../supabase/migrations/202609160008_ranked_attempt_gate.sql"), "utf8"));
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

  await t.test("portable brawler writes support the restored production recorded_day index without rewriting unchanged rows", async () => {
    await reset(); const body = fullPayload(); await full(body);
    await db.query("DROP INDEX idx_brawler_snapshots_player_brawler_day; ALTER TABLE brawler_snapshots ADD COLUMN recorded_day date; UPDATE brawler_snapshots SET recorded_day=(recorded_at AT TIME ZONE 'UTC')::date; CREATE UNIQUE INDEX idx_brawler_snapshots_player_brawler_day ON brawler_snapshots(player_tag,brawler_id,recorded_day)");
    await db.query("CREATE FUNCTION set_brawler_recorded_day() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.recorded_day := (NEW.recorded_at AT TIME ZONE 'UTC')::date; RETURN NEW; END $$; CREATE TRIGGER trg_set_brawler_recorded_day BEFORE INSERT OR UPDATE OF recorded_at ON brawler_snapshots FOR EACH ROW EXECUTE FUNCTION set_brawler_recorded_day()");
    // Reproduce the real failure with the previous function, then install007.
    await db.query(migration);
    const old = await acquire("full"); const before = await snapshot();
    await assert.rejects(commit(old, body, "full"), error => error.code === "42P10");
    assert.deepEqual(await snapshot(), before);
    await db.query("SELECT fail_sync_run($1,$2,'snapshot_rejected','Test rollback')", [old.run_id, old.fence]);
    await db.query(portableMigration);
    const unchanged = await tableRows("brawler_snapshots", true);
    await full(body); assert.deepEqual(await tableRows("brawler_snapshots", true), unchanged);
    body.brawlers[0].power_level = 5;
    body.brawlers.push({ ...body.brawlers[0], brawler_id: 2, brawler_name: "NITA", power_level: 1 });
    await full(body);
    const rows = await tableRows("brawler_snapshots", true);
    assert.equal(rows.length, 2); assert.equal(rows.find(row => row.brawler_id === 1).id, unchanged[0].id);
    assert.equal(rows.find(row => row.brawler_id === 1).power_level, 5);
    assert.equal((await db.query("SELECT count(*)::int n FROM brawler_snapshots WHERE recorded_day IS DISTINCT FROM (recorded_at AT TIME ZONE 'UTC')::date")).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int n FROM pg_indexes WHERE tablename='brawler_snapshots' AND indexname='idx_brawler_snapshots_player_brawler_day' AND indexdef LIKE '%recorded_day%'")).rows[0].n, 1);
    const duplicate = fullPayload(); duplicate.brawlers.push({ ...duplicate.brawlers[0] });
    const run = await acquire("full"); await assert.rejects(commit(run, duplicate, "full"), /invalid_snapshot_brawlers/);
    await db.query("SELECT fail_sync_run($1,$2,'snapshot_rejected','Test duplicate')", [run.run_id, run.fence]);
  });

  await t.test("partial ranked attempts advance cadence without claiming ranked freshness and roll back with failed full sync", async () => {
    await reset();
    await full(fullPayload(undefined, { ranked_attempted: true, ranked_complete: false }));
    const attempt = async () => (await db.query("SELECT value FROM settings WHERE key='last_ranked_attempt_time'")).rows[0]?.value;
    assert.ok(await attempt()); assert.equal((await markers()).last_ranked_sync_time, undefined);
    await db.query("UPDATE settings SET value='2000-01-01T00:00:00Z' WHERE key='last_ranked_attempt_time'");
    await roster(rosterPayload(undefined, { ranked_attempted: true }));
    await commit(await acquire("member"), fullPayload(undefined, { ranked_attempted: true, ranked_complete: true }), "full");
    await full(fullPayload(undefined, { ranked_attempted: false, ranked_complete: false }));
    assert.equal(await attempt(), "2000-01-01T00:00:00Z");
    const broken = fullPayload(undefined, { ranked_attempted: true, ranked_complete: false }); broken.brawlers[0].brawler_name = "X".repeat(100);
    const run = await acquire("full"); await assert.rejects(commit(run, broken, "full"), /value too long/);
    assert.equal(await attempt(), "2000-01-01T00:00:00Z");
    await db.query("SELECT fail_sync_run($1,$2,'snapshot_rejected','Test ranked rollback')", [run.run_id, run.fence]);
    await full(fullPayload(undefined, { ranked_attempted: true, ranked_complete: true }));
    assert.equal(await attempt(), (await markers()).last_ranked_sync_time);
  });

  const beginRanked = async (run) => (await db.query("SELECT begin_sync_ranked_attempt($1,$2) allowed", [run.run_id, run.fence])).rows[0].allowed;
  const attemptMarker = async () => (await db.query("SELECT value FROM settings WHERE key='last_ranked_attempt_time'")).rows[0]?.value;
  const setRanked = async (key, value) => db.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]);

  await t.test("ranked attempt reservation survives a rejected snapshot and failed run without changing freshness", async () => {
    await reset(); await full();
    const freshness = await markers(); const before = await snapshot(); const run = await acquire("full");
    assert.equal(await beginRanked(run), true);
    const marker = await attemptMarker(); assert.ok(marker);
    assert.deepEqual(await markers(), freshness);
    const reserved = await snapshot();
    assert.deepEqual({ ...reserved, settings: before.settings }, before);
    const broken = fullPayload(); broken.brawlers[0].brawler_name = "X".repeat(100);
    await assert.rejects(commit(run, broken, "full"), /value too long/);
    assert.deepEqual(await snapshot(), reserved);
    await db.query("SELECT fail_sync_run($1,$2,'snapshot_rejected','Test reserved attempt survives')", [run.run_id, run.fence]);
    assert.equal(await attemptMarker(), marker); assert.deepEqual(await markers(), freshness);
    const retry = await acquire("full"); assert.equal(await beginRanked(retry), false);
    assert.equal(await attemptMarker(), marker);
    await db.query("SELECT fail_sync_run($1,$2,'upstream_failure','Test mandatory profile failure')", [retry.run_id, retry.fence]);
    assert.equal((await db.query("SELECT status FROM sync_runs WHERE id=$1", [run.run_id])).rows[0].status, "failed");
  });

  await t.test("concurrent ranked reservations grant one request batch and leave success markers absent", async () => {
    await reset(); const run = await acquire("full");
    const results = await Promise.all(Array.from({ length: 8 }, () => beginRanked(run)));
    assert.equal(results.filter(Boolean).length, 1); assert.equal(results.filter(value => !value).length, 7);
    assert.deepEqual(await markers(), {});
    assert.equal((await db.query("SELECT status FROM sync_runs WHERE id=$1", [run.run_id])).rows[0].status, "running");
  });

  await t.test("ranked reservation rejects expired, replaced, completed and null fences plus non-full scopes", async () => {
    await reset(); const expired = await acquire("full");
    await db.query("UPDATE sync_leases SET expires_at=now()-interval '1 second'");
    await assert.rejects(beginRanked(expired), /stale_sync_fence/);
    const replacement = await acquire("full");
    await assert.rejects(beginRanked(expired), /stale_sync_fence/);
    await assert.rejects(beginRanked({ ...replacement, fence: null }), /stale_sync_fence/);
    await assert.rejects(beginRanked({ ...replacement, fence: replacement.fence + 1 }), /stale_sync_fence/);
    assert.equal(await attemptMarker(), undefined);
    await commit(replacement, fullPayload(), "full");
    await assert.rejects(beginRanked(replacement), /stale_sync_fence/);
    for (const scope of ["member", "roster"]) {
      await reset(); await assert.rejects(beginRanked(await acquire(scope)), /sync_scope_mismatch/);
      assert.equal(await attemptMarker(), undefined);
    }
    await assert.rejects(beginRanked({ run_id: null, fence: 1 }), /stale_sync_fence/);
  });

  await t.test("ranked reservation rereads club configuration, provider cooldown and configured cadence", async () => {
    await reset(); const run = await acquire("full");
    await setRanked("club_tag", "#OTHER");
    await assert.rejects(beginRanked(run), /club_configuration_changed/);
    assert.equal(await attemptMarker(), undefined);
    await setRanked("club_tag", " %23club ");
    await db.query("SELECT defer_sync_upstream('rnt',now()+interval '5 minutes')");
    assert.equal(await beginRanked(run), false); assert.equal(await attemptMarker(), undefined);
    await setRanked("sync_ranked_cooldown_until", "2000-01-01T00:00:00Z");
    await setRanked("last_ranked_sync_time", new Date(Date.now() - 50 * 60000).toISOString());
    await setRanked("sync_ranked_interval_minutes", "60");
    assert.equal(await beginRanked(run), false); assert.equal(await attemptMarker(), undefined);
    await setRanked("sync_ranked_interval_minutes", "30");
    const before = await markers(); assert.equal(await beginRanked(run), true);
    assert.deepEqual(await markers(), before);
  });

  await t.test("ranked reservation enforces attempt precedence and the cadence boundary with safe invalid-setting defaults", async () => {
    await reset(); const run = await acquire("full");
    await setRanked("last_ranked_sync_time", "2000-01-01T00:00:00Z");
    await setRanked("last_ranked_attempt_time", new Date(Date.now() - 28 * 60000).toISOString());
    for (const invalid of ["invalid", "9", "1441", "Infinity", "NaN", ""]) {
      await setRanked("sync_ranked_interval_minutes", invalid);
      assert.equal(await beginRanked(run), false, invalid);
    }
    await setRanked("last_ranked_attempt_time", new Date(Date.now() - 29 * 60000 - 1000).toISOString());
    assert.equal(await beginRanked(run), true);
    await setRanked("sync_ranked_interval_minutes", "10");
    await setRanked("last_ranked_attempt_time", new Date(Date.now() - 8 * 60000).toISOString());
    assert.equal(await beginRanked(run), false);
    await setRanked("last_ranked_attempt_time", new Date(Date.now() - 9 * 60000 - 1000).toISOString());
    assert.equal(await beginRanked(run), true);
    await setRanked("last_ranked_attempt_time", "invalid-date");
    await setRanked("sync_ranked_cooldown_until", "invalid-date");
    assert.equal(await beginRanked(run), true);
    await setRanked("last_ranked_attempt_time", "infinity");
    assert.equal(await beginRanked(run), true);
  });

  await t.test("ranked reservation sees a settings update committed while it waits for the row lock", async () => {
    await reset(); const run = await acquire("full");
    await setRanked("last_ranked_attempt_time", "2000-01-01T00:00:00Z");
    const updater = await db.connect(); const caller = await db.connect();
    let pending;
    try {
      await updater.query("BEGIN");
      await updater.query("UPDATE settings SET value=clock_timestamp()::text WHERE key='last_ranked_attempt_time'");
      pending = caller.query("SELECT begin_sync_ranked_attempt($1,$2) allowed", [run.run_id, run.fence]);
      const deadline = Date.now() + 4000; let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await db.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1", [caller.processID])).rows[0]?.waiting;
        if (!waiting) await db.query("SELECT pg_sleep(0.01)");
      }
      assert.equal(waiting, true, "reservation must wait for the locked settings row");
      await updater.query("COMMIT");
      assert.equal((await pending).rows[0].allowed, false);
      assert.deepEqual(await markers(), {});
    } finally {
      await updater.query("ROLLBACK");
      if (pending) await pending.catch(() => {});
      updater.release(); caller.release();
    }
  });

  await t.test("only the service role may reserve ranked requests", async () => {
    await reset(); const run = await acquire("full");
    const permissions = (await db.query("SELECT has_function_privilege('anon','public.begin_sync_ranked_attempt(uuid,bigint)','EXECUTE') anon,has_function_privilege('authenticated','public.begin_sync_ranked_attempt(uuid,bigint)','EXECUTE') authenticated,has_function_privilege('service_role','public.begin_sync_ranked_attempt(uuid,bigint)','EXECUTE') service")).rows[0];
    assert.deepEqual(permissions, { anon: false, authenticated: false, service: true });
    const client = await db.connect();
    try {
      for (const role of ["anon", "authenticated"]) {
        await client.query(`BEGIN; SET LOCAL ROLE ${role}`);
        await assert.rejects(client.query("SELECT begin_sync_ranked_attempt($1,$2)", [run.run_id, run.fence]), /permission denied/);
        await client.query("ROLLBACK");
      }
      await client.query("BEGIN; SET LOCAL ROLE service_role");
      assert.equal((await client.query("SELECT begin_sync_ranked_attempt($1,$2) allowed", [run.run_id, run.fence])).rows[0].allowed, true);
      await client.query("COMMIT");
      assert.ok(await attemptMarker()); assert.deepEqual(await markers(), {});
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
}

module.exports = { runAdaptiveSyncChecks };
