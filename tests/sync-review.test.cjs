const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const hoursAgo = (hours) => new Date(NOW - hours * 3600000).toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const quietConsole = { log() {}, warn() {}, error() {} };
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
const historyRow = (tag, extra = {}) => ({
  player_tag: tag, player_name: tag, first_seen: "2026-08-01T00:00:00.000Z",
  last_seen: hoursAgo(24), last_left_at: null, times_joined: 1, times_left: 0,
  is_current_member: true, role_at_leave: null, trophies_at_leave: null,
  notes: "Keep this administrator note", ...extra,
});
const battleRow = (tag = "#P", age = 1) => ({
  player_tag: tag, battle_time: hoursAgo(age), result: "victory", trophy_change: 8,
  is_star_player: false, mode: "gemGrab", map: "Test", brawler_name: "SHELLY",
  brawler_power: 2, brawler_trophies: 100, teams_json: null,
});

// Implements the relevant PostgREST result/error and bulk-upsert semantics.
// Every request remains in memory; no environment credentials are read.
function makeDatabase(initial, fail) {
  const tables = clone(initial);
  const requests = [];
  const completed = [];
  return { tables, requests, completed, from(table) {
    const request = { table, op: "select", filters: [], body: undefined, conflict: undefined };
    let shouldThrow = false;
    let single = false;
    let range;
    let promise;
    const matches = (row) => request.filters.every(([op, key, value]) => {
      if (op === "in") return value.includes(row[key]);
      if (op === "eq") return row[key] === value;
      if (op === "gte") return row[key] >= value;
      if (op === "lt") return row[key] < value;
      return true;
    });
    const query = {
      select(columns) { request.columns = columns; return query; },
      order() { return query; },
      range(from, to) { range = [from, to]; return query; },
      in(key, value) { request.filters.push(["in", key, value]); return query; },
      eq(key, value) { request.filters.push(["eq", key, value]); return query; },
      gte(key, value) { request.filters.push(["gte", key, value]); return query; },
      lt(key, value) { request.filters.push(["lt", key, value]); return query; },
      maybeSingle() { single = true; return query; },
      upsert(body, options) { request.op = "upsert"; request.body = clone(body); request.conflict = options?.onConflict; return query; },
      insert(body) { request.op = "insert"; request.body = clone(body); return query; },
      update(body) { request.op = "update"; request.body = clone(body); return query; },
      delete() { request.op = "delete"; return query; },
      throwOnError() { shouldThrow = true; return query; },
      then(resolve, reject) {
        promise ??= Promise.resolve().then(async () => {
          requests.push(request);
          if (fail?.(request)) {
            const error = new Error(`Simulated ${table} ${request.op} failure`);
            if (shouldThrow) throw error;
            return { data: null, error };
          }
          let rows = tables[table] ||= [];
          let data = null;
          if (request.op === "select") {
            data = rows.filter(matches);
            if (range) data = data.slice(range[0], range[1] + 1);
            if (single) data = data[0] || null;
          } else if (request.op === "upsert") {
            if (table === "members") await new Promise((done) => setImmediate(done));
            const incoming = Array.isArray(request.body) ? request.body : [request.body];
            const columns = [...new Set(incoming.flatMap(Object.keys))];
            const keys = (request.conflict || "player_tag").split(",");
            for (const row of incoming) {
              const existing = rows.find((candidate) => keys.every((key) => candidate[key] === row[key]));
              const record = Object.fromEntries(columns.map((key) => [key, row[key] ?? null]));
              if (existing) Object.assign(existing, record);
              else rows.push(record);
            }
          } else if (request.op === "insert") {
            const incoming = Array.isArray(request.body) ? request.body : [request.body];
            if (table === "activity_log") {
              assert.ok(incoming.every((row) => tables.members.some((member) => member.player_tag === row.player_tag)), "activity FK requires committed members");
            }
            rows.push(...incoming);
          } else if (request.op === "update") {
            for (const row of rows.filter(matches)) Object.assign(row, request.body);
          } else if (request.op === "delete") {
            tables[table] = rows.filter((row) => !matches(row));
          }
          completed.push(request);
          return { data, error: null };
        });
        return promise.then(resolve, reject);
      },
    };
    return query;
  }};
}

async function runSync(options = {}) {
  const tags = options.tags || ["#P"];
  let virtualNow = NOW;
  const deadlines = [];
  class SyncDate extends Date {
    constructor(...args) { super(...(args.length ? args : [virtualNow])); }
    static now() { return virtualNow; }
  }
  const defaults = {
    settings: [
      { key: "club_tag", value: "#CLUB" }, { key: "api_key", value: "test-only" },
      { key: "notifications_enabled", value: "false" },
      { key: "inactivity_threshold", value: String(options.threshold || 48) },
    ],
    members: tags.map((tag) => ({ player_tag: tag, player_name: tag, trophies: 100, role: "member", rank_current: "Diamond I", rank_highest: "Diamond II" })),
    member_history: tags.map((tag) => historyRow(tag)), activity_log: [], battle_history: [],
    daily_stats: [], player_tracking: [], brawler_snapshots: [], club_events: [], notifications: [],
  };
  const db = makeDatabase({ ...defaults, ...options.tables }, options.fail);
  const rankedSignals = [];
  const rankedCalls = [];
  let rankedInFlight = 0;
  let peakRankedInFlight = 0;
  const playerCalls = [];
  const brawlers = options.brawlers || [];
  const api = {
    getClub: async () => ({ members: tags.map((tag) => ({ tag, name: tag, role: "member" })), requiredTrophies: 1000 }),
    getPlayer: async (tag) => {
      playerCalls.push(tag);
      if (options.failPlayer) throw new Error("Primary API unavailable");
      if (options.primaryBatchMs) {
        await new Promise((done) => setImmediate(done));
        const index = tags.indexOf(tag);
        if (index % 4 === 3 || index === tags.length - 1) {
          virtualNow += options.primaryBatchMs;
          for (const deadline of deadlines) if (deadline.at <= virtualNow) deadline.controller.abort();
        }
      }
      return { trophies: options.trophies ?? 100, highestTrophies: 100, expLevel: 10, icon: { id: 1 }, brawlers, soloVictories: 0, duoVictories: 0, "3vs3Victories": 0 };
    },
    getPlayerRankedData: async (tag, { signal }) => {
      rankedSignals.push(signal);
      if (!signal.aborted) {
        rankedCalls.push(tag);
        rankedInFlight++;
        peakRankedInFlight = Math.max(peakRankedInFlight, rankedInFlight);
        if (options.waitRankedForAbort) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        } else {
          await Promise.resolve();
        }
        rankedInFlight--;
        if (options.rankedSuccess) return { currentRank: "Mythic I", highestRank: "Mythic II" };
      }
      return { currentRank: "Unranked", highestRank: "Unranked" };
    },
    getPlayerBattleLog: async (tag) => ({ items: (options.battles || []).filter((battle) => battle.player_tag === tag) }),
    processBattleLog: (_tag, log) => log.items,
    calculateWinRateFromBattleLog: () => ({ winRate: null }),
  };
  const route = loadTypeScript("src/app/api/sync/route.ts", {
    "@/lib/supabase-admin": { supabaseAdmin: db }, "@/lib/brawl-api": api,
    "@/lib/admin-auth": { rejectUnauthorizedAdminMutation: () => null },
    "next/server": { NextResponse: { json: (body, init) => ({ body, status: init?.status || 200 }) } },
  }, {
    Date: options.primaryBatchMs ? SyncDate : FixedDate,
    ...(options.primaryBatchMs ? { AbortSignal: {
      any: (signals) => AbortSignal.any(signals),
      timeout: (milliseconds) => {
        const controller = new AbortController();
        deadlines.push({ at: virtualNow + milliseconds, controller });
        return controller.signal;
      },
    } } : {}),
    console: quietConsole, setTimeout: (fn) => { fn(); return 0; },
  });
  const response = await route.POST({ json: async () => ({}) });
  return { ...db, response, rankedSignals, rankedCalls, rankedInFlight, peakRankedInFlight, playerCalls, virtualElapsed: virtualNow - NOW };
}
const syncMarker = (result) => result.tables.settings.find((row) => row.key === "last_sync_time");

test("mixed member transitions preserve all history fields and administrator notes", async () => {
  const rows = [
    historyRow("#P", { times_joined: 3, times_left: 2, last_left_at: hoursAgo(100), role_at_leave: "senior", trophies_at_leave: 90 }),
    historyRow("#RETURN", { is_current_member: false, times_joined: 2, times_left: 2 }),
    historyRow("#LEFT", { times_joined: 4, times_left: 3 }),
    historyRow("#NULL", { first_seen: null, times_joined: null, times_left: null }),
  ];
  const result = await runSync({ tags: ["#P", "#RETURN", "#NEW", "#NULL"], tables: { member_history: rows } });
  assert.equal(result.response.status, 200);
  const saved = new Map(result.tables.member_history.map((row) => [row.player_tag, row]));
  for (const key of ["first_seen", "times_joined", "times_left", "last_left_at", "role_at_leave", "trophies_at_leave", "notes"]) {
    assert.equal(saved.get("#P")[key], rows[0][key], key);
  }
  assert.equal(saved.get("#RETURN").times_joined, 3);
  assert.equal(saved.get("#LEFT").times_left, 4);
  assert.equal(saved.get("#LEFT").is_current_member, false);
  assert.equal(saved.get("#NULL").first_seen, null);
  assert.equal(saved.get("#NULL").times_joined, null);
  const payload = result.requests.find((request) => request.table === "member_history" && request.op === "upsert").body;
  assert.ok(payload.every((row) => !Object.hasOwn(row, "notes")));
  assert.equal(new Set(payload.map((row) => Object.keys(row).sort().join(","))).size, 1);
});

test("new member parent writes finish before dependent activity and final sync marker", async () => {
  const result = await runSync({ tables: { members: [], member_history: [] } });
  assert.equal(result.response.status, 200);
  const memberCommit = result.completed.findIndex((request) => request.table === "members" && request.op === "upsert");
  const activityCommit = result.completed.findIndex((request) => request.table === "activity_log" && request.op === "insert");
  assert.ok(memberCommit >= 0 && memberCommit < activityCommit);
  assert.equal(result.completed.at(-1).body.key, "last_sync_time");
  assert.equal(syncMarker(result).value, result.response.body.timestamp);
});

test("all critical database failures fail sync without advancing success timestamp", async (t) => {
  const targets = [
    ["members", "upsert"], ["activity_log", "insert"], ["member_history", "upsert"],
    ["club_events", "select"], ["club_events", "insert"], ["battle_history", "select"],
    ["battle_history", "upsert"], ["battle_history", "delete"], ["daily_stats", "upsert"],
    ["daily_stats", "select"], ["daily_stats", "delete"], ["brawler_snapshots", "select"],
    ["brawler_snapshots", "delete"], ["brawler_snapshots", "insert"],
    ["player_tracking", "select"], ["player_tracking", "upsert"],
    ["notifications", "select"], ["notifications", "upsert"],
  ];
  for (const [table, op] of targets) {
    await t.test(`${table} ${op}`, async () => {
      const result = await runSync({
        battles: [battleRow()], brawlers: [{ id: 1, name: "SHELLY", power: 2, trophies: 100, rank: 1 }],
        tables: {
          member_history: [historyRow("#OLD", { is_current_member: false })],
          settings: [
            { key: "club_tag", value: "#CLUB" }, { key: "api_key", value: "test-only" },
            { key: "notifications_enabled", value: "true" },
          ],
          brawler_snapshots: [{ player_tag: "#P", brawler_id: 1, power_level: 1, recorded_at: hoursAgo(24) }],
        },
        fail: (request) => request.table === table && request.op === op,
      });
      assert.equal(result.response.status, 500, `${table} ${op}: ${JSON.stringify(result.response)}`);
      assert.equal(syncMarker(result), undefined);
    });
  }
  for (const key of ["required_trophies", "last_sync_time", "last_inactive_notif"]) {
    await t.test(`settings ${key}`, async () => {
      const result = await runSync({ tables: { settings: [
        { key: "club_tag", value: "#CLUB" }, { key: "api_key", value: "test-only" },
        { key: "notifications_enabled", value: "true" },
      ] }, fail: (request) => request.table === "settings" && request.op === "upsert" && request.body.key === key });
      assert.equal(result.response.status, 500);
      assert.equal(syncMarker(result), undefined);
    });
  }
});

test("a primary API failure stops after the first batch and writes no success marker", async () => {
  const result = await runSync({ tags: Array.from({ length: 30 }, (_, i) => `#P${i}`), failPlayer: true });
  assert.equal(result.response.status, 500);
  assert.equal(result.playerCalls.length, 4);
  assert.equal(result.requests.filter((request) => request.op !== "select").length, 0);
});

test("primary failure cancels and settles pending ranked workers before returning", async () => {
  const result = await runSync({
    tags: Array.from({ length: 30 }, (_, i) => `#P${i}`), failPlayer: true, waitRankedForAbort: true,
  });
  assert.equal(result.response.status, 500);
  assert.equal(result.rankedCalls.length, 4);
  assert.equal(result.rankedInFlight, 0);
  assert.ok(result.rankedSignals.every((signal) => signal.aborted));
  assert.equal(syncMarker(result), undefined);
});

test("repeated minimal labels cannot renew an old battle's inactivity deadline", async () => {
  const result = await runSync({
    battles: [battleRow("#P", 49)],
    tables: { activity_log: [{ player_tag: "#P", trophy_change: 0, activity_type: "minimal", recorded_at: hoursAgo(1) }] },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.tables.members[0].is_active, false);
  assert.equal(result.tables.activity_log.at(-1).activity_type, "inactive");
});

test("activity keeps original battle and trophy-change timestamps with configurable cutoffs", async () => {
  const cached = await runSync({ threshold: 96, tables: { battle_history: [battleRow("#P", 72)] } });
  assert.equal(cached.tables.members[0].is_active, true);
  assert.equal(cached.tables.activity_log.at(-1).activity_type, "minimal");
  const trophyChange = await runSync({ trophies: 110 });
  assert.equal(trophyChange.tables.activity_log.at(-1).activity_type, "active");
  const previousDelta = await runSync({ tables: { activity_log: [{ player_tag: "#P", trophy_change: 10, activity_type: "minimal", recorded_at: hoursAgo(25) }] } });
  assert.equal(previousDelta.tables.activity_log.at(-1).activity_type, "minimal");
});

test("every ranked lookup shares one whole-sync deadline and unavailable ranks preserve cached data", async () => {
  const result = await runSync({ tags: Array.from({ length: 30 }, (_, i) => `#P${i}`) });
  assert.equal(result.response.status, 200);
  assert.equal(result.rankedSignals.length, 30);
  assert.equal(new Set(result.rankedSignals).size, 1);
  assert.ok(result.rankedSignals[0] instanceof AbortSignal);
  assert.ok(result.tables.members.every((member) => member.rank_current === "Diamond I"));
});

test("slow mandatory batches cannot starve ranked refreshes for the final club member", async () => {
  const tags = Array.from({ length: 30 }, (_, i) => `#P${i}`);
  const result = await runSync({ tags, primaryBatchMs: 1500, rankedSuccess: true });
  assert.equal(result.response.status, 200);
  assert.ok(result.virtualElapsed > 8000, "mandatory batches consumed more than the ranked deadline");
  assert.equal(result.rankedCalls.length, 30);
  assert.ok(result.rankedCalls.includes(tags.at(-1)));
  assert.equal(result.tables.members.find((member) => member.player_tag === tags.at(-1)).rank_current, "Mythic I");
  assert.equal(result.peakRankedInFlight, 4);
});

function loadBrawlApi(axios) {
  return loadTypeScript("src/lib/brawl-api.ts", { axios, "./utils": { encodeTag: encodeURIComponent } }, { console: quietConsole, setTimeout: (fn) => { fn(); return 0; } });
}

test("ranked cancellation ends retry work and skips subsequent requests", async () => {
  const controller = new AbortController();
  let calls = 0;
  const api = loadBrawlApi({
    create: () => ({}), isCancel: () => true,
    get: async (_url, options) => { calls++; assert.equal(options.signal, controller.signal); controller.abort(); throw new Error("cancelled"); },
  });
  const first = await api.getPlayerRankedData("#P", { signal: controller.signal });
  const later = await api.getPlayerRankedData("#OTHER", { signal: controller.signal });
  assert.equal(first.currentRank, "Unranked");
  assert.equal(later.currentRank, "Unranked");
  assert.equal(calls, 1);
});

test("translated Brawl API failures retain status and verification returns actionable errors", async (t) => {
  for (const status of [403, 404, 429]) {
    await t.test(String(status), async () => {
      const api = loadBrawlApi({
        create: () => ({ get: async () => { throw { isAxiosError: true, response: { status, data: { reason: "test failure" } }, config: {} }; } }),
        isAxiosError: (error) => error.isAxiosError === true,
      });
      await assert.rejects(api.getClub("#CLUB", "test-only"), (error) => error instanceof api.BrawlApiError && error.status === status);
      const route = loadTypeScript("src/app/api/verify-club/route.ts", {
        "@/lib/brawl-api": api, "@/lib/admin-auth": { rejectUnauthorizedAdminMutation: () => null },
        "next/server": { NextResponse: { json: (body, init) => ({ body, status: init?.status || 200 }) } },
      }, { console: quietConsole });
      const result = await route.POST({ json: async () => ({ clubTag: "#CLUB", apiKey: "test-only" }) });
      assert.equal(result.status, status);
      assert.ok(result.body.error);
    });
  }
});
