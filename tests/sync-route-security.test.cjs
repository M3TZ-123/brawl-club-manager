const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const next = { NextResponse: { json: (body, init) => Response.json(body, init) } };
const globals = { process: { env: { ADMIN_PASSWORD: "test-password", ADMIN_SESSION_SECRET: "test-signing-key", CRON_SECRET: "test-scheduler-token" } } };
const { createAdminSessionToken } = loadTypeScript("src/lib/admin-auth.ts", { "next/server": next }, globals);
function fixture() {
  const calls = [];
  const route = loadTypeScript("src/app/api/sync/route.ts", { "next/server": next,
    "@/lib/supabase-admin": { supabaseAdmin: { from() { assert.fail("These authorization paths must not read private storage"); } } },
    "@/lib/sync-service": { SyncError: class extends Error {}, executeSync: async input => { calls.push(input); return { success: true }; } },
  }, globals);
  return { route, calls };
}
function request({ method = "GET", admin = false, headers = {}, body, rawBody, path = "" } = {}) {
  const url = `https://app.test/api/sync${path}`;
  return Object.assign(new Request(url, { method,
    headers: { host: "app.test", ...(admin ? { cookie: `brawlstatz_admin=${createAdminSessionToken()}` } : {}), ...headers },
    ...(method === "GET" ? {} : { body: rawBody ?? JSON.stringify(body) }),
  }), { nextUrl: new URL(url) });
}

test("cookie-only GET cannot trigger sync through a cross-site navigation or a same-origin request", async () => {
  const { route, calls } = fixture();
  for (const headers of [{ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }, { origin: "https://app.test" }]) {
    const response = await route.GET(request({ admin: true, headers }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls.length, 0);
});

test("scheduled GET retains bearer/custom-header authorization, adaptive scope and request identity", async () => {
  const { route, calls } = fixture();
  for (const headers of [{ authorization: "Bearer test-scheduler-token" }, { "x-cron-secret": "test-scheduler-token" }]) {
    const response = await route.GET(request({ headers: { ...headers, "idempotency-key": "scheduled-slot" }, path: "?mode=auto" }));
    assert.equal(response.status, 200);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), Array(2).fill({ source: "cron", scope: "auto", idempotencyKey: "scheduled-slot" }));
});

test("manual sync requires the existing cookie/origin guard and rejects malformed bodies before execution", async () => {
  const { route, calls } = fixture();
  assert.equal((await route.POST(request({ method: "POST", body: {} }))).status, 401);
  assert.equal((await route.POST(request({ method: "POST", admin: true, headers: { origin: "https://evil.test" }, body: {} }))).status, 403);
  for (const rawBody of ["null", "[]", "true", '"text"', "{", ""]) {
    assert.equal((await route.POST(request({ method: "POST", admin: true, rawBody }))).status, 400);
  }
  assert.equal(calls.length, 0);
  const response = await route.POST(request({ method: "POST", admin: true, headers: { origin: "https://app.test" }, body: { clubTag: "#CLUB", initialSetup: true } }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ source: "manual", clubTag: "#CLUB", initialSetup: true, idempotencyKey: null }]);
});
