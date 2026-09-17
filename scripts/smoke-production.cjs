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
  assert.ok(Array.isArray(history.history), "History returns member records");
  for (const member of history.history) {
    assert.ok(Object.hasOwn(member, 'latest_membership_event'), "History exposes the latest dated membership event");
    const event = member.latest_membership_event;
    if (!event) continue;
    assert.deepEqual(Object.keys(event).sort(), ['at', 'source', 'type'], "Membership events expose only public fields");
    assert.ok(['join', 'leave', 'initial_seen'].includes(event.type));
    assert.ok(['recorded', 'reconstructed', 'unknown'].includes(event.source));
    assert.ok(Number.isFinite(Date.parse(event.at)) && Date.parse(event.at) <= Date.now(), "Latest membership events have valid past timestamps");
  }
  const [analysis, readiness, report] = await Promise.all([get('/api/analysis?range=7d'),get('/api/readiness?limit=1'),get('/api/reports/weekly?range=7d')]);
  assert.ok(Number.isSafeInteger(analysis.summary.observations), 'Club analysis is available');
  assert.equal(analysis.coverage.completeHistory,false,'Analysis declares observed coverage');
  assert.ok(Array.isArray(readiness.rows) && readiness.rows.length<=1,'Readiness honors page bounds');
  assert.ok(Object.hasOwn(report,'trophyChange'),'Report includes optional club trophy comparison');
  if (report.trophyChange !== null) {
    const change=report.trophyChange;
    assert.equal(change.requestedStart,report.period.start,'Club trophy comparison follows the report start');
    assert.equal(change.requestedEnd,report.period.end,'Club trophy comparison follows the report end');
    assert.ok(change.points.length<=7,'Daily trophy history is bounded by the selected period');
    assert.ok(!JSON.stringify(change).includes('"tag":') && !JSON.stringify(change).includes('"notes":'),'Trophy comparison only exposes aggregate roster data');
    if (change.status==='insufficient_history') assert.equal(change.totalChange,null,'Missing trophy history stays unknown');
    else assert.equal(change.totalChange,change.commonProgress+change.addedTrophies-change.removedTrophies,'Trophy change reconciles with roster changes');
  }
  if (readiness.rows[0]) {
    const progress=await get(`/api/members/${encodeURIComponent(readiness.rows[0].player.tag)}/progress?collectionLimit=1&rankLimit=1`);
    assert.ok(progress.collection.items.length<=1 && progress.rankedHistory.items.length<=1,'Player progress is paginated');
  }
  const [club, planning, rivals, join] = await Promise.all([get('/api/club-intelligence?range=7d'),get('/api/club-planning?public=1'),get('/api/club-rivals?region=global'),get('/api/join')]);
  assert.equal(club.calendar.timezone,'UTC');
  assert.equal(club.calendar.completeHistory,false);
  assert.ok(club.calendar.rows.length<=30 && club.calendar.days.length<=7,'Club calendar is bounded');
  assert.ok(Array.isArray(planning.events),'Club events summary available');
  assert.ok(!Object.hasOwn(planning,'goals') && !Object.hasOwn(planning,'refreshDeferred'),'Retired goal data is absent');
  assert.ok(!planning.roster && !planning.goalDetail && !planning.eventDetail,'Public planning excludes private details');
  assert.ok(!JSON.stringify(planning).includes('"notes":'),'Public planning excludes notes');
  assert.ok(rivals.rivals.length<=5,'Rival comparison is bounded');
  assert.equal(typeof join.recruitment_open,'boolean');
  assert.ok(!Object.hasOwn(join,'applications'),'Application submissions remain private');
  const routes = ["/","/members","/activity","/battle-feed","/history","/reviews","/analysis","/readiness","/game","/reports","/notifications","/recruitment","/settings","/admin","/club-planning","/rivals","/join"];
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
  for(const path of ['/api/member-administration','/api/club-administration','/api/recruitment/applications','/api/mega-pig-source','/api/mega-pig-archive']) {
    const response=await fetch(new URL(path,base),{signal:AbortSignal.timeout(30000)});
    assert.equal(response.status,401,`${path} requires an administrator`);
    assert.equal(response.headers.get('cache-control'),'no-store',`${path} rejects shared caching`);
  }
  console.log("Production smoke checks passed: pages, club insights, planning, rivals, applications, freshness and private access boundaries.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
