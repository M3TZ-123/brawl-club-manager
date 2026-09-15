const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { readOnlyDatabase } = require("./helpers/read-only-database.cjs");

const next = { NextResponse: { json: (body, init) => Response.json(body, init) } };
const env = { NODE_ENV: "test", ADMIN_PASSWORD: "test-password", ADMIN_SESSION_SECRET: "test-session-secret" };
const globals = { process: { env }, console: { error() {} } };
const { createAdminSessionToken } = loadTypeScript("src/lib/admin-auth.ts", { "next/server": next }, globals);
function request(path, { admin = false, body, origin } = {}) {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "PATCH",
    headers: {
      host: "localhost", ...(admin ? { cookie: `brawlstatz_admin=${createAdminSessionToken()}` } : {}),
      ...(origin ? { origin } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function fixture(overrides = {}) {
  const tables = {
    member_history: [{ player_tag: "#PLAYER", player_name: "Member", notes: "Legacy private note", first_seen: "2026-09-01T00:00:00Z" }],
    member_reviews: [{ player_tag: "#PLAYER", status: "follow_up", follow_up_at: "2026-10-01T00:00:00.000Z", notes: "Current private note", updated_at: "2026-09-15T00:00:00Z" }],
    ...overrides,
  };
  const calls = [];
  const read = readOnlyDatabase(tables);
  const database = {
    from(table) {
      calls.push(table);
      const query = read.from(table);
      query.upsert = values => {
        assert.equal(table, "member_reviews", "Legacy notes must never be edited by review API");
        let row = tables.member_reviews.find(row => row.player_tag === values.player_tag);
        if (!row) {
          row = { status: "pending", follow_up_at: null, notes: null };
          tables.member_reviews.push(row);
        }
        Object.assign(row, values, { updated_at: "2026-09-16T00:00:00.000Z" });
        return { select: () => ({ single: async () => ({ data: { ...row }, error: null }) }) };
      };
      return query;
    },
  };
  const load = path => loadTypeScript(path, { "next/server": next, "@/lib/supabase-admin": { supabaseAdmin: database } }, globals);
  return { tables, calls, load };
}

test("public history excludes private and legacy notes even if a database query returns extra fields", async () => {
  const f = fixture();
  const response = await f.load("src/app/api/history/route.ts").GET(request("/api/history?days=all"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Cookie");
  const { history } = await response.json();
  assert.equal(history[0].player_name, "Member");
  assert.equal(Object.hasOwn(history[0], "notes"), false);
  assert.equal(Object.hasOwn(history[0], "review_status"), false);
  assert.deepEqual(f.calls, ["member_history"]);
});

test("authenticated history uses current private notes and review state", async () => {
  const f = fixture();
  const response = await f.load("src/app/api/history/route.ts").GET(request("/api/history?days=all", { admin: true }));
  const { history } = await response.json();
  assert.equal(history[0].notes, "Current private note");
  assert.equal(history[0].review_status, "follow_up");
  assert.equal(history[0].follow_up_at, "2026-10-01T00:00:00.000Z");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("review reads and mutations require a signed admin session before touching storage", async () => {
  const f = fixture();
  const route = f.load("src/app/api/member-reviews/route.ts");
  for (const response of [await route.GET(request("/api/member-reviews")), await route.PATCH(request("/api/member-reviews", { body: { player_tag: "#PLAYER", notes: "changed" } }))]) {
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("vary"), "Cookie");
  }
  assert.equal(f.calls.length, 0);
  const crossOrigin = await route.PATCH(request("/api/member-reviews", { admin: true, origin: "https://attacker.example", body: { player_tag: "#PLAYER", status: "reviewed" } }));
  assert.equal(crossOrigin.status, 403);
  assert.equal(f.calls.length, 0);
});

test("a malformed encoded admin cookie is treated as unauthenticated", async () => {
  const f = fixture();
  const response = await f.load("src/app/api/member-reviews/route.ts").GET(new Request("http://localhost/api/member-reviews", {
    headers: { cookie: "brawlstatz_admin=%E0%A4%A" },
  }));
  assert.equal(response.status, 401);
  assert.equal(f.calls.length, 0);
});

test("admin review queue paginates and single-member lookup returns null for pending unstored records", async () => {
  const f = fixture({ member_reviews: Array.from({ length: 1001 }, (_, index) => ({
    player_tag: `#P${String(index).padStart(4, "0")}`, status: "reviewed", notes: null, follow_up_at: null, updated_at: "2026-09-16T00:00:00Z",
  })) });
  const route = f.load("src/app/api/member-reviews/route.ts");
  const response = await route.GET(request("/api/member-reviews", { admin: true }));
  assert.equal((await response.json()).reviews.length, 1001);
  assert.equal(f.calls.length, 2);
  const absent = await route.GET(request("/api/member-reviews?player_tag=%23MISSING", { admin: true }));
  assert.deepEqual(await absent.json(), { review: null });
});

test("review edits preserve unspecified fields and compatible history notes never overwrite legacy notes", async () => {
  const f = fixture();
  const history = f.load("src/app/api/history/route.ts");
  const response = await history.PATCH(request("/api/history", { admin: true, body: { player_tag: " #player ", notes: "  Updated note  " } }));
  assert.equal(response.status, 200);
  const { review } = await response.json();
  assert.equal(review.notes, "Updated note");
  assert.equal(review.status, "follow_up");
  assert.equal(review.follow_up_at, "2026-10-01T00:00:00.000Z");
  assert.equal(f.tables.member_history[0].notes, "Legacy private note");
  const route = f.load("src/app/api/member-reviews/route.ts");
  const reviewed = await route.PATCH(request("/api/member-reviews", { admin: true, body: { player_tag: "#PLAYER", status: "reviewed" } }));
  const changed = (await reviewed.json()).review;
  assert.equal(changed.notes, "Updated note");
  assert.equal(changed.status, "reviewed");
  assert.equal(changed.follow_up_at, null);
});

test("review validation rejects unsupported status, missing date, invalid notes, and unknown players", async () => {
  const f = fixture();
  const route = f.load("src/app/api/member-reviews/route.ts");
  for (const body of [
    null, [], { player_tag: "#PLAYER" }, { player_tag: "PLAYER", status: "reviewed" },
    { player_tag: "#PLAYER", status: ["reviewed"] }, { player_tag: "#PLAYER", status: "hidden" },
    { player_tag: "#PLAYER", status: "follow_up" }, { player_tag: "#PLAYER", status: "follow_up", follow_up_at: "2026-10-01T12:00" },
    { player_tag: "#PLAYER", status: "pending", follow_up_at: "2026-10-01T00:00:00Z" },
    { player_tag: "#PLAYER", follow_up_at: null }, { player_tag: "#PLAYER", notes: "x".repeat(1001) },
    { player_tag: "#PLAYER", notes: false }, { player_tag: "#PLAYER", notes: "ok", admin: true },
  ]) {
    const response = await route.PATCH(request("/api/member-reviews", { admin: true, body }));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(f.calls.length, 0);
  const absent = await route.PATCH(request("/api/member-reviews", { admin: true, body: { player_tag: "#MISSING", notes: "test" } }));
  assert.equal(absent.status, 404);
  const valid = await route.PATCH(request("/api/member-reviews", { admin: true, body: { player_tag: "#PLAYER", status: "follow_up", follow_up_at: "2026-10-01T12:00:00+01:00", notes: "" } }));
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).review.follow_up_at, "2026-10-01T11:00:00.000Z");
  assert.equal(f.tables.member_reviews[0].notes, null);
});

test("missing private review schema fails closed without returning legacy notes", async () => {
  const f = fixture();
  delete f.tables.member_reviews;
  const route = f.load("src/app/api/member-reviews/route.ts");
  const response = await route.GET(request("/api/member-reviews", { admin: true }));
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("Legacy private note"), false);
  const history = await f.load("src/app/api/history/route.ts").GET(request("/api/history?days=all", { admin: true }));
  assert.equal(history.status, 503);
  const publicHistory = await f.load("src/app/api/history/route.ts").GET(request("/api/history?days=all"));
  assert.equal(publicHistory.status, 200);
});

test("settings expose only known public keys and booleans even if a query returns secret or future rows", async () => {
  // Deliberately ignore SQL filters here to also verify the response allowlist.
  const rows = [
    { key: "club_tag", value: "#CLUB" }, { key: "last_sync_time", value: "2026-09-16T00:00:00Z" },
    { key: "api_key", value: "private-api-key" }, { key: "discord_webhook", value: "private-webhook" },
    { key: "scheduler_token", value: "private-scheduler-token" }, { key: "future_secret", value: "private-future-secret" },
  ];
  const route = loadTypeScript("src/app/api/settings/route.ts", {
    "next/server": next,
    "@/lib/supabase-admin": { supabaseAdmin: { from: () => ({ select: () => ({ in: async () => ({ data: rows, error: null }) }) }) } },
  }, globals);
  const response = await route.GET();
  assert.deepEqual(await response.json(), { club_tag: "#CLUB", last_sync_time: "2026-09-16T00:00:00Z", api_key_configured: "true", discord_webhook_configured: "true" });
});

test("public member roster strips legacy owner fields before adding activity metrics", async () => {
  const route = loadTypeScript("src/app/api/members/route.ts", {
    "next/server": next,
    "@/lib/supabase-admin": { supabaseAdmin: readOnlyDatabase({
      member_history: [{ player_tag: "#PLAYER", is_current_member: true }],
      members: [{ player_tag: "#PLAYER", player_name: "Member", trophies: 123, owner_user_id: "private-owner", private_future_field: "private" }],
    }) },
    "@/lib/member-activity-metrics": { appendMemberActivityMetrics: async rows => rows.map(row => ({ ...row, activity_status: "active" })) },
  }, globals);
  const response = await route.GET();
  const { members } = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(members, [{ player_tag: "#PLAYER", player_name: "Member", trophies: 123, activity_status: "active" }]);
});
