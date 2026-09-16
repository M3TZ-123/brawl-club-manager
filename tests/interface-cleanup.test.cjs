const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { readOnlyDatabase } = require("./helpers/read-only-database.cjs");

const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const DAY = 86_400_000;
const ago = days => new Date(NOW - days * DAY).toISOString();
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
const next = { NextResponse: { json: (body, init) => Response.json(body, init) } };
const publicAuth = { rejectUnauthorizedAdminMutation: () => null, verifyAdminSession: () => false };
const forbidden = () => { throw new Error("Unexpected private review or database mutation in range test"); };
function rangeRoute(path, tables) {
  const source = readOnlyDatabase(tables);
  const database = { from(table) {
    const query = source.from(table);
    query.not = (column, operator, value) => {
      assert.equal(operator, "is");
      return query.neq(column, value);
    };
    return query;
  } };
  return loadTypeScript(path, {
    "next/server": next,
    "@/lib/supabase-admin": { supabaseAdmin: database },
    "@/lib/admin-auth": publicAuth,
    "@/lib/member-reviews": { loadMemberReviews: forbidden, saveMemberReview: forbidden, ReviewInputError: class extends Error {} },
  }, { Date: FixedDate });
}
async function get(route, endpoint, query = "") {
  const response = await route.GET(new Request(`http://fixture/api/${endpoint}${query ? `?${query}` : ""}`));
  assert.equal(response.status, 200);
  return response.json();
}

const ages = [0.5, 2, 5, 20, 60, 120];
const history = ages.map((age, index) => ({ player_tag: `#P${index}`, player_name: `Player ${index}`, first_seen: ago(age), last_seen: ago(0), is_current_member: true }));
history.push(
  { player_tag: "#RETURN", first_seen: ago(400), last_seen: ago(0), is_current_member: true },
  { player_tag: "#OLD", first_seen: ago(400), last_seen: ago(0), is_current_member: true },
  { player_tag: "#LEFT", first_seen: ago(400), last_left_at: ago(20), last_seen: ago(0), is_current_member: false },
  { player_tag: "#LEGACY", first_seen: ago(400), last_left_at: null, last_seen: ago(5), is_current_member: false },
);
const historyTables = { member_history: history, club_events: [{ id: 1, player_tag: "#RETURN", event_type: "join", event_time: ago(0.25) }] };
const tags = rows => rows.map(row => row.player_tag).sort();

test("history periods filter observed membership changes, including later rejoins and legacy departures", async () => {
  const route = rangeRoute("src/app/api/history/route.ts", historyTables);
  const expected = {
    "24h": ["#P0", "#RETURN"],
    "3d": ["#P0", "#P1", "#RETURN"],
    "7d": ["#LEGACY", "#P0", "#P1", "#P2", "#RETURN"],
    "30d": ["#LEFT", "#LEGACY", "#P0", "#P1", "#P2", "#P3", "#RETURN"],
    "90d": ["#LEFT", "#LEGACY", "#P0", "#P1", "#P2", "#P3", "#P4", "#RETURN"],
  };
  for (const [range, expectedTags] of Object.entries(expected)) {
    const body = await get(route, "history", `range=${range}`);
    assert.deepEqual(tags(body.history), expectedTags, range);
    assert.equal(body.history.some(row => row.player_tag === "#OLD"), false, "A recently seen stable roster member is not a recent membership change");
  }
  assert.deepEqual(tags((await get(route, "history", "range=constructor")).history), expected["7d"], "Unknown range falls back to seven days");
});

test("history keeps inclusive cutoffs, legacy days filters and explicit all-history access", async () => {
  const route = rangeRoute("src/app/api/history/route.ts", historyTables);
  assert.deepEqual(tags((await get(route, "history", "days=3")).history), ["#P0", "#P1", "#RETURN"]);
  assert.equal((await get(route, "history", "range=all&days=1")).history.length, history.length);
  assert.equal((await get(route, "history")).history.length, history.length);
  const boundary = rangeRoute("src/app/api/history/route.ts", {
    member_history: [
      { player_tag: "#AT", first_seen: ago(30), is_current_member: true },
      { player_tag: "#BEFORE", first_seen: new Date(NOW - 30 * DAY - 1).toISOString(), is_current_member: true },
    ], club_events: [],
  });
  assert.deepEqual(tags((await get(boundary, "history", "range=30d")).history), ["#AT"]);
});

test("notification ranges apply before pagination and combine with type and unread filters", async () => {
  const notifications = ages.map((age, index) => ({ id: index + 1, type: "promotion", is_read: false, created_at: ago(age), title: `Promotion ${index}` }));
  notifications.push(
    { id: 20, type: "promotion", is_read: true, created_at: ago(0.1) },
    { id: 21, type: "join", is_read: false, created_at: ago(0.1) },
    { id: 22, type: "promotion", is_read: false, created_at: ago(-1) },
  );
  const route = rangeRoute("src/app/api/notifications/route.ts", { notifications });
  for (const [range, expectedIds] of [["24h", [1]], ["3d", [1, 2]], ["7d", [1, 2, 3]], ["30d", [1, 2, 3, 4]], ["90d", [1, 2, 3, 4, 5]]]) {
    const result = [], offsets = new Set();
    let offset = 0;
    do {
      assert.equal(offsets.has(offset), false, "Pagination must advance"); offsets.add(offset);
      const body = await get(route, "notifications", `range=${range}&types=promotion&unreadOnly=true&limit=2&offset=${offset}`);
      result.push(...body.notifications.map(row => row.id));
      assert.equal(body.unreadCount, 8, "The global unread badge remains independent of the visible period");
      offset = body.nextOffset;
    } while (offset != null);
    assert.deepEqual(result, expectedIds, range);
  }
  const fallback = await get(route, "notifications", "range=invalid&types=promotion&unreadOnly=true");
  assert.deepEqual(fallback.notifications.map(row => row.id), [1, 2, 3]);
});

test("notification range cutoffs are inclusive and cannot include future-dated records", async () => {
  const route = rangeRoute("src/app/api/notifications/route.ts", { notifications: [
    { id: 1, is_read: false, created_at: ago(30) },
    { id: 2, is_read: false, created_at: new Date(NOW - 30 * DAY - 1).toISOString() },
    { id: 3, is_read: false, created_at: new Date(NOW + 1).toISOString() },
  ] });
  assert.deepEqual((await get(route, "notifications", "range=30d")).notifications.map(row => row.id), [1]);
  assert.equal((await get(route, "notifications")).notifications.length, 3, "Omitting the optional period preserves the existing all-history API");
});

const battles = ages.map(age => ({ player_tag: "#A", battle_time: ago(age), mode: "brawlBall", map: `Age ${age}`, result: "victory", teams_json: null }));
battles.push(
  { player_tag: "#B", battle_time: ago(0.25), mode: "duels", map: "Other current player", teams_json: null },
  { player_tag: "#OUTSIDE", battle_time: ago(0.1), mode: "brawlBall", map: "Former player", teams_json: null },
  { player_tag: "#A", battle_time: ago(-1), mode: "brawlBall", map: "Future", teams_json: null },
);
const battleTables = {
  battle_history: battles,
  members: ["#A", "#B"].map(player_tag => ({ player_tag, player_name: player_tag })),
  member_history: ["#A", "#B"].map(player_tag => ({ player_tag, is_current_member: true })),
};

test("battle feed periods preserve player and mode filters, pagination, and current-roster scope", async () => {
  const route = rangeRoute("src/app/api/battles/feed/route.ts", battleTables);
  for (const [range, count] of [["24h", 1], ["3d", 2], ["7d", 3], ["30d", 4], ["90d", 5]]) {
    const matches = [], offsets = new Set();
    let offset = 0;
    do {
      assert.equal(offsets.has(offset), false); offsets.add(offset);
      const body = await get(route, "battles/feed", `range=${range}&player=%23A&mode=brawlBall&limit=2&offset=${offset}`);
      assert.equal(body.total, count);
      matches.push(...body.matches);
      offset = body.nextOffset;
    } while (offset != null);
    assert.deepEqual(matches.map(match => match.map), ages.slice(0, count).map(age => `Age ${age}`), range);
  }
  const current = await get(route, "battles/feed", "range=24h");
  assert.deepEqual(current.matches.map(match => match.map), ["Other current player", "Age 0.5"]);
  assert.equal((await get(route, "battles/feed", "range=invalid&player=%23A")).matches.length, 3);
});

test("an exact battle date overrides the rolling period and impossible dates are rejected", async () => {
  const route = rangeRoute("src/app/api/battles/feed/route.ts", battleTables);
  const oldDate = ago(60).slice(0, 10);
  const exact = await get(route, "battles/feed", `range=24h&date=${oldDate}`);
  assert.deepEqual(exact.matches.map(match => match.map), ["Age 60"]);
  assert.equal((await get(route, "battles/feed", "range=90d&date=2026-09-17")).matches.length, 0);
  const response = await route.GET(new Request("http://fixture/api/battles/feed?date=2026-02-30"));
  assert.equal(response.status, 400);
});

test("event reset refuses an authenticated administrator with 405 and never accesses the database", async () => {
  const globals = { Date: FixedDate, process: { env: { NODE_ENV: "test", ADMIN_PASSWORD: "fixture-password", ADMIN_SESSION_SECRET: "fixture-session-secret" } } };
  const { createAdminSessionToken } = loadTypeScript("src/lib/admin-auth.ts", { "next/server": next }, globals);
  let databaseCalls = 0;
  const route = loadTypeScript("src/app/api/events/route.ts", {
    "next/server": next,
    "@/lib/supabase-admin": { supabaseAdmin: { from() { databaseCalls++; throw new Error("Event reset must not access the database"); } } },
  }, globals);
  const request = (cookie, origin = "http://localhost") => new Request("http://localhost/api/events", {
    method: "DELETE", headers: { origin, host: "localhost", ...(cookie ? { cookie: `brawlstatz_admin=${cookie}` } : {}) },
  });
  const token = createAdminSessionToken();
  const response = await route.DELETE(request(token));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match((await response.json()).error, /cannot be reset/);
  assert.equal((await route.DELETE(request(null))).status, 401);
  assert.equal((await route.DELETE(request(token, "https://untrusted.example"))).status, 403);
  assert.equal(databaseCalls, 0, "Neither successful authentication nor denied access may erase or rewrite historical evidence");
});
