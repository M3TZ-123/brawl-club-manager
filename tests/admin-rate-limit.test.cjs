const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

const baseEnv = { NODE_ENV: "test", ADMIN_PASSWORD: "password", ADMIN_SESSION_SECRET: "session-secret" };
const req = headers => new Request("https://app.example/api/admin/session", { headers });
function limiter(env = {}, database = {}) {
  return loadTypeScript("src/lib/admin-rate-limit.ts", { "@/lib/supabase-admin": { supabaseAdmin: database } }, { process: { env: { ...baseEnv, ...env } } });
}

test("untrusted forwarded headers cannot bypass the shared login bucket", () => {
  const { adminLoginClientKey } = limiter();
  const expected = adminLoginClientKey(req({}));
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(adminLoginClientKey(req({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4" })), expected);
  assert.equal(adminLoginClientKey(req({ "x-forwarded-for": "5.6.7.8" })), expected);
});

test("trusted ingress uses a single normalized IP and rejects ambiguous appended headers", () => {
  const { adminLoginClientKey } = limiter({ VERCEL: "1" });
  const unknown = adminLoginClientKey(req({}));
  assert.notEqual(adminLoginClientKey(req({ "x-vercel-forwarded-for": "1.2.3.4" })), unknown);
  assert.notEqual(adminLoginClientKey(req({ "x-vercel-forwarded-for": "1.2.3.4" })), adminLoginClientKey(req({ "x-vercel-forwarded-for": "5.6.7.8" })));
  assert.equal(adminLoginClientKey(req({ "x-vercel-forwarded-for": "1.2.3.4, 5.6.7.8" })), unknown);
  assert.equal(adminLoginClientKey(req({ "x-vercel-forwarded-for": "2001:db8:0:0:0:0:0:1" })), adminLoginClientKey(req({ "x-vercel-forwarded-for": "2001:db8::1" })));
  const custom = limiter({ ADMIN_TRUSTED_PROXY_IP_HEADER: "X-Trusted-IP" });
  assert.notEqual(custom.adminLoginClientKey(req({ "x-trusted-ip": "1.2.3.4" })), custom.adminLoginClientKey(req({})));
});

test("independent application instances share a durable login attempt budget", async () => {
  const attempts = new Map();
  const database = { async rpc(name, args) {
    assert.equal(name, "consume_admin_login_attempt");
    const count = (attempts.get(args.p_client_key) || 0) + 1;
    attempts.set(args.p_client_key, count);
    return { data: [{ allowed: count <= 8, retry_after: count <= 8 ? 0 : 599 }], error: null };
  } };
  const one = limiter({}, database);
  const two = limiter({}, database);
  for (let index = 0; index < 8; index++) {
    assert.equal((await (index % 2 ? one : two).consumeAdminLoginAttempt(req({ "x-forwarded-for": `1.2.3.${index}` }))).allowed, true);
  }
  const denied = await limiter({}, database).consumeAdminLoginAttempt(req({}));
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfter, 599);
  assert.equal(attempts.size, 1);
});

test("missing or malformed limiter responses fail closed", async () => {
  for (const result of [
    { error: new Error("DB unavailable") }, { data: [] }, { data: [{ allowed: true }] },
    { data: [{ allowed: true, retry_after: 601 }] }, { data: [{ allowed: "true", retry_after: 0 }] },
  ]) {
    await assert.rejects(limiter({}, { rpc: async () => result }).consumeAdminLoginAttempt(req({})), /rate-limit/);
  }
});

function sessionRoute({ limit = { allowed: true, retryAfter: 0 }, failure = null } = {}) {
  const calls = { passwords: 0, cookies: 0 };
  const route = loadTypeScript("src/app/api/admin/session/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/admin-auth": {
      isAdminAuthConfigured: () => true,
      verifyAdminPassword(value) { calls.passwords++; return value === "correct"; },
      setAdminSessionCookie() { calls.cookies++; },
    },
    "@/lib/admin-rate-limit": { async consumeAdminLoginAttempt() { if (failure) throw failure; return limit; } },
  }, { process: { env: baseEnv }, console: { error() {} } });
  const login = body => route.POST(new Request("https://app.example/api/admin/session", { method: "POST", body: JSON.stringify(body) }));
  return { calls, login };
}

test("login denies before password verification when throttled or rate-limit storage is unavailable", async () => {
  for (const [options, status, retry] of [
    [{ limit: { allowed: false, retryAfter: 512 } }, 429, "512"],
    [{ failure: new Error("DB unavailable") }, 503, "60"],
  ]) {
    const f = sessionRoute(options);
    const response = await f.login({ password: "correct" });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), retry);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(f.calls, { passwords: 0, cookies: 0 });
  }
});

test("login handles invalid JSON values without throwing and sets cookies only for a valid password", async () => {
  const f = sessionRoute();
  for (const body of [null, [], "correct", { password: "incorrect" }]) assert.equal((await f.login(body)).status, 401);
  assert.equal(f.calls.cookies, 0);
  assert.equal((await f.login({ password: "correct" })).status, 200);
  assert.equal(f.calls.cookies, 1);
});
