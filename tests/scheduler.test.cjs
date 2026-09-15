const test = require("node:test");
const assert = require("node:assert/strict");
const { runScheduled } = require("../scripts/scheduled-sync.cjs");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const base = { CRON_SECRET: "private-token", VERCEL_APP_URL: "https://example.com", GITHUB_RUN_ID: "123" };
test("scheduler retries an ambiguous network outcome with the same operation ID", async () => {
  const keys = []; let calls = 0;
  await runScheduled({env:base,now:()=>1800000,sleep:async()=>{},request:async(url,options)=>{
    keys.push(options.headers["Idempotency-Key"]);
    if (calls++ === 0) throw new Error("timeout");
    return Response.json({success:true,runId:"replayed-run",synced:30});
  }});
  assert.equal(keys.length,2); assert.equal(keys[0],keys[1]);
});
test("a confirmed failed operation gets a fresh ID while authentication errors fail immediately", async () => {
  const keys = [];
  await runScheduled({env:base,now:()=>1800000,sleep:async()=>{},request:async(url,options)=>{
    keys.push(options.headers["Idempotency-Key"]);
    return keys.length === 1 ? Response.json({code:"upstream_unavailable"},{status:500}) : Response.json({success:true,runId:"new-run"});
  }});
  assert.notEqual(keys[0],keys[1]);
  let calls = 0;
  await assert.rejects(runScheduled({env:base,request:async()=>{calls++;return Response.json({},{status:401});}}),/configuration rejected/);
  assert.equal(calls,1);
});
function auth(stored, env={}, error=null) {
  return loadTypeScript("src/lib/scheduler-auth.ts",{
    "server-only": {},
    "@/lib/supabase-admin": {supabaseAdmin:{from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:stored == null ? null : {value:stored},error})})})})}},
  }, {process:{env}}).isAuthorizedSchedulerRequest;
}
test("scheduler accepts the private DB credential and legacy environment credential only", async () => {
  const request = value => new Request("https://example.com",{headers:{Authorization:"Bearer "+value}});
  assert.equal(await auth("db-token")(request("db-token")),true);
  assert.equal(await auth(null,{CRON_SECRET:"legacy"})(request("legacy")),true);
  assert.equal(await auth("db-token")(request("wrong")),false);
  assert.equal(await auth("db-token",{},new Error("offline"))(request("db-token")),false);
  assert.equal(await auth("db-token")(request("x".repeat(513))),false);
});
