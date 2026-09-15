const assert = require("node:assert/strict");
async function main() {
  const base = process.env.VERCEL_APP_URL || "https://brawlstatz.vercel.app";
  const get = async path => {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, `GET ${path}`);
    return response.json();
  };
  const [settings, health, history] = await Promise.all([get("/api/settings"),get("/api/sync/status"),get("/api/history")]);
  const encodedSettings = JSON.stringify(settings);
  for (const key of ["scheduler_token","api_key","discord_webhook","service_role"]) assert.ok(!encodedSettings.includes('"' + key + '":'), `Private setting exposed: ${key}`);
  assert.ok(["fresh","stale","never"].includes(health.freshness), "Freshness metadata is available");
  assert.ok(Number.isFinite(health.expectedIntervalMinutes), "Expected sync interval is available");
  assert.ok(!JSON.stringify(history).includes('"notes":'), "Public history excludes private notes");
  for (const route of ["/","/members","/history","/reviews"]) {
    const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, route);
  }
  const denied = await fetch(new URL("/api/member-reviews", base), {signal:AbortSignal.timeout(30_000)});
  assert.equal(denied.status,401,"Review API requires an administrator");
  console.log("Production smoke checks passed: pages, public data, freshness and private review boundaries.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
