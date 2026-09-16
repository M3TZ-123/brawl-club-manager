const test=require("node:test");
const assert=require("node:assert/strict");
const {loadTypeScript}=require("./helpers/load-typescript.cjs");
const {reportingReadRpc}=require("./helpers/reporting-reads-database.cjs");
const timestamp="2026-09-16T12:00:00.000Z";
class FixedDate extends Date {constructor(...args){super(...(args.length?args:[timestamp]));}static now(){return Date.parse(timestamp);}}
const next={NextResponse:{json:(body,init)=>Response.json(body,init)}};
const request=range=>Object.assign(new Request(`http://fixture/api?range=${range}`),{nextUrl:new URL(`http://fixture/api?range=${range}`)});
function fixture(){return {
  members:[{player_tag:"#A",player_name:"علي",role:"member",trophies:1000,highest_trophies:1200,brawlers_count:20,owner_user_id:"PRIVATE",private_future:"SECRET"}],
  member_history:[{player_tag:"#A",is_current_member:true}],
  activity_summary:[{player_tag:"#A",last_activity_at:"2026-09-13T12:00:00.000Z",last_battle_at:"2026-09-13T12:00:00.000Z",trophies_24h:0,trophies_3d:-3,trophies_7d:7,trophies_30d:null,trophies_90d:null,trophy_baselines:{"7d":"2026-09-09T12:00:00.000Z",owner_user_id:"PRIVATE"}}],
  settings:[{key:"inactivity_threshold",value:"96"},{key:"last_sync_time",value:timestamp},{key:"scheduler_token",value:"SECRET"}],
  daily_stats:[{player_tag:"#A",date:"2026-09-16",battles:3,wins:2,losses:1,star_player:1},{player_tag:"#A",date:"2026-09-14",battles:5,wins:3,losses:2,star_player:2}],
  player_tracking:[{player_tag:"#A",total_battles:999999,current_streak:999}],
  club_events:[{id:1,player_tag:"#A",player_name:"علي",event_type:"join",event_time:timestamp,owner_user_id:"PRIVATE"}],notifications:[],
};}
function route(name,tables,calls){return loadTypeScript(`src/app/api/${name}/route.ts`,{"next/server":next,"@/lib/supabase-admin":{supabaseAdmin:{
  rpc:reportingReadRpc(tables,calls),from(){throw Error("Reporting must use one RPC, not table requests");},
}}},{Date:FixedDate});}

test("dashboard performs one snapshot read and preserves public summaries, unknowns and configured activity",async()=>{
  const calls=[],source=route("dashboard",fixture(),calls);
  const response=await source.GET(request("7d")),body=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{name:"report_dashboard_read",args:{p_days:7,p_now:timestamp}}]);
  assert.deepEqual(body.summary,{totalMembers:1,totalTrophies:1000,activeMembers:0,avgTrophies:1000,trophyProgressKnownMembers:1});
  assert.equal(body.topMembers[0].activity_status,"minimal");assert.equal(body.topMembers[0].trophies_30d,null);
  assert.equal(body.topGainers[0].trophies_7d,7);assert.equal(body.changeSummary.joins,1);assert.equal(body.syncStatus.lastSyncTime,timestamp);
  assert.doesNotMatch(JSON.stringify(body),/owner_user_id|private_future|PRIVATE|SECRET|scheduler_token|inactivityThreshold/);
});

test("leaderboard reads only its selected period with six smaller public lists and no retained-history substitutes",async()=>{
  for(const [range,days,battles,change] of [["24h",1,3,0],["3d",3,8,-3],["90d",90,8,null]]){
    const calls=[],response=await route("leaderboard",fixture(),calls).GET(request(range)),body=await response.json();
    assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
    assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{name:"report_leaderboard_read",args:{p_days:days,p_now:timestamp}}]);
    assert.equal(Object.keys(body.leaderboards).length,6);assert.equal(body.leaderboards.weeklyBattlers[0].weekly.battles,battles);
    assert.equal(body.leaderboards.trophyLeaders[0].weekly.netTrophies,change);
    assert.equal(body.leaderboards.weeklyWinRate.length,range==="90d"?0:1);
    assert.doesNotMatch(JSON.stringify(body),/allTime|currentStreak|bestStreak|999999|totalVictories|rankCurrent|expLevel|trophiesGained|trophiesLost|PRIVATE|SECRET/);
  }
});

test("uncached reads cannot reuse a previous roster or activity result after a club update",async()=>{
  const tables=fixture(),calls=[],source=route("dashboard",tables,calls);
  assert.equal((await (await source.GET(request("7d"))).json()).summary.totalMembers,1);
  tables.member_history[0].is_current_member=false;
  const changed=await (await source.GET(request("7d"))).json();
  assert.equal(changed.summary.totalMembers,0);assert.deepEqual(changed.topMembers,[]);assert.equal(calls.length,2);
});

test("reporting failures return no partial public snapshot or sensitive database details",async()=>{
  for(const endpoint of ["dashboard","leaderboard"]){
    const source=loadTypeScript(`src/app/api/${endpoint}/route.ts`,{"next/server":next,"@/lib/supabase-admin":{supabaseAdmin:{rpc:async()=>({data:null,error:{message:"SECRET database details",code:"XX000"}})}}},{Date:FixedDate,console:{error(){}}});
    const response=await source.GET(request("7d"));assert.equal(response.status,500);assert.equal(response.headers.get("cache-control"),"no-store");
    assert.doesNotMatch(JSON.stringify(await response.json()),/SECRET|XX000/);
  }
});
