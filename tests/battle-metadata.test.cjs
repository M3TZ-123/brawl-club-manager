const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { readOnlyDatabase } = require("./helpers/read-only-database.cjs");
const { battleFeedRpc } = require("./helpers/battle-feed-database.cjs");
const json = value => JSON.parse(JSON.stringify(value));
const now = Date.parse("2026-09-16T12:00:00Z");
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const item = (mode, data = {}, event = {}) => ({ battleTime:"20260916T110000.000Z", event:{id:15001280,mode,map:"Test map",...event}, battle:{mode,type:"ranked",...data} });
function api(items = []) {
  return loadTypeScript("src/lib/brawl-api.ts", { axios:{create:()=>({get:async()=>({data:{items}})})}, "./utils":{encodeTag:encodeURIComponent} });
}

test("battle processing keeps source type, event IDs and both modes without synthesizing points", () => {
  const { processBattleLog } = api();
  const processed = processBattleLog("#A", {items:[
    item("duoShowdown",{type:"soloRanked",rank:3},{mode:"trioShowdown",modeId:38}),
    item("internal",{trophyChange:0},{id:0,modeId:0}),
    item("airHockey",{trophyChange:8}),
    item("futureMode",{type:"futureType",rank:1}),
  ]});
  assert.equal(processed[0].mode,"trioShowdown");
  assert.equal(processed[0].battle_mode,"duoShowdown"); assert.equal(processed[0].event_mode,"trioShowdown");
  assert.equal(processed[0].event_mode_id,38); assert.equal(processed[0].event_id,15001280);
  assert.equal(processed[0].battle_type,"soloRanked"); assert.equal(processed[0].placement_rank,3);
  assert.equal(processed[0].result,"defeat"); assert.equal(processed[0].trophy_change,null); assert.equal(processed[0].trophy_change_reported,false);
  assert.equal(processed[1].mode,"gemGrab"); assert.equal(processed[1].event_id,0); assert.equal(processed[1].event_mode_id,0);
  assert.equal(processed[1].trophy_change,0); assert.equal(processed[1].trophy_change_reported,true);
  assert.equal(processed[2].mode,"brawlHockey"); assert.equal(processed[2].battle_mode,"airHockey");
  assert.equal(processed[3].battle_type,"futureType"); assert.equal(processed[3].result,"unknown");
});

test("placement results use proven Solo/Duo/Trio/Duels thresholds, event identity and explicit results", async () => {
  const cases = [["soloShowdown",4,"victory"],["soloShowdown",5,"defeat"],["duoShowdown",2,"victory"],
    ["duoShowdown",3,"defeat"],["trioShowdown",2,"victory"],["trioShowdown",3,"defeat"],
    ["tagTeam",1,"victory"],["tagTeam",2,"defeat"],["futureShowdown",1,"unknown"],
    ["trioShowdown",5,"unknown"],["duels",0,"unknown"],["duels",1.5,"unknown"]];
  const items = cases.map(([mode,rank])=>item(mode,{rank}));
  items.push(item("duels",{rank:2,result:"victory"}));
  const source = api(items), processed = source.processBattleLog("#A",{items});
  assert.deepEqual(processed.map(row=>row.result).join(","),[...cases.map(row=>row[2]),"victory"].join(","));
  assert.deepEqual(json(source.calculateWinRateFromBattleLog({items})),{winRate:56,totalBattles:9,wins:5});
  const stats = await source.getPlayerBattleStats("#A");
  assert.equal(stats.wins,5); assert.equal(stats.losses,4); assert.equal(stats.battles,13);
});

test("points preserve real zero and nonzero legacy data without assigning unknown units to trophies", () => {
  const { battlePointData } = loadTypeScript("src/lib/battle-point-data.ts");
  const cases = [
    [{trophy_change:0,trophy_change_reported:null,battle_type:null},{change:null,unit:"unknown",source:null}],
    [{trophy_change:8,trophy_change_reported:null,battle_type:"ranked"},{change:8,unit:"unknown",source:null}],
    [{trophy_change:-5,trophy_change_reported:null},{change:-5,unit:"unknown",source:null}],
    [{trophy_change:0,trophy_change_reported:true,battle_type:"ranked"},{change:0,unit:"trophies",source:"battle.trophyChange"}],
    [{trophy_change:1,trophy_change_reported:true,battle_type:"challenge"},{change:1,unit:"unknown",source:"battle.trophyChange"}],
    [{trophy_change:null,trophy_change_reported:false,battle_type:"soloRanked"},{change:null,unit:"unknown",source:null}],
    [{trophy_change:20,trophy_change_reported:true,battle_type:"teamRanked"},{change:20,unit:"unknown",source:"battle.trophyChange"}],
  ];
  for (const [input, expected] of cases) assert.deepEqual(json(battlePointData(input)),expected);
});

function route(rows, calls = []) {
  const tags=["#A","#B"];
  const database=readOnlyDatabase({member_history:tags.map(player_tag=>({player_tag,is_current_member:true})),members:tags.map(player_tag=>({player_tag,player_name:player_tag}))});
  database.rpc=battleFeedRpc(rows,calls);
  return loadTypeScript("src/app/api/battles/feed/route.ts",{"@/lib/supabase-admin":{supabaseAdmin:database},"next/server":{NextResponse:{json:(body,init)=>Response.json(body,init)}}},{Date:FixedDate});
}
async function get(source, query) { const response=await source.GET(new Request("http://fixture/api/battles/feed?"+query));assert.equal(response.status,200);return response.json(); }

test("complete range facets reach older rare modes and context filtering happens before pagination",async()=>{
  const rows=Array.from({length:1600},(_,i)=>({player_tag:"#A",battle_time:new Date(now-60_000-i*1000).toISOString(),mode:"brawlBall",battle_type:"ranked",map:"Recent"}));
  rows.push({player_tag:"#A",battle_time:new Date(now-20*86400000).toISOString(),mode:"megaBoss",map:"Old event",battle_type:null});
  rows.push({player_tag:"#B",battle_time:new Date(now-19*86400000).toISOString(),mode:"airHockey",battle_type:"soloRanked",trophy_change:null,trophy_change_reported:false,map:"Ranked"});
  const calls=[],source=route(rows,calls), body=await get(source,"range=30d&limit=1&context=ranked");
  assert.equal(body.total,1);assert.equal(body.matches.length,1);assert.equal(body.matches[0].mode,"brawlHockey");assert.equal(body.matches[0].context.key,"ranked");
  assert.equal(body.matches[0].clubPlayers[0].pointData.change,null);
  assert.deepEqual(body.modes.sort(),["brawlBall","brawlHockey","megaBoss"]);
  assert.equal(body.contexts.find(row=>row.key==="ladder").count,1600);
  assert.equal(body.contexts.find(row=>row.key==="unknown").count,1);
  assert.equal(body.contexts.find(row=>row.key==="mega_pig").count,0);
  assert.equal(body.facetsBasis,"member_observations");assert.equal(body.observationCount,1602);
  assert.ok(calls.every(call=>call.args.p_context==="ranked"));
  assert.deepEqual((await get(source,"range=24h")).modes,["brawlBall"]);
  assert.equal((await get(source,"range=30d&mode=airHockey")).total,1);
  assert.equal((await get(source,"range=30d&context=unknown")).matches[0].mode,"megaBoss");
  assert.equal((await source.GET(new Request("http://fixture/api/battles/feed?context=__proto__"))).status,400);
});

test("canonical Hockey observations combine while Trio exposes all teams and private payload keys never escape",async()=>{
  const players=Array.from({length:6},(_,i)=>({tag:i===0?"#A":i===1?"#B":`#P${i}`,name:"Public",owner_user_id:"PRIVATE"}));
  const common={battle_time:new Date(now-1000).toISOString(),mode:"airHockey",map:"Hockey",battle_type:"ranked",trophy_change:0,trophy_change_reported:true,event_id:1,teams_json:[players.slice(0,3),players.slice(3)],owner_user_id:"PRIVATE"};
  const body=await get(route(["#A","#B"].map(player_tag=>({...common,player_tag}))),"limit=1");
  assert.equal(body.matches.length,1);assert.equal(body.matches[0].clubPlayers.length,2);assert.equal(body.matches[0].teamCount,2);
  assert.equal(body.matches[0].clubPlayers[0].pointData.change,0);assert.doesNotMatch(JSON.stringify(body),/PRIVATE|owner_user_id/);
  const trio=await get(route([{...common,player_tag:"#A",event_mode_id:38,battle_mode:"duoShowdown",event_mode:"trioShowdown",teams_json:Array.from({length:4},(_,i)=>Array.from({length:3},(_,j)=>({tag:i===0&&j===0?"#A":`#P${i}${j}`})))}]),"");
  assert.equal(trio.matches[0].isShowdown,true);assert.equal(trio.matches[0].teamCount,4);assert.equal(trio.matches[0].teams.length,4);
});
