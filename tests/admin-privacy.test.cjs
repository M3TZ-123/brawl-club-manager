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

function fixture(overrides = {}, beforeWrite) {
  const tables = {
    member_history: [{ player_tag: "#PLAYER", player_name: "Member", notes: "Legacy private note", first_seen: "2026-09-01T00:00:00Z" }],
    member_reviews: [{ player_tag: "#PLAYER", status: "follow_up", follow_up_at: "2026-10-01T00:00:00.000Z", notes: "Current private note", updated_at: "2026-09-15T00:00:00Z" }],
    ...overrides,
  };
  const calls = [];
  let revisions = 0;
  const read = readOnlyDatabase(tables);
  const database = {
    from(table) {
      calls.push(table);
      const query = read.from(table);
      const mutation = (mode, values) => {
        assert.equal(table, "member_reviews", "Legacy notes must never be edited by review API");
        const filters=[];
        const execute=async()=>{
          beforeWrite?.({mode,values,tables,filters});
          let row = tables.member_reviews.find(row => mode==='update'?filters.every(([key,value])=>row[key]===value):row.player_tag === values.player_tag);
          if(mode==='update'&&!row)return{data:null,error:null};
          if(mode==='insert'&&row)return{data:null,error:{code:'23505',message:'duplicate private row'}};
          if (!row) { row = { status: "pending", follow_up_at: null, notes: null }; tables.member_reviews.push(row); }
          Object.assign(row, values, { updated_at: `2026-09-16T00:00:00.${String(++revisions).padStart(6,'0')}+00:00` });
          return {data:{...row},error:null};
        };
        const chain={eq:(key,value)=>{filters.push([key,value]);return chain;},select:()=>chain,single:execute,maybeSingle:execute};return chain;
      };
      query.upsert = values => mutation('upsert',values);
      query.update = values => mutation('update',values);
      query.insert = values => mutation('insert',values);
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
  assert.equal(Object.hasOwn(history[0], "review_updated_at"), false);
  assert.deepEqual(f.calls, ["member_history"]);
});

test("authenticated history uses current private notes and review state", async () => {
  const f = fixture();
  f.tables.member_reviews[0].updated_at = "2026-09-16T00:00:00.123456+00:00";
  f.tables.member_history.push({ player_tag: "#UNREVIEWED", player_name: "No saved review" });
  const response = await f.load("src/app/api/history/route.ts").GET(request("/api/history?days=all", { admin: true }));
  const { history } = await response.json();
  const reviewed = history.find(row => row.player_tag === "#PLAYER");
  assert.equal(reviewed.notes, "Current private note");
  assert.equal(reviewed.review_status, "follow_up");
  assert.equal(reviewed.follow_up_at, "2026-10-01T00:00:00.000Z");
  assert.equal(reviewed.review_updated_at, "2026-09-16T00:00:00.123456+00:00");
  assert.equal(history.find(row => row.player_tag === "#UNREVIEWED").review_updated_at, null);
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

test("history notes propagate exact revisions and reject stale or insert-only writes without losing saved notes", async () => {
  const f = fixture();
  const revision = "2026-09-16T00:00:00.123457+00:00";
  f.tables.member_reviews[0].updated_at = revision;
  const route = f.load("src/app/api/history/route.ts");
  for (const expected_updated_at of ["2026-09-16T00:00:00.123456+00:00", null]) {
    const response = await route.PATCH(request("/api/history", {
      admin: true, body: { player_tag: "#PLAYER", notes: "Stale draft", expected_updated_at },
    }));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Review changed. Reload before saving." });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("vary"), "Cookie");
    assert.equal(f.tables.member_reviews[0].notes, "Current private note");
  }
  const saved = await route.PATCH(request("/api/history", {
    admin: true, body: { player_tag: "#PLAYER", notes: "Checked edit", expected_updated_at: revision },
  }));
  assert.equal(saved.status, 200);
  const { review } = await saved.json();
  assert.equal(review.updated_at, "2026-09-16T00:00:00.000001+00:00");
  assert.equal(review.notes, "Checked edit");
  assert.equal(review.status, "follow_up");
  assert.equal(review.follow_up_at, "2026-10-01T00:00:00.000Z");
  assert.equal(f.tables.member_history[0].notes, "Legacy private note");
  const absent = fixture({ member_reviews: [] });
  const inserted = await absent.load("src/app/api/history/route.ts").PATCH(request("/api/history", {
    admin: true, body: { player_tag: "#PLAYER", notes: "First note", expected_updated_at: null },
  }));
  assert.equal(inserted.status, 200);
  assert.equal((await inserted.json()).review.notes, "First note");
});

test("history note writes enforce session and origin before inspecting revisions or private storage", async () => {
  const f = fixture();
  const route = f.load("src/app/api/history/route.ts");
  const body = { player_tag: "#PLAYER", notes: "Unauthorized", expected_updated_at: null };
  for (const [options, status] of [[{ body }, 401], [{ body, admin: true, origin: "https://attacker.example" }, 403]]) {
    const response = await route.PATCH(request("/api/history", options));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("vary"), "Cookie");
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.tables.member_reviews[0].notes, "Current private note");
});

test("review saves compare full microsecond revisions and stale drafts cannot overwrite newer notes", async () => {
  const f=fixture();f.tables.member_reviews[0].updated_at='2026-09-16T00:00:00.123457+00:00';
  const route=f.load('src/app/api/member-reviews/route.ts');
  const stale=await route.PATCH(request('/api/member-reviews',{admin:true,body:{player_tag:'#PLAYER',notes:'Old draft',expected_updated_at:'2026-09-16T00:00:00.123456+00:00'}}));
  assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'Review changed. Reload before saving.'});
  assert.equal(f.tables.member_reviews[0].notes,'Current private note');
  const saved=await route.PATCH(request('/api/member-reviews',{admin:true,body:{player_tag:'#PLAYER',notes:'My checked edit',expected_updated_at:'2026-09-16T00:00:00.123457+00:00'}}));
  assert.equal(saved.status,200);const {review}=await saved.json();assert.equal(review.updated_at,'2026-09-16T00:00:00.000001+00:00');
  assert.equal(review.notes,'My checked edit');assert.equal(review.status,'follow_up');assert.equal(review.follow_up_at,'2026-10-01T00:00:00.000Z');
});

test("an absent review revision permits insert only and a concurrent first note is preserved", async () => {
  const f=fixture({member_reviews:[]});const route=f.load('src/app/api/member-reviews/route.ts');
  const body={player_tag:'#PLAYER',notes:'First note',expected_updated_at:null};
  const first=await route.PATCH(request('/api/member-reviews',{admin:true,body}));assert.equal(first.status,200);assert.equal((await first.json()).review.status,'pending');
  const second=await route.PATCH(request('/api/member-reviews',{admin:true,body:{...body,notes:'Stale empty draft'}}));assert.equal(second.status,409);
  assert.equal(f.tables.member_reviews[0].notes,'First note');assert.equal(f.tables.member_reviews.length,1);
  const race=fixture({member_reviews:[]},({tables})=>tables.member_reviews.push({player_tag:'#PLAYER',notes:'Concurrent first note',status:'reviewed',follow_up_at:null,updated_at:'2026-09-16T00:00:00.111111Z'}));
  const conflict=await race.load('src/app/api/member-reviews/route.ts').PATCH(request('/api/member-reviews',{admin:true,body}));
  assert.equal(conflict.status,409);assert.equal(race.tables.member_reviews[0].notes,'Concurrent first note');
});

test("older clients without a revision still use a conditional baseline and cannot overwrite an in-flight admin update", async () => {
  const f=fixture({},({tables})=>Object.assign(tables.member_reviews[0],{notes:'Other administrator',updated_at:'2026-09-16T00:00:00.654321Z'}));
  const response=await f.load('src/app/api/member-reviews/route.ts').PATCH(request('/api/member-reviews',{admin:true,body:{player_tag:'#PLAYER',notes:'Legacy draft'}}));
  assert.equal(response.status,409);assert.equal(f.tables.member_reviews[0].notes,'Other administrator');
});

test("private review DTOs exclude future fields and preserve original timestamp precision", async () => {
  const f=fixture();Object.assign(f.tables.member_reviews[0],{updated_at:'2026-09-16T00:00:00.123456+00:00',private_future:'UNRELATED_PRIVATE_VALUE'});
  const route=f.load('src/app/api/member-reviews/route.ts');
  const response=await route.GET(request('/api/member-reviews?player_tag=%23PLAYER',{admin:true}));const body=await response.json();
  assert.equal(body.review.updated_at,'2026-09-16T00:00:00.123456+00:00');assert.doesNotMatch(JSON.stringify(body),/private_future|UNRELATED_PRIVATE_VALUE/);
  const saved=await route.PATCH(request('/api/member-reviews',{admin:true,body:{player_tag:'#PLAYER',notes:'updated',expected_updated_at:body.review.updated_at}}));
  assert.equal(saved.status,200);assert.doesNotMatch(JSON.stringify(await saved.json()),/private_future|UNRELATED_PRIVATE_VALUE/);
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
    ...[1,{},'', 'invalid', '2026-02-30T00:00:00Z', '2026-09-16T00:00:00'].map(expected_updated_at=>({player_tag:'#PLAYER',notes:'ok',expected_updated_at})),
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
    "@/lib/accepted-club-roster": { requireAcceptedClubRoster: async () => "#CLUB", assertAcceptedClubRoster: async () => {}, ClubRosterUnavailableError: class extends Error {} },
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
