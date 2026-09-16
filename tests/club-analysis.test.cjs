const test=require("node:test");
const assert=require("node:assert/strict");
const {loadTypeScript}=require("./helpers/load-typescript.cjs");
const at="2026-09-16T12:00:00.000Z";
class FixedDate extends Date{constructor(...args){super(...(args.length?args:[at]));}static now(){return Date.parse(at);}}
const next={NextResponse:{json:(body,init)=>Response.json(body,init)}};
const stats={observations:3,wins:1,losses:1,draws:0,unknownResults:1,winRate:50,durationObservations:1,recordedDurationSeconds:120,averageDurationSeconds:120};
const analysis=()=>({summary:{...stats,notes:"PRIVATE"},modes:[{...stats,context:"ladder",mode:"airHockey",owner_user_id:"PRIVATE"}],maps:[{...stats,context:"ranked",mode:"gemGrab",map:"Map"}],brawlers:[{...stats,context:"unknown",brawler:"Shelly"}],
  pairs:[{player1:{tag:"#A",name:"علي",private:"PRIVATE"},player2:{tag:"#B",name:"B"},context:"friendly",matches:1,wins:1,losses:0,draws:0,unknownResults:0,winRate:100}],
  hourly:Array.from({length:24},(_,hour)=>({...stats,hour})),
  facets:{contexts:[{key:"ladder",count:3}],modes:[{key:"airHockey",count:3}],maps:[{key:"Map",count:3}],brawlers:[{key:"Shelly",count:3}]},
  coverage:{status:"possible_gap",currentPlayers:2,monitoredPlayers:2,affectedPlayers:1,baselineAt:at,lastCheckedAt:at,earliestBattleAt:at,latestBattleAt:at,possibleGapCount:1,retainedGapWindowDays:28,requestedDays:7,fullPeriodMonitoredPlayers:0,stalePlayers:0,teamObservations:2,pairEligibleObservations:2,truncated:false,completeHistory:true,private:"PRIVATE"},
  limits:{observationLimit:100000,groupLimit:200,facetLimit:2000,truncated:false,groupCounts:{modes:1,maps:1,brawlers:1,pairs:1},facetCounts:{modes:1,maps:1,brawlers:1}},private:"PRIVATE"});
const readyRow=()=>({player:{tag:"#A",name:"علي",notes:"PRIVATE"},brawler:{id:16000000,name:"Shelly"},powerLevel:11,trophies:0,highestTrophies:null,rank:1,prestigeLevel:null,currentWinStreak:0,maxWinStreak:null,
  gadgets:[{id:1,name:"Gadget",level:0,token:"PRIVATE"}],starPowers:[],gears:null,hyperCharges:null,buffies:{gadget:false,starPower:true,hyperCharge:null,token:"PRIVATE"},observedAt:at,fieldCheckedAt:{power_level:at,highest_trophies:"2999-01-01T00:00:00Z",secret:"PRIVATE"},owner_user_id:"PRIVATE"});
const readiness=()=>({members:[{tag:"#A",name:"علي",brawlersObserved:1,power9Plus:1,power10Plus:1,power11:1,observedAt:at,notes:"PRIVATE"}],brawlers:[{id:16000000,name:"Shelly",playersObserved:1}],rows:[readyRow()],total:1});
function route(endpoint,data,calls=[],error=null){return loadTypeScript(`src/app/api/${endpoint}/route.ts`,{"next/server":next,"@/lib/supabase-admin":{supabaseAdmin:{rpc:async(name,args)=>{calls.push({name,args});return{data:typeof data==="function"?data():data,error};},from(){throw Error("Expected single RPC");}}}},{Date:FixedDate});}
const request=query=>new Request(`http://fixture/api?${query}`);

test("analysis uses one bounded RPC for each exact rolling period and canonical filter",async()=>{
  for(const [key,days] of [["24h",1],["3d",3],["7d",7],["30d",30],["90d",90]]){
    const calls=[],response=await route("analysis",analysis(),calls).GET(request(`range=${key}&mode=airHockey&context=ladder&map=Map&brawler=Shelly`));
    assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");const body=await response.json();
    assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{name:"club_analysis_read",args:{p_days:days,p_now:at,p_context:"ladder",p_mode:"brawlHockey",p_map:"Map",p_brawler:"Shelly"}}]);
    assert.deepEqual(body.period,{key,days,start:new Date(Date.parse(at)-days*86400000).toISOString(),end:at,aggregation:"rolling"});
    assert.equal(body.coverage.requestedDays,days);assert.equal(body.coverage.completeHistory,false);assert.equal(body.summary.unknownResults,1);assert.equal(body.summary.durationObservations,1);
  }
});

test("analysis preserves explicit categories, missing rates, independent zero-count categories and safe projections",async()=>{
  const data=analysis();data.summary.winRate=null;data.summary.averageDurationSeconds=null;
  const body=await(await route("analysis",data).GET(request("context=ladder"))).json();
  assert.equal(body.summary.winRate,null);assert.equal(body.summary.averageDurationSeconds,null);
  assert.equal(body.modes[0].context.key,"ladder");assert.equal(body.maps[0].context.key,"ranked");assert.equal(body.pairs[0].context.key,"friendly");
  assert.equal(body.modes[0].mode.key,"brawlHockey");assert.equal(body.facets.contexts.find(row=>row.key==="mega_pig").count,0);
  assert.equal(body.facets.contexts.length,7);assert.doesNotMatch(JSON.stringify(body),/PRIVATE|owner_user_id|notes|private/);
});

test("invalid analysis filters fail before reading the database",async()=>{
  const calls=[],source=route("analysis",analysis(),calls);
  for(const query of ["range=all","context=casual","mode="+"x".repeat(101),"map=%00","brawler="+"x".repeat(51)])assert.equal((await source.GET(request(query))).status,400,query);
  assert.equal(calls.length,0);
});

test("readiness keeps unknown distinct from zero/empty and filters nested private or future timestamp fields",async()=>{
  const calls=[],response=await route("readiness",readiness(),calls).GET(request("brawler=16000000&minPower=9&search=%D8%B9%D9%84%D9%8A&limit=1&offset=0"));
  assert.equal(response.status,200);const body=await response.json();
  assert.equal(calls.length,1);assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{name:"club_readiness_read",args:{p_now:at,p_brawler:16000000,p_min_power:9,p_search:"علي",p_offset:0,p_limit:1}});
  const row=body.rows[0];assert.equal(row.trophies,0);assert.equal(row.highestTrophies,null);assert.deepEqual(row.starPowers,[]);assert.equal(row.gears,null);
  assert.deepEqual(row.gadgets,[{id:1,name:"Gadget",level:0}]);assert.deepEqual(row.buffies,{gadget:false,starPower:true,hyperCharge:null});assert.deepEqual(row.fieldCheckedAt,{power_level:at});
  assert.equal(body.hasMore,false);assert.equal(body.nextOffset,null);assert.doesNotMatch(JSON.stringify(body),/PRIVATE|owner_user_id|notes|token|secret/);
});

test("readiness paginates the selected inventory and refuses invalid filters without database work",async()=>{
  const data=readiness();data.total=5;const calls=[],source=route("readiness",data,calls);
  const response=await source.GET(request("limit=1&offset=2")),body=await response.json();assert.equal(body.total,5);assert.equal(body.nextOffset,3);assert.equal(body.hasMore,true);
  for(const query of ["minPower=12","limit=201","limit=0","offset=-1","brawler=1.2","brawler=2147483648","search="+"x".repeat(101)])assert.equal((await source.GET(request(query))).status,400,query);
  assert.equal(calls.length,1);
});

test("analysis and readiness database errors or malformed snapshots reveal no internal details",async()=>{
  for(const name of ["analysis","readiness"]){
    for(const [data,error] of [[null,{message:"PRIVATE password",code:"XX000"}],[{},null]]){
      const response=await route(name,data,[],error).GET(request(""));assert.equal(response.status,500);assert.equal(response.headers.get("cache-control"),"no-store");
      assert.doesNotMatch(JSON.stringify(await response.json()),/PRIVATE|XX000/);
    }
  }
  const empty=readiness();empty.rows=[];
  assert.equal((await route("readiness",empty).GET(request(""))).status,500,"A malformed empty page cannot create an endless Load More cursor");
});
