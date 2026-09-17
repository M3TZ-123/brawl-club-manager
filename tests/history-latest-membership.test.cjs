const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { readOnlyDatabase } = require("./helpers/read-only-database.cjs");

const now = new Date("2026-09-17T22:00:00.000Z");
const old = "2026-01-01T00:00:00.000Z";
const recent = "2026-09-17T21:00:00.000Z";
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now.getTime(); } }
const member = (tag, values = {}) => ({ player_tag: tag, player_name: tag, first_seen: old, last_seen: recent,
  last_left_at: null, is_current_member: true, notes: "private-legacy-note", ...values });
const event = (id, tag, type, at = recent, source = "recorded", club = "#CLUB") => ({
  id, player_tag: tag, event_type: type, occurred_at: at, source, club_tag: club,
  actor: "private-actor", provenance: { private: true }, before_snapshot: { private: true }, after_snapshot: { private: true },
});

function fixture({ history = [], events = [], settings = [{ key: "club_tag", value: "#CLUB" }], changeClub = false, failEvents = false, admin = false } = {}) {
  const tables = { member_history: history, membership_change_events: events, settings };
  const calls = [], logs = [];
  const read = readOnlyDatabase(tables);
  let configReads = 0;
  const database = { from(table) {
    if (table === "settings" && ++configReads === 2 && changeClub) tables.settings[0].value = "#OTHER";
    const query = read.from(table), call = { table, operations: [] }; calls.push(call);
    for (const name of ["select", "eq", "in", "lte", "order", "range"]) {
      const original = query[name];
      query[name] = (...args) => { call.operations.push(JSON.parse(JSON.stringify([name, ...args]))); return original(...args); };
    }
    if (table === "membership_change_events" && failEvents) query.then = (resolve, reject) => Promise.resolve({ data: null, error: { message: "private-database-error" } }).then(resolve, reject);
    return query;
  } };
  const { GET } = loadTypeScript("src/app/api/history/route.ts", {
    "@/lib/supabase-admin": { supabaseAdmin: database },
    "@/lib/admin-auth": { verifyAdminSession: () => admin },
    "@/lib/member-reviews": { loadMemberReviews: async () => [{ player_tag: "#AA", notes: "current-private-note", updated_at: recent }], ReviewInputError: class extends Error {} },
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
  }, { Date: FixedDate, console: { error: (...args) => logs.push(args.map(String)) } });
  return { tables, calls, logs, get: (range = "all") => GET(new Request(`https://fixture/api/history?range=${range}`)) };
}

test("latest history action is the newest club-scoped membership event, even after a return and newer routine changes", async () => {
  const f = fixture({ history: [member("#AA", { last_left_at: "2026-09-10T10:00:00Z", times_joined: 2 }), member("#BB")], events: [
    event("1", "#AA", "leave", "2026-09-10T10:00:00Z"), event("2", "#AA", "join"),
    event("3", "#AA", "name_change", "2026-09-17T21:30:00Z"), event("4", "#AA", "promotion", "2026-09-17T21:40:00Z"),
    event("5", "#AA", "data_repair", "2026-09-17T21:45:00Z"), event("6", "#AA", "leave", "2026-09-17T21:50:00Z", "recorded", "#OTHER"),
    event("7", "#AA", "leave", "2026-09-18T00:00:00Z"), event("8", "#UNLISTED", "join"),
  ] });
  const response = await f.get("7d"); assert.equal(response.status, 200);
  const { history } = await response.json(); assert.equal(history.length, 1);
  assert.deepEqual(history[0].latest_membership_event, { type: "join", at: recent, source: "recorded" });
  assert.equal(history[0].last_left_at, "2026-09-10T10:00:00Z");
  assert.equal(f.tables.member_history[0].last_left_at, "2026-09-10T10:00:00Z");
});

test("all-time history preserves unknown dates and fallback provenance without converting sync observations into departures", async () => {
  const f = fixture({ history: [member("#FIRST"), member("#LEFT", { is_current_member: false, last_left_at: recent }),
    member("#LEGACY", { is_current_member: false }), member("#UNKNOWN", { first_seen: null }),
    member("#INVALID", { first_seen: "invalid", last_left_at: "2026-09-18T00:00:00Z" }),
  ] });
  const body = await (await f.get()).json(), rows = new Map(body.history.map(row => [row.player_tag, row]));
  assert.equal(rows.size, 5);
  assert.deepEqual(rows.get("#FIRST").latest_membership_event, { type: "initial_seen", at: old, source: "unknown" });
  assert.deepEqual(rows.get("#LEFT").latest_membership_event, { type: "leave", at: recent, source: "unknown" });
  assert.deepEqual(rows.get("#LEGACY").latest_membership_event, { type: "initial_seen", at: old, source: "unknown" });
  assert.equal(rows.get("#UNKNOWN").latest_membership_event, null); assert.equal(rows.get("#INVALID").latest_membership_event, null);
  assert.deepEqual((await (await f.get("24h")).json()).history.map(row => row.player_tag), ["#LEFT"]);
});

test("source provenance is retained and ties prefer recorded evidence then stable event identifiers", async () => {
  const f = fixture({ history: [member("#AA"), member("#BB"), member("#CC")], events: [
    event("9", "#AA", "leave", recent, "reconstructed"), event("1", "#AA", "join", recent, "recorded"),
    event("2", "#BB", "initial_seen", recent, "reconstructed"), event("1", "#BB", "leave", recent, "reconstructed"),
    event("1", "#CC", "join", recent, "unknown"),
  ] });
  const rows = new Map((await (await f.get()).json()).history.map(row => [row.player_tag, row.latest_membership_event]));
  assert.deepEqual(rows.get("#AA"), { type: "join", at: recent, source: "recorded" });
  assert.deepEqual(rows.get("#BB"), { type: "initial_seen", at: recent, source: "reconstructed" });
  assert.equal(rows.get("#CC").source, "unknown");
});

test("PostgreSQL sub-millisecond timestamps keep their actual order before source/id tie preference", async () => {
  const f = fixture({ history: [member("#AA"), member("#BB", { first_seen: null })], events: [
    event("9", "#AA", "leave", "2026-09-17T21:00:00.123456Z", "recorded"),
    event("1", "#AA", "join", "2026-09-17T21:00:00.123457Z", "reconstructed"),
    event("1", "#BB", "join", "2026-09-17T22:00:00.000001Z", "recorded"),
  ] });
  const rows = new Map((await (await f.get()).json()).history.map(row => [row.player_tag, row.latest_membership_event]));
  assert.deepEqual(rows.get("#AA"), { type: "join", at: "2026-09-17T21:00:00.123457Z", source: "reconstructed" });
  assert.equal(rows.get("#BB"), null, "A future event within the same millisecond is still future evidence");
});

test("provenance ties at a1000-row page boundary are resolved before selecting the latest event", async () => {
  const events = Array.from({ length: 1000 }, (_, index) => event(String(index + 1).padStart(5, "0"), "#AA", "leave", recent, "unknown"));
  events.push(event("00000", "#AA", "join", recent, "recorded"));
  const f = fixture({ history: [member("#AA")], events });
  const body = await (await f.get()).json();
  assert.deepEqual(body.history[0].latest_membership_event, { type: "join", at: recent, source: "recorded" });
  const queries = f.calls.filter(call => call.table === "membership_change_events");
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[1].operations.find(operation => operation[0] === "range"), ["range", 1000, 1999]);
});

test("latest reads are batched, narrowly projected and skip the remaining history of resolved busy players", async () => {
  const events = [event("new", "#AA", "join"), event("target", "#BB", "join", "2026-09-17T20:00:00.000Z"),
    ...Array.from({ length: 2000 }, (_, index) => event(String(index), "#AA", "leave", old))];
  const f = fixture({ history: [member("#AA"), member("#BB")], events });
  const body = await (await f.get()).json(); assert.equal(body.history.length, 2);
  const queries = f.calls.filter(call => call.table === "membership_change_events"); assert.equal(queries.length, 1);
  const operations = queries[0].operations;
  assert.deepEqual(operations.find(item => item[0] === "select"), ["select", "id,player_tag,event_type,occurred_at,source"]);
  assert.deepEqual(operations.find(item => item[0] === "eq"), ["eq", "club_tag", "#CLUB"]);
  assert.deepEqual(operations.find(item => item[0] === "in" && item[1] === "event_type"), ["in", "event_type", ["join", "leave", "initial_seen"]]);
  assert.deepEqual(operations.find(item => item[0] === "lte"), ["lte", "occurred_at", now.toISOString()]);
  assert.deepEqual(operations.filter(item => item[0] === "order"), [["order", "occurred_at", { ascending: false }], ["order", "id", { ascending: false }]]);
  const many = fixture({ history: Array.from({ length: 401 }, (_, index) => member(`#P${index}`)) });
  assert.equal((await many.get()).status, 200);
  assert.deepEqual(many.calls.filter(call => call.table === "membership_change_events").map(call => call.operations.find(item => item[0] === "in" && item[1] === "player_tag")[2].length), [200, 200, 1]);
});

test("history rejects configuration changes and failed audit reads with a private generic response", async () => {
  for (const options of [{ changeClub: true }, { failEvents: true }, { settings: [{ key: "club_tag", value: "invalid tag" }] }]) {
    const f = fixture({ history: [member("#AA")], events: [event("1", "#AA", "join")], ...options });
    const response = await f.get(); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Failed to fetch member history" });
    assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("vary"), "Cookie");
    assert.doesNotMatch(JSON.stringify(f.logs), /private-database-error/);
  }
});

test("public event summaries are explicitly projected while existing private note visibility remains session-dependent", async () => {
  for (const admin of [false, true]) {
    const f = fixture({ history: [member("#AA")], events: [event("1", "#AA", "join")], admin });
    const response = await f.get(), body = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get("vary"), "Cookie");
    assert.deepEqual(Object.keys(body.history[0].latest_membership_event).sort(), ["at", "source", "type"]);
    assert.equal(body.history[0].notes, admin ? "current-private-note" : undefined);
    assert.doesNotMatch(JSON.stringify(body), /private-legacy-note|private-actor|before_snapshot|after_snapshot|provenance|club_tag/);
  }
});
