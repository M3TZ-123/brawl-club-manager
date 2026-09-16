const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const quietConsole = { log() {}, warn() {}, error() {} };

function serviceFixture(options = {}) {
  const calls = [];
  const tags = options.tags || ["#PLAYER"];
  const db = {
    from: () => ({ select: () => ({ in: async () => ({data:[{key:"club_tag",value:"#CLUB"},{key:"api_key",value:"secret-test-only"}],error:null}) }) }),
    rpc: async (name,args) => {
      calls.push({name,args});
      if(name === "acquire_sync_run") return {data: options.acquisition || {acquired:true,run_id:"test-run",fence:4},error:null};
      if(name === "commit_sync_snapshot") return {data: options.commitError ? null : {success:true,synced:tags.length,events:0,timestamp:"2026-09-16T00:00:00Z",runId:"test-run",changes:{joins:[],leaves:[]},member:{player_tag:"#PLAYER"}},error:options.commitError || null};
      if(name === "fail_sync_run") return {data:null,error:null};
      throw new Error(`Unexpected RPC ${name}`);
    }
  };
  const api = {
    getClub: async () => ({members:tags.map(tag=>({tag,name:tag,role:"member"})),requiredTrophies:100}),
    getPlayer: async tag => {if(options.failPlayer) throw new Error("Bearer secret-test-only upstream response"); return {tag,name:tag,trophies:100,highestTrophies:100,expLevel:10,brawlers:[{id:1,name:"SHELLY",power:1,trophies:100,rank:1}],soloVictories:1,duoVictories:2,"3vs3Victories":3};},
    getPlayerRankedData: options.ranked || (async()=>({currentRank:"Unranked",highestRank:"Unranked",currentPoints:0,highestPoints:0})),
    getPlayerBattleLog: async()=>({items:[]}), processBattleLog:()=>[], calculateWinRateFromBattleLog:()=>({winRate:null}),
  };
  const service = loadTypeScript("src/lib/sync-service.ts", {"@/lib/supabase-admin":{supabaseAdmin:db},"@/lib/brawl-api":api}, {console:quietConsole,setTimeout:fn=>{fn();return 0;}});
  return {service,calls};
}

test("successful full sync performs one fenced commit with complete fetched data",async()=>{
  const {service,calls}=serviceFixture();
  const result=await service.executeSync({source:"manual",idempotencyKey:"retry-123"});
  assert.equal(result.success,true);
  assert.deepEqual(calls.map(c=>c.name),["acquire_sync_run","commit_sync_snapshot"]);
  assert.equal(calls[0].args.p_scope,"full");
  assert.equal(calls[0].args.p_idempotency_key,"retry-123");
  assert.equal(calls[1].args.p_fence,4);
  assert.equal(calls[1].args.p_payload.members[0].trophies,100);
  assert.equal(calls[1].args.p_payload.brawlers[0].brawler_id,1);
  assert.ok(!JSON.stringify(calls[1]).includes("secret-test-only"));
});
test("member refresh shares the club lease and preserves member response",async()=>{
  const {service,calls}=serviceFixture(); const result=await service.executeSync({source:"member",playerTag:"#PLAYER"});
  assert.equal(calls[0].args.p_club_tag,"#CLUB"); assert.equal(calls[0].args.p_scope,"member");
  assert.equal(result.member.player_tag,"#PLAYER"); assert.equal(result.brawlers.length,1);
});
test("overlapping sync is rejected before any fetch or commit",async()=>{
  const {service,calls}=serviceFixture({acquisition:{acquired:false,busy:true}});
  await assert.rejects(service.executeSync({source:"cron"}),e=>e.code==="sync_busy"&&e.status===409);
  assert.equal(calls.length,1);
});
test("successful request replay returns persisted outcome without committing again",async()=>{
  const {service,calls}=serviceFixture({acquisition:{acquired:false,replayed:true,status:"succeeded",result:{success:true,runId:"original"}}});
  const result=await service.executeSync({source:"manual",idempotencyKey:"retry-123"});
  assert.equal(result.runId,"original");assert.equal(calls.length,1);
});
test("public member results and audit snapshots exclude legacy tenant IDs and private fields",async()=>{
  const {service}=serviceFixture({acquisition:{acquired:false,replayed:true,status:"succeeded",result:{success:true,member:{player_tag:"#PLAYER",owner_user_id:"private-tenant",notes:"private-note"}}}});
  const result=await service.executeSync({source:"member",playerTag:"#PLAYER",idempotencyKey:"retry-123"});
  assert.equal(result.member.player_tag,"#PLAYER");assert.equal(Object.hasOwn(result.member,"owner_user_id"),false);assert.equal(Object.hasOwn(result.member,"notes"),false);
  const {publicAuditSnapshot}=loadTypeScript("src/lib/sync-public-snapshots.ts");
  const audit=publicAuditSnapshot({first_seen:null,times_joined:2,owner_user_id:"private-tenant",notes:"private-note",player_name:{owner_user_id:"nested-secret"}});
  assert.deepEqual(JSON.parse(JSON.stringify(audit)),{first_seen:null,times_joined:2});
});
test("primary failure records a sanitized durable failure and never commits",async()=>{
  const {service,calls}=serviceFixture({failPlayer:true,tags:Array.from({length:30},(_,i)=>`#P${i}`)});
  await assert.rejects(service.executeSync({source:"manual"}),e=>e.code==="upstream_unavailable");
  assert.deepEqual(calls.map(c=>c.name),["acquire_sync_run","fail_sync_run"]);
  assert.ok(!JSON.stringify(calls.at(-1)).includes("secret-test-only"));
});
test("transaction errors keep typed failure and invoke durable failure recording",async()=>{
  const {service,calls}=serviceFixture({commitError:{message:"stale_sync_fence"}});
  await assert.rejects(service.executeSync({source:"manual"}),e=>e.code==="stale_sync_fence");
  assert.equal(calls.at(-1).name,"fail_sync_run");
});
test("ambiguous commit transport failure preserves the retry key contract",async()=>{
  const {service,calls}=serviceFixture({commitError:{message:"fetch failed",code:""}});
  await assert.rejects(service.executeSync({source:"cron",idempotencyKey:"stable-request"}),e=>e.code==="database_unavailable"&&e.status===503);
  assert.equal(calls.at(-1).args.p_error_code,"database_unavailable");
});
test("ranked prefetch is bounded to four workers and finishes before slow primary batches",async()=>{
  let active=0,peak=0;const fetched=[];
  const {service}=serviceFixture({ranked:async(tag)=>{fetched.push(tag);active++;peak=Math.max(peak,active);await Promise.resolve();active--;return {currentRank:"Gold I",highestRank:"Gold I",currentPoints:1500,highestPoints:1500};}});
  const pool=service.prefetchSyncRanks(Array.from({length:30},(_,i)=>`#P${i}`),new AbortController().signal);
  await pool.finished;
  assert.equal(fetched.length,30);assert.equal(peak,4);assert.equal((await pool.results.get("#P29")).currentRank,"Gold I");pool.cancel();
});
test("cancelled ranked workers settle all deferred results",async()=>{
  const {service}=serviceFixture({ranked:async(_tag,{signal})=>{await new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true}));return {currentRank:"Unranked",highestRank:"Unranked",currentPoints:0,highestPoints:0};}});
  const pool=service.prefetchSyncRanks(Array.from({length:30},(_,i)=>`#P${i}`),new AbortController().signal);pool.cancel();await pool.finished;
  assert.equal((await pool.results.get("#P29")).currentRank,"Unranked");
});

test("delivery suppression makes no database or network calls",async()=>{
  const outbox=loadTypeScript("src/lib/sync-outbox.ts",{"@/lib/supabase-admin":{supabaseAdmin:{rpc:()=>{throw Error("no RPC expected");}}},"@/lib/sync-service":{readSyncSettings:()=>{throw Error("no settings expected");},SyncError:Error}});
  assert.equal((await outbox.deliverSyncOutbox(true)).suppressed,true);
});
test("Discord429 is recorded as a retry without recording response bodies",async()=>{
  const calls=[];
  const outbox=loadTypeScript("src/lib/sync-outbox.ts",{"@/lib/supabase-admin":{supabaseAdmin:{rpc:async(name,args)=>{calls.push({name,args});return {data:name==="claim_notification_outbox"?[{id:"msg",payload:{embeds:[]}}]:true,error:null};}}},"@/lib/sync-service":{readSyncSettings:async()=>({notifications_enabled:"true",discord_webhook:"https://discord.com/api/webhooks/test/token"}),SyncError:Error}},
    {fetch:async()=>new Response("secret-response",{status:429,headers:{"retry-after":"120"}}),process:{env:{SYNC_DISABLE_DELIVERY:"false"}}});
  const result=await outbox.deliverSyncOutbox();assert.equal(result.retried,1);assert.equal(calls[1].args.p_retry_seconds,120);assert.equal(calls[1].args.p_error_code,"http_429");assert.ok(!JSON.stringify(calls).includes("secret-response"));
});

function loadBrawlApi(axios) {
  let now = Date.now();
  class ClockDate extends Date { static now() { return now; } }
  return loadTypeScript("src/lib/brawl-api.ts", { axios, "./utils": { encodeTag: encodeURIComponent } }, {
    console: quietConsole, Date: ClockDate,
    setTimeout: (fn, delay) => { now += delay; fn(); return 0; }, clearTimeout: () => {},
  });
}

test("ranked cancellation ends retry work and skips subsequent requests", async () => {
  const controller = new AbortController();
  let calls = 0;
  const api = loadBrawlApi({
    create: () => ({}), isCancel: () => true,
    get: async (_url, options) => { calls++; assert.equal(options.signal, controller.signal); controller.abort(); throw new Error("cancelled"); },
  });
  const first = await api.getPlayerRankedData("#P", { signal: controller.signal });
  const later = await api.getPlayerRankedData("#OTHER", { signal: controller.signal });
  assert.equal(first.currentRank, "Unranked");
  assert.equal(later.currentRank, "Unranked");
  assert.equal(calls, 1);
});

test("translated Brawl API failures retain status and verification returns actionable errors", async (t) => {
  for (const status of [403, 404, 429]) {
    await t.test(String(status), async () => {
      const api = loadBrawlApi({
        create: () => ({ get: async () => { throw { isAxiosError: true, response: { status, data: { reason: "test failure" } }, config: {} }; } }),
        isAxiosError: (error) => error.isAxiosError === true,
      });
      await assert.rejects(api.getClub("#CLUB", "test-only"), (error) => error instanceof api.BrawlApiError && error.status === status);
      const route = loadTypeScript("src/app/api/verify-club/route.ts", {
        "@/lib/brawl-api": api, "@/lib/admin-auth": { rejectUnauthorizedAdminMutation: () => null },
        "next/server": { NextResponse: { json: (body, init) => ({ body, status: init?.status || 200 }) } },
      }, { console: quietConsole });
      const result = await route.POST({ json: async () => ({ clubTag: "#CLUB", apiKey: "test-only" }) });
      assert.equal(result.status, status);
      assert.ok(result.body.error);
    });
  }
});
