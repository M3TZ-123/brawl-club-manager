const test=require("node:test");
const assert=require("node:assert/strict");
const {loadTypeScript}=require("./helpers/load-typescript.cjs");
const {readOnlyDatabase}=require("./helpers/read-only-database.cjs");
const now="2026-09-16T12:00:00.000Z";
class FixedDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return Date.parse(now);}}
const ago=minutes=>new Date(Date.parse(now)-minutes*60000).toISOString();
function route(settings={},options={}){
 const tables={sync_runs:options.runs||[],sync_leases:[],notification_outbox:[],member_history:options.members||[]};
 const database=readOnlyDatabase(tables);
 database.rpc=async(name,args)=>{assert.equal(name,"sync_battle_coverage_summary");assert.equal(args.p_club_tag,"#CLUB");options.onCoverage?.(args);return {data:options.coverage||[],error:options.coverageError||null};};
 return loadTypeScript("src/app/api/sync/status/route.ts",{
  "next/server":{NextResponse:{json:(body,init)=>Response.json(body,init)}},
  "@/lib/supabase-admin":{supabaseAdmin:database},
  "@/lib/capacity-health":{readCapacityHealth:async()=>{options.onCapacity?.();return {usedBytes:125000000,budgetBytes:500000000,percent:25,level:"ok",sampledAt:ago(30),stale:false};}},
  "@/lib/admin-auth":{verifyAdminSession:()=>!!options.admin},
  "@/lib/sync-service":{normalizeSyncTag:tag=>tag,readSyncSettings:async()=>({club_tag:"#CLUB",api_key:"private-key",...settings})},
 },{Date:FixedDate,process:{env:{}}});
}
const get=async(api)=>{const response=await api.GET(new Request("http://fixture/api/sync/status"));assert.equal(response.status,200);return response.json();};

test("a fresh roster never promotes old full or missing gameplay data to fresh",async()=>{
 const body=await get(route({last_sync_time:ago(60),last_full_sync_time:ago(60),last_roster_sync_time:ago(1)}));
 assert.equal(body.lastSuccessAt,ago(60));assert.equal(body.lastFullSuccessAt,ago(60));
 assert.equal(body.lastRosterSuccessAt,ago(1));assert.equal(body.rosterFreshness,"fresh");
 assert.equal(body.freshness,"stale");assert.equal(body.fullFreshness,"stale");
 assert.equal(body.lastBattleSuccessAt,null);assert.equal(body.battleFreshness,"never");
 assert.equal(body.lastRankedSuccessAt,null);assert.equal(body.rankedFreshness,"never");
 assert.deepEqual([body.rosterIntervalMinutes,body.expectedIntervalMinutes,body.rankedIntervalMinutes],[2,10,30]);
});

test("battle and ranked completion keep independent cadence and timestamps",async()=>{
 const body=await get(route({last_sync_time:ago(1),last_full_sync_time:ago(1),last_roster_sync_time:ago(1),last_battle_sync_time:ago(40),last_ranked_sync_time:ago(40)}));
 assert.equal(body.fullFreshness,"fresh");assert.equal(body.battleFreshness,"stale");assert.equal(body.rankedFreshness,"fresh");
 assert.equal(body.lastBattleSuccessAt,ago(40));assert.equal(body.lastRankedSuccessAt,ago(40));
 assert.deepEqual([body.rosterStaleAfterMinutes,body.staleAfterMinutes,body.battleStaleAfterMinutes,body.rankedStaleAfterMinutes],[5,25,25,65]);
});

test("legacy full marker is compatible but an explicitly reset marker stays empty",async()=>{
 const legacy=await get(route({last_sync_time:ago(5)}));assert.equal(legacy.lastSuccessAt,ago(5));
 assert.equal(legacy.battleFreshness,"never");assert.equal(legacy.rankedFreshness,"never");
 const reset=await get(route({last_sync_time:ago(5),last_full_sync_time:""}));assert.equal(reset.lastSuccessAt,null);assert.equal(reset.freshness,"never");
});

test("latest member or roster attempts cannot supply club-wide gameplay completion",async()=>{
 for(const scope of ["member","roster"]){const body=await get(route({last_sync_time:ago(90)}, {runs:[{id:"run-1",club_tag:"#CLUB",scope,source:"manual",started_at:ago(1),finished_at:now,status:"succeeded",counts:{members:1},result:{timestamp:now}}]}));
 assert.equal(body.latestRun.scope,scope);assert.equal(body.lastAttemptAt,ago(1));assert.equal(body.lastSuccessAt,ago(90));assert.equal(body.battleFreshness,"never");}
});

test("public run warnings and counts allow only known safe fields",async()=>{
 const api=route({}, {runs:[{id:"run-1",club_tag:"#CLUB",scope:"full",source:"cron",started_at:ago(1),status:"succeeded",counts:{members:30,battles:123,events:2,owner_user_id:"private-owner",notes:"private-notes"},result:{api_key:"private-key",member:{owner_user_id:"private-owner"},warnings:["battle_logs_incomplete","ranked_rate_limited","battle_logs_incomplete","private-error-body",{owner_user_id:"private-owner"}]}}]});
 const response=await api.GET(new Request("http://fixture/api/sync/status"));const body=await response.json();
 assert.deepEqual(body.latestRun.warnings,["battle_logs_incomplete","ranked_rate_limited"]);
 assert.deepEqual(body.latestRun.counts,{members:30,battles:123,events:2});
 assert.deepEqual(body.latestFullRun,body.latestRun);
 assert.doesNotMatch(JSON.stringify(body),/private-|owner_user_id|api_key/);
 assert.equal(Object.hasOwn(body,"recentRuns"),false);assert.equal(Object.hasOwn(body.latestRun,"result"),false);
 assert.equal(response.headers.get("cache-control"),"no-store");assert.equal(response.headers.get("vary"),"Cookie");
});

test("invalid or future markers cannot claim freshness",async()=>{
 const body=await get(route({last_full_sync_time:"not-a-date",last_roster_sync_time:"2099-01-01T00:00:00Z",last_battle_sync_time:"2099-01-01T00:00:00Z",sync_expected_interval_minutes:"invalid",sync_roster_interval_minutes:"0",sync_ranked_interval_minutes:"-1"}));
 assert.equal(body.lastSuccessAt,null);assert.equal(body.fullFreshness,"stale");assert.equal(body.lastRosterSuccessAt,null);assert.equal(body.rosterFreshness,"stale");assert.equal(body.battleFreshness,"stale");
 assert.deepEqual([body.rosterIntervalMinutes,body.expectedIntervalMinutes,body.rankedIntervalMinutes],[2,10,30]);
});

test("frequent roster successes cannot hide the separate full attempt or its safe partial warnings",async()=>{
 const full={id:"partial-full",club_tag:"#CLUB",scope:"full",source:"cron",started_at:ago(10),finished_at:ago(9),status:"succeeded",counts:{members:30,owner_user_id:"private-owner"},result:{warnings:["battle_logs_incomplete","private-detail"],api_key:"private-key"}};
 const runs=[full,...Array.from({length:25},(_,index)=>({id:`roster-${index}`,club_tag:"#CLUB",scope:"roster",source:"cron",started_at:ago((index+1)/10),status:"succeeded",result:{warnings:[]}})),{...full,id:"other-club",club_tag:"#OTHER",started_at:now}];
 for(const admin of [false,true]){
  const body=await get(route({last_full_sync_time:ago(9),last_battle_sync_time:ago(20),last_roster_sync_time:ago(.1)},{runs,admin}));
  assert.equal(body.latestRun.scope,"roster");assert.deepEqual(body.latestRun.warnings,[]);
  assert.equal(body.latestFullRun.id,"partial-full");assert.deepEqual(body.latestFullRun.warnings,["battle_logs_incomplete"]);
  assert.equal(body.fullFreshness,"fresh");assert.equal(body.battleFreshness,"fresh");
  assert.doesNotMatch(JSON.stringify(body),/private-|owner_user_id|api_key/);
 }
});

test("an in-flight full retry retains the previous terminal outcome until it finishes",async()=>{
 const previous={id:"previous-full",club_tag:"#CLUB",scope:"full",source:"cron",started_at:ago(10),finished_at:ago(9),status:"failed",error_code:"upstream_rate_limited"};
 const retry={id:"retry",club_tag:"#CLUB",scope:"full",source:"cron",started_at:ago(1),status:"running",result:{warnings:[]}};
 let body=await get(route({}, {runs:[previous,retry]}));
 assert.equal(body.latestRun.id,"retry");assert.equal(body.latestFullRun.id,"previous-full");assert.equal(body.latestFullRun.status,"failed");
 body=await get(route({}, {runs:[previous,{...retry,status:"succeeded",finished_at:now}]}));
 assert.equal(body.latestFullRun.id,"retry");assert.equal(body.latestFullRun.status,"succeeded");assert.deepEqual(body.latestFullRun.warnings,[]);
});

test("coverage remains uncertain after fresh full and roster successes without exposing private rows",async()=>{
 const members=[{player_tag:"#A",is_current_member:true},{player_tag:"#B",is_current_member:true},{player_tag:"#LEFT",is_current_member:false}];
 const coverage=[{player_tag:"#A",baseline_started_at:ago(100),last_observed_at:ago(1),possible_gap:true,last_gap_detected_at:ago(50),gap_start_at:ago(70),gap_end_at:ago(60),private_note:"secret-row"},{player_tag:"#B",baseline_started_at:ago(90),last_observed_at:ago(2),possible_gap:false}];
 const body=await get(route({last_full_sync_time:ago(1),last_roster_sync_time:ago(.1),last_battle_sync_time:ago(1)}, {members,coverage,onCoverage:args=>assert.deepEqual(Array.from(args.p_player_tags),["#A","#B"])}));
 assert.equal(body.fullFreshness,"fresh");assert.equal(body.battleFreshness,"fresh");
 assert.deepEqual(body.battleCoverage,{status:"possible_gap",monitoredPlayers:2,currentPlayers:2,affectedPlayers:1,lastCheckedAt:ago(2),lastGapAt:ago(50),windowDays:28});
 assert.doesNotMatch(JSON.stringify(body),/#A|#B|#LEFT|secret-row|gap_start_at/);
});

test("coverage read failure is unknown and does not fail the rest of sync health",async()=>{
 const body=await get(route({last_full_sync_time:ago(1)}, {members:[{player_tag:"#A",is_current_member:true}],coverageError:{message:"private-database-error"}}));
 assert.equal(body.battleCoverage.status,"unknown");assert.equal(body.battleCoverage.currentPlayers,1);assert.equal(body.battleCoverage.monitoredPlayers,0);
 assert.equal(body.fullFreshness,"fresh");assert.doesNotMatch(JSON.stringify(body),/private-database-error/);
});

test("capacity is read and returned only for an authenticated admin, including unconfigured clubs",async()=>{
 for(const configured of [true,false]){
  const settings=configured?{}:{club_tag:"",api_key:""};let reads=0;
  const publicBody=await get(route(settings,{onCapacity:()=>reads++}));
  assert.equal(reads,0);assert.equal(Object.hasOwn(publicBody,"capacity"),false);
  const adminBody=await get(route(settings,{admin:true,onCapacity:()=>reads++}));
  assert.equal(reads,1);assert.equal(adminBody.capacity.usedBytes,125000000);assert.equal(adminBody.capacity.percent,25);
 }
});
