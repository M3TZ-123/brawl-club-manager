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
  assert.ok(!JSON.stringify(history).includes('"review_updated_at":'), "Public history excludes private review revisions");
  const [analysis, readiness] = await Promise.all([get('/api/analysis?range=7d'),get('/api/readiness?limit=1')]);
  assert.ok(Number.isSafeInteger(analysis.summary.observations), 'Club analysis is available');
  assert.equal(analysis.coverage.completeHistory,false,'Analysis declares observed coverage');
  assert.ok(Array.isArray(readiness.rows) && readiness.rows.length<=1,'Readiness honors page bounds');
  if (readiness.rows[0]) {
    const progress=await get(`/api/members/${encodeURIComponent(readiness.rows[0].player.tag)}/progress?collectionLimit=1&rankLimit=1`);
    assert.ok(progress.collection.items.length<=1 && progress.rankedHistory.items.length<=1,'Player progress is paginated');
  }
  const routes = ["/","/members","/activity","/battle-feed","/history","/reviews","/analysis","/readiness","/game","/reports","/notifications","/recruitment","/settings","/admin"];
  if (readiness.rows[0]) routes.push(`/members/${encodeURIComponent(readiness.rows[0].player.tag)}`);
  for (const route of routes) {
    const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, route);
  }
  const denied = await fetch(new URL("/api/member-reviews", base), {signal:AbortSignal.timeout(30_000)});
  assert.equal(denied.status,401,"Review API requires an administrator");
  assert.equal(denied.headers.get('cache-control'),'no-store','Private reviews reject shared caching');
  const candidateDenied=await fetch(new URL('/api/recruitment',base),{signal:AbortSignal.timeout(30000)});
  assert.equal(candidateDenied.status,401,'Recruitment is admin-only');
  assert.equal(candidateDenied.headers.get('cache-control'),'no-store','Recruitment rejects shared caching');
  console.log("Production smoke checks passed: pages, analysis, readiness, progress, freshness and private access boundaries.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
