const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { readOnlyDatabase } = require("./helpers/read-only-database.cjs");

const next = { NextResponse: { json: (body, init) => Response.json(body, init) } };
const env = { NODE_ENV: "test", ADMIN_PASSWORD: "test-password", ADMIN_SESSION_SECRET: "test-session-secret" };
const { createAdminSessionToken } = loadTypeScript("src/lib/admin-auth.ts", { "next/server": next }, { process: { env } });
const uuid = number => `00000000-0000-0000-0000-${number.toString(16).padStart(12, "0")}`;
const entry = (number, values = {}) => ({ id: uuid(number), club_tag: "#CLUB", player_tag: "#FORMER",
  created_at: "2026-09-17T10:00:00.123456+00:00", body: "HIDDEN_DECISION_BODY", kind: "departure_reason", ...values });
const request = (query = "?include_history=1", admin = true) => new Request(`http://localhost/api/member-reviews${query}`, {
  headers: admin ? { cookie: `brawlstatz_admin=${createAdminSessionToken()}` } : {},
});
function timestamp(value) {
  const fraction = /\.(\d+)/.exec(value)?.[1] || "";
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3, 6));
}
function fixture({ entries = [], clubs = ["#CLUB"], failPage = -1, nullPage = -1, beforePage, rpcError } = {}) {
  const calls = [], logs = [], pages = [], reviews = [{ player_tag: "#CURRENT", status: "reviewed", notes: "Saved note",
    follow_up_at: null, updated_at: "2026-09-17T09:00:00.000001+00:00" }];
  const read = readOnlyDatabase({ member_reviews: reviews });
  let clubReads = 0;
  const database = {
    async rpc(name) {
      calls.push({ rpc: name });
      assert.equal(name, "administration_club_tag");
      return { data: clubs[Math.min(clubReads++, clubs.length - 1)], error: rpcError || null };
    },
    from(table) {
      calls.push({ table });
      if (table === "member_reviews") return read.from(table);
      assert.equal(table, "member_decision_log");
      const page = { columns: null, filters: [], orders: [], limit: null, cursor: null };
      const query = {
        select(columns) { page.columns = columns; return query; },
        eq(key, value) { page.filters.push([key, value]); return query; },
        order(key, options) { page.orders.push([key, options.ascending]); return query; },
        limit(count) { page.limit = count; return query; },
        or(expression) {
          const match = /^created_at\.lt\.(.+),and\(created_at\.eq\.\1,id\.lt\.([a-f0-9-]+)\)$/.exec(expression);
          assert.ok(match, `Unexpected keyset: ${expression}`);
          page.cursor = { at: match[1], id: match[2] };
          return query;
        },
        then(resolve, reject) {
          const number = pages.length;
          pages.push(page);
          beforePage?.(number, entries);
          let rows = entries.filter(row => page.filters.every(([key, value]) => row[key] === value));
          if (page.cursor) rows = rows.filter(row => timestamp(row.created_at) < timestamp(page.cursor.at)
            || timestamp(row.created_at) === timestamp(page.cursor.at) && row.id < page.cursor.id);
          rows.sort((left, right) => {
            for (const [key, ascending] of page.orders) {
              const a = key === "created_at" ? timestamp(left[key]) : left[key];
              const b = key === "created_at" ? timestamp(right[key]) : right[key];
              const compared = a < b ? -1 : a > b ? 1 : 0;
              if (compared) return ascending ? compared : -compared;
            }
            return 0;
          });
          const result = number === failPage ? { data: null, error: { message: "PRIVATE_DATABASE_ERROR", detail: "HIDDEN_DECISION_BODY" } }
            : { data: number === nullPage ? null : rows.slice(0, page.limit).map(row => ({ ...row })), error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const route = loadTypeScript("src/app/api/member-reviews/route.ts", {
    "next/server": next, "@/lib/supabase-admin": { supabaseAdmin: database },
  }, { process: { env }, console: { error: (...messages) => logs.push(messages.join(" ")) } });
  return { route, calls, pages, logs, reviews, entries };
}

test("private history summaries require admin authentication before every storage read", async () => {
  const f = fixture({ entries: [entry(1)] });
  const response = await f.route.GET(request("?include_history=1", false));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.deepEqual(f.calls, []);
  const malformed = await f.route.GET(new Request("http://localhost/api/member-reviews?include_history=1", {
    headers: { cookie: "brawlstatz_admin=%E0%A4%A" },
  }));
  assert.equal(malformed.status, 401);
  assert.deepEqual(f.calls, []);
});

test("optional summaries discover dated-log-only former members with explicit club scope and no private body fields", async () => {
  const f = fixture({ entries: [entry(1), entry(2, { kind: "correction" }),
    entry(3, { player_tag: "#CURRENT", kind: "absence_declared", created_at: "2026-09-18T01:00:00.000001+00:00" }),
    entry(4, { club_tag: "#OTHER", player_tag: "#OTHERPLAYER" })] });
  const response = await f.route.GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Cookie");
  const body = await response.json();
  assert.deepEqual(body.reviews, f.reviews);
  assert.deepEqual(body.historySummaries, [
    { player_tag: "#CURRENT", entry_count: 1, latest_at: "2026-09-18T01:00:00.000001+00:00" },
    { player_tag: "#FORMER", entry_count: 2, latest_at: "2026-09-17T10:00:00.123456+00:00" },
  ]);
  assert.doesNotMatch(JSON.stringify(body), /HIDDEN_DECISION_BODY|OTHERPLAYER|departure_reason|club_tag|corrects_id/);
  assert.deepEqual(f.pages, [{ columns: "id,player_tag,created_at", filters: [["club_tag", "#CLUB"]],
    orders: [["created_at", false], ["id", false]], limit: 1000, cursor: null }]);
  assert.equal(f.calls.filter(call => call.rpc).length, 2, "The configured club is rechecked before returning summaries");
});

test("legacy list and single-player review requests do not read or expose administration summaries", async () => {
  const f = fixture({ entries: [entry(1)] });
  for (const query of ["", "?include_history=0", "?include_history=true"]) {
    const response = await f.route.GET(request(query));
    assert.deepEqual(await response.json(), { reviews: f.reviews });
  }
  const single = await f.route.GET(request("?player_tag=%23CURRENT&include_history=1"));
  assert.deepEqual(await single.json(), { review: f.reviews[0] });
  const absent = await f.route.GET(request("?player_tag=%23MISSING&include_history=1"));
  assert.deepEqual(await absent.json(), { review: null });
  assert.ok(f.calls.every(call => call.table === "member_reviews"));
  assert.equal(f.pages.length, 0);
});

test("summary pagination counts all entries across timestamp ties and preserves microseconds without N+1 reads", async () => {
  const entries = Array.from({ length: 2003 }, (_, index) => entry(index + 1, {
    player_tag: index < 1001 ? "#FORMER" : "#CURRENT",
    created_at: index < 1001 ? "2026-09-17T10:00:00.123457+00:00" : "2026-09-17T10:00:00.123456+00:00",
  }));
  const f = fixture({ entries });
  const response = await f.route.GET(request());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).historySummaries, [
    { player_tag: "#CURRENT", entry_count: 1002, latest_at: "2026-09-17T10:00:00.123456+00:00" },
    { player_tag: "#FORMER", entry_count: 1001, latest_at: "2026-09-17T10:00:00.123457+00:00" },
  ]);
  assert.equal(f.pages.length, 3);
  assert.equal(f.pages[1].cursor.at, "2026-09-17T10:00:00.123457+00:00");
  assert.equal(f.pages[2].cursor.at, "2026-09-17T10:00:00.123456+00:00");
  assert.ok(f.pages.every(page => page.limit === 1000 && page.filters.length === 1 && page.filters[0][0] === "club_tag"));
});

test("newer entries arriving during pagination do not shift offsets or double-count earlier rows", async () => {
  const f = fixture({ entries: Array.from({ length: 1001 }, (_, index) => entry(index + 1)),
    beforePage(number, entries) {
      if (number === 1) entries.push(entry(2000, { created_at: "2026-09-18T12:00:00.000001+00:00" }));
    },
  });
  const response = await f.route.GET(request());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).historySummaries, [
    { player_tag: "#FORMER", entry_count: 1001, latest_at: "2026-09-17T10:00:00.123456+00:00" },
  ]);
});

test("successful empty history is distinguishable from a failed or incomplete read", async () => {
  const empty = fixture();
  const response = await empty.route.GET(request());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).historySummaries, []);
  for (const options of [{ failPage: 0 }, { nullPage: 0 }, { clubs: [null] }, { rpcError: { code: "42501", message: "PRIVATE_DATABASE_ERROR" } }]) {
    const f = fixture(options);
    const unavailable = await f.route.GET(request());
    assert.equal(unavailable.status, 503);
    const body = await unavailable.json();
    assert.deepEqual(body, { error: "Private member reviews are unavailable. Please try again later." });
    assert.equal(unavailable.headers.get("cache-control"), "no-store");
    assert.equal(unavailable.headers.get("vary"), "Cookie");
    assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_DATABASE_ERROR|HIDDEN_DECISION_BODY/);
  }
});

test("a later page failure or club switch rejects the entire summary instead of returning partial counts", async () => {
  for (const options of [
    { entries: Array.from({ length: 1001 }, (_, index) => entry(index + 1)), failPage: 1 },
    { entries: [entry(1)], clubs: ["#CLUB", "#OTHER"] },
  ]) {
    const f = fixture(options);
    const response = await f.route.GET(request());
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(Object.hasOwn(body, "reviews"), false);
    assert.equal(Object.hasOwn(body, "historySummaries"), false);
  }
});

test("malformed stored cursor fields fail closed before they can become a query predicate", async () => {
  for (const values of [{ id: "not-an-id" }, { player_tag: "#BAD,other.eq.x" }, { created_at: "2026-09-17T10:00:00Z,body.eq.x" }]) {
    const f = fixture({ entries: [entry(1, values)] });
    const response = await f.route.GET(request());
    assert.equal(response.status, 503);
    assert.equal(f.pages.length, 1);
    assert.equal(f.pages[0].cursor, null);
  }
});
