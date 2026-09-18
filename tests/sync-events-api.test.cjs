const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

const now = "2026-09-18T12:00:00.000Z";
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return Date.parse(now); } }
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const uuid = id => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
const event = (id, values = {}) => ({
  id: uuid(id), club_tag: "#CLUB", player_tag: "#PLAYER", player_name: "Member", event_type: "join",
  occurred_at: "2026-09-18T11:00:00.123456+00:00", source: "recorded", actor: "administrator", trigger_source: "manual", run_id: uuid(999),
  provenance: { sourceCategory: "club_roster_snapshot", timeMeaning: "observed_at", firstSeenMeaning: null },
  before_snapshot: null, after_snapshot: { player_name: "Member", trophies: 123 }, ...values,
});

function fixture(events, { changedClub = false, configFailure = 0, eventFailure = false } = {}) {
  const calls = []; let configReads = 0;
  const database = { from(table) {
    const call = { table, operations: [] }; calls.push(call);
    const filters = [], ordering = []; let limit = Infinity;
    const query = {
      select(...args) { call.operations.push(["select", ...args]); return query; },
      eq(key, value) { call.operations.push(["eq", key, value]); filters.push(row => row[key] === value); return query; },
      lte(key, value) { call.operations.push(["lte", key, value]); filters.push(row => Date.parse(row[key]) <= Date.parse(value)); return query; },
      order(key, options) { call.operations.push(["order", key, options]); ordering.push(key); return query; },
      limit(value) { call.operations.push(["limit", value]); limit = value; return query; },
      or(value) {
        call.operations.push(["or", value]);
        const match = /^occurred_at\.lt\.(.+),and\(occurred_at\.eq\.\1,id\.lt\.([a-f0-9-]+)\)$/.exec(value);
        assert.ok(match, "Cursor must stay a narrow timestamp/UUID predicate");
        filters.push(row => row.occurred_at < match[1] || row.occurred_at === match[1] && row.id < match[2]);
        return query;
      },
      async maybeSingle() {
        assert.equal(table, "settings"); configReads++;
        return configFailure === configReads ? { data: null, error: { message: "private configuration error" } }
          : { data: { value: changedClub && configReads > 1 ? "#OTHER" : "#CLUB" }, error: null };
      },
      then(resolve, reject) {
        assert.equal(table, "membership_change_events");
        const rows = events.filter(row => filters.every(filter => filter(row))).sort((a, b) => {
          for (const key of ordering) { if (a[key] !== b[key]) return a[key] > b[key] ? -1 : 1; }
          return 0;
        }).slice(0, limit);
        return Promise.resolve(eventFailure ? { data: null, error: { message: "private audit error" } } : { data: rows, error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
  const route = loadTypeScript("src/app/api/sync/events/route.ts", {
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/supabase-admin": { supabaseAdmin: database },
  }, { Date: FixedDate });
  const get = (parameters = {}) => {
    const url = new URL(`https://fixture/api/sync/events?${new URLSearchParams(parameters)}`);
    return route.GET(Object.assign(new Request(url), { nextUrl: url }));
  };
  return { get, calls };
}

test("membership timeline contains only the configured club, requested member and non-future audit records", async () => {
  const f = fixture([event(1), event(2, { club_tag: "#OTHER", event_type: "leave" }),
    event(3, { player_tag: "#OTHERPLAYER" }), event(4, { occurred_at: "2026-09-19T00:00:00Z" }),
    event(5, { event_type: "data_repair", source: "reconstructed" })]);
  const response = await f.get({ playerTag: "player", limit: "20" });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json(); assert.deepEqual(body.events.map(row => row.id), [uuid(5), uuid(1)]);
  assert.equal(body.events[0].eventType, "data_repair"); assert.equal(body.events[0].source, "reconstructed");
  const audit = f.calls.find(call => call.table === "membership_change_events");
  assert.ok(audit.operations.some(op => op[0] === "eq" && op[1] === "club_tag" && op[2] === "#CLUB"));
  assert.ok(audit.operations.some(op => op[0] === "limit" && op[1] === 21));
  assert.equal(f.calls.filter(call => call.table === "settings").length, 2);
});

test("timeline keyset pagination preserves microseconds and UUID ties while excluding new inserts", async () => {
  const rows = [event(1), event(2), event(3)], f = fixture(rows);
  const first = await (await f.get({ limit: "2" })).json();
  assert.deepEqual(first.events.map(row => row.id), [uuid(3), uuid(2)]);
  assert.deepEqual(JSON.parse(Buffer.from(first.nextCursor, "base64url").toString()), { at: rows[1].occurred_at, id: uuid(2) });
  rows.push(event(4));
  const last = await (await f.get({ limit: "2", cursor: first.nextCursor })).json();
  assert.deepEqual(last.events.map(row => row.id), [uuid(1)]); assert.equal(last.nextCursor, null);
});

test("timeline validates opaque cursors before reading configuration or the audit table", async () => {
  const f = fixture([]), valid = { at: "2026-09-18T11:00:00.123456+00:00", id: uuid(1) };
  const malformed = ["", "***", "A".repeat(513), Buffer.from("{").toString("base64url"), ...[
    null, [], {}, { ...valid, id: "not-a-uuid" }, { ...valid, at: "2026-02-30T12:00:00Z" },
    { ...valid, at: "0000-01-01T00:00:00Z" }, { ...valid, at: "2026-09-18T24:00:00Z" },
    { ...valid, at: "2026-09-18T12:00:00+16:00" }, { ...valid, at: valid.at + ",player_tag.neq.#PLAYER" },
  ].map(encode)];
  for (const cursor of malformed) {
    const response = await f.get({ cursor });
    assert.equal(response.status, 400, cursor); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Invalid timeline cursor." });
  }
  assert.deepEqual(f.calls, []);
});

test("timeline projections preserve public evidence but exclude arbitrary audit metadata and private snapshots", async () => {
  const f = fixture([event(1, { actor: "private-user@example.com", trigger_source: "private-trigger", provenance: {
    sourceCategory: "legacy_club_events", timeMeaning: "previously_recorded_at", private_notes: "private-note",
    private_details: { token: "private-token" }, firstSeenMeaning: "private-string",
  }, before_snapshot: { player_name: "Old name", notes: "private-note", owner_user_id: "private-owner" },
  after_snapshot: { player_name: "New name", notes: "private-note", trophies: 456 } })]);
  const body = await (await f.get()).json();
  assert.deepEqual(body.events[0].before, { player_name: "Old name" });
  assert.deepEqual(body.events[0].after, { player_name: "New name", trophies: 456 });
  assert.deepEqual(body.events[0].provenance, { sourceCategory: "legacy_club_events", timeMeaning: "previously_recorded_at" });
  assert.equal(body.events[0].actor, "unknown"); assert.equal(body.events[0].trigger, "unknown");
  assert.doesNotMatch(JSON.stringify(body), /private-/);
});

test("timeline fails closed on a configuration race or failed configuration/audit reads", async () => {
  for (const options of [{ changedClub: true }, { configFailure: 1 }, { configFailure: 2 }, { eventFailure: true }]) {
    const f = fixture([event(1)], options), response = await f.get();
    assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Timeline unavailable." });
  }
});
