const { reportingReadRpc } = require("./helpers/reporting-reads-database.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { readOnlyDatabase } = require("./helpers/read-only-database.cjs");

const now = new Date("2026-09-16T12:00:00.000Z");
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now.getTime(); } }
const date = offset => new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0,10);
const tags = Array.from({ length:30 }, (_, index) => `#P${index}`);
const config = { "24h":1,"3d":3,"7d":7,"30d":30,"90d":90 };
const next = { NextResponse:{ json:(body,init) => Response.json(body,init) } };
const request = range => Object.assign(new Request(`http://fixture/api?range=${range}`), { nextUrl:new URL(`http://fixture/api?range=${range}`) });

function fixture() {
  const members = tags.map((player_tag, index) => ({ player_tag,player_name:`Player${index}`,trophies:1000,is_active:true }));
  return {
    members,
    member_history:tags.map(player_tag => ({ player_tag,is_current_member:true })),
    daily_stats:Array.from({ length:180 }, (_, day) => tags.map(player_tag => ({ player_tag,date:date(day),battles:1,wins:1,losses:0,star_player:1,trophies_gained:999,trophies_lost:0 }))).flat().concat([
      { player_tag:tags[0],date:date(-1),battles:999,wins:999 },
      { player_tag:"#FORMER",date:date(0),battles:999,wins:999 },
    ]),
    activity_summary:tags.map((player_tag,index) => ({ player_tag,last_activity_at:now.toISOString(),last_battle_at:now.toISOString(),
      trophies_24h:index === 0 ? 0 : null,trophies_3d:index === 0 ? -3 : 3,trophies_7d:7,trophies_30d:index === 29 ? null : 300,trophies_90d:null })),
    club_events:[0,2,6,29,89,90,-1].map((offset,id) => ({ id,event_type:"join",player_name:"Joined",event_time:`${date(offset)}T01:00:00.000Z` })),
    notifications:[{ id:1,type:"name_change",created_at:`${date(29)}T01:00:00.000Z` }],
    battle_history:[],player_tracking:[],settings:[{key:"club_tag",value:"#CLUB"},{key:"last_sync_time",value:now.toISOString()}],activity_log:[],brawler_snapshots:[],player_brawler_details:[],
  };
}

function database(tables, calls) {
  const base = readOnlyDatabase(tables);
  return {
    from(table) {
      const target = base.from(table);
      // Match the hosted1000-row default; correct90-day totals must paginate.
      target.limit(1000);
      const oldRange = target.range;
      target.range = (from, to) => { calls.push({table,from,to}); return oldRange(from,to); };
      return target;
    },
    async rpc(name,args) {
      if (["report_dashboard_read","report_leaderboard_read"].includes(name)) return reportingReadRpc(tables,calls)(name,args);
      calls.push({name,args});
      assert.equal(args.p_now, now.toISOString());
      if (name === "sync_activity_summary_v2") return { data:tables.activity_summary.filter(row => args.p_player_tags.includes(row.player_tag)),error:null };
      if (name === "report_member_activity_history") return { data:[],error:null };
      assert.equal(name, "report_account_trophy_trend");
      return { data:Array.from({length:args.p_days},(_,index) => ({ date:date(args.p_days - index - 1),trophies:index === args.p_days - 1 ? 30_000 : null,observed_members:index === args.p_days - 1 ? 30 : 0,total_members:30 })),error:null };
    },
  };
}

function load(file,tables,calls=[]) {
  return loadTypeScript(file, { "next/server":next,"@/lib/supabase-admin":{supabaseAdmin:database(tables,calls)} },{Date:FixedDate});
}

test("all five ranges keep report, insights and leaderboard daily totals consistent, including2700-row90d data", async () => {
  for (const [range,days] of Object.entries(config)) {
    const tables = fixture(), calls = [];
    const reportResponse = await load("src/app/api/reports/weekly/route.ts",tables,calls).GET(request(range));
    assert.equal(reportResponse.status,200);
    const report = await reportResponse.json();
    const insights = await (await load("src/app/api/insights/route.ts",tables,calls).GET(request(range))).json();
    const board = await (await load("src/app/api/leaderboard/route.ts",tables,calls).GET(request(range))).json();
    assert.equal(report.period.key,range); assert.equal(report.period.days,days);
    assert.equal(report.period.aggregation,"utc_days");
    assert.equal(report.period.start,`${date(days-1)}T00:00:00.000Z`);
    assert.equal(report.period.trophyProgressStart,new Date(now.getTime()-days*86_400_000).toISOString());
    assert.equal(report.summary.weeklyBattles,days*30); assert.equal(report.summary.weeklyWins,days*30);
    assert.equal(insights.insights.thisWeekTotal,days*30); assert.equal(insights.insights.prevWeekTotal,days*30);
    assert.equal(insights.insights.totalBattlesThisWeek,report.summary.weeklyBattles);
    assert.deepEqual(board.period,report.period); assert.deepEqual(insights.period,report.period);
    assert.equal(board.leaderboards.weeklyBattlers.reduce((sum,member) => sum+member.weekly.battles,0),days*30);
    assert.equal(report.trophyTrend.length,days);
    if (days>1) assert.equal(report.trophyTrend[0].trophies,null);
    if (range === "30d") {
      assert.equal(report.topGainers[0].trophyChange,300);
      assert.equal(report.summary.trophyProgressKnownMembers,29);
      assert.equal(insights.insights.mvpTrophies,300);
      assert.equal(board.leaderboards.weeklyTrophyGainers.length,29);
    }
    if (range === "90d") {
      assert.deepEqual(report.topGainers,[]); assert.deepEqual(report.topLosers,[]);
      assert.equal(report.summary.trophyProgressKnownMembers,0);
      assert.equal(insights.insights.mvpTrophies,null); assert.equal(insights.insights.mvpName,null);
      assert.deepEqual(board.leaderboards.weeklyTrophyGainers,[]);
      assert.ok(calls.some(call => call.table === "daily_stats" && call.from === 2000));
    }
  }
});

test("report and insights exclude history-only members from current and previous battle totals", async () => {
  for (const [range, days] of Object.entries(config)) {
    const tables = fixture();
    tables.member_history.push({ player_tag: "#MISSING", is_current_member: true });
    tables.daily_stats.push(
      { player_tag: "#MISSING", date: date(0), battles: 1000, wins: 1000 },
      { player_tag: "#MISSING", date: date(days + 1), battles: 777, wins: 777 },
    );
    const report = await (await load("src/app/api/reports/weekly/route.ts", tables).GET(request(range))).json();
    const { insights } = await (await load("src/app/api/insights/route.ts", tables).GET(request(range))).json();
    assert.equal(report.summary.totalMembers, 30);
    assert.equal(report.summary.weeklyBattles, days * 30);
    assert.equal(report.summary.weeklyWins, days * 30);
    assert.equal(insights.totalBattlesThisWeek, days * 30);
    assert.equal(insights.totalWins, days * 30);
    assert.equal(insights.prevWeekTotal, days * 30);
    assert.equal(insights.trendDiff, 0);
  }
});

test("an empty actual roster never reports retained daily battles as current club activity", async () => {
  const tables = fixture(); tables.members = [];
  const report = await (await load("src/app/api/reports/weekly/route.ts", tables).GET(request("7d"))).json();
  const { insights } = await (await load("src/app/api/insights/route.ts", tables).GET(request("7d"))).json();
  assert.equal(report.summary.totalMembers, 0); assert.equal(report.summary.weeklyBattles, 0); assert.equal(report.summary.weeklyWins, 0);
  assert.equal(insights.totalBattlesThisWeek, 0); assert.equal(insights.totalWins, 0); assert.equal(insights.prevWeekTotal, 0);
  assert.equal(insights.trendDiff, 0); assert.equal(insights.mvpName, null);
});

test("dashboard selected-range gain, no-progress and change summaries distinguish NULL from observed zero", async () => {
  const tables = fixture();
  const day = await (await load("src/app/api/dashboard/route.ts",tables).GET(request("24h"))).json();
  assert.equal(day.noProgressMembers.length,1); assert.equal(day.noProgressMembers[0].player_tag,tags[0]);
  assert.equal(day.summary.trophyProgressKnownMembers,1);
  assert.deepEqual(day.topGainers,[]); assert.equal(day.changeSummary.joins,1); assert.equal(day.changeSummary.nameChanges,0);
  const month = await (await load("src/app/api/dashboard/route.ts",tables).GET(request("30d"))).json();
  assert.equal(month.topGainers[0].trophies_30d,300); assert.deepEqual(month.noProgressMembers,[]);
  assert.equal(month.summary.trophyProgressKnownMembers,29);
  assert.equal(month.changeSummary.joins,4); assert.equal(month.changeSummary.nameChanges,1);
  const long = await (await load("src/app/api/dashboard/route.ts",tables).GET(request("90d"))).json();
  assert.deepEqual(long.topGainers,[]); assert.deepEqual(long.noProgressMembers,[]); assert.equal(long.changeSummary.joins,5);
  assert.equal(long.summary.trophyProgressKnownMembers,0);
  const fallback = await (await load("src/app/api/dashboard/route.ts",tables).GET(request("all"))).json();
  assert.equal(fallback.period.key,"7d"); assert.equal(fallback.changeSummary.joins,3);
});

test("member selected charts and battle totals use the full90days while current activity remains independent", async () => {
  const tables = fixture(), calls = [];
  const route = load("src/app/api/members/[tag]/route.ts",tables,calls);
  const response = await route.GET(request("90d"),{params:Promise.resolve({tag:tags[0]})});
  assert.equal(response.status,200);
  const member = await response.json();
  assert.equal(member.period.key,"90d"); assert.equal(member.activityHistoryResolution,"daily");
  assert.equal(member.member.activity_status,"active"); assert.equal(member.lastBattleTime,now.toISOString());
  assert.equal(member.member.last_battle_at,member.lastBattleTime,"Private review context must receive the same durable battle timestamp");
  assert.equal(member.member.trophies_30d,300); assert.equal(member.member.trophies_90d,null);
  assert.equal(member.battleStats.battles,90); assert.equal(member.enhancedStats.totalBattles,90);
  assert.equal(member.enhancedStats.totalDays,90); assert.equal(member.enhancedStats.netTrophies,null);
  assert.equal(Object.keys(member.calendarBattlesByDay).length,90);
  assert.ok(calls.some(call => call.name === "report_member_activity_history" && call.args.p_days === 90));
});

test("range queries reject unbounded periods and UTC dates survive leap-year and timezone boundaries", async () => {
  const {getReportingPeriod} = loadTypeScript("src/lib/reporting-period.ts");
  const period = getReportingPeriod("90d",new Date("2024-03-01T00:15:00+02:00"));
  assert.equal(period.dates.length,90); assert.equal(period.dates.at(-1),"2024-02-29");
  const data = load("src/lib/reporting-data.ts",fixture());
  await assert.rejects(data.fetchDailyStats(tags,"2020-01-01","2026-01-01"),/Invalid reporting range/);
  await assert.rejects(data.fetchDailyStats(tags,"invalid","2026-01-01"),/Invalid reporting range/);
});

test("history period excludes future events and legacy timestamps while all-history remains compatible", async () => {
  const future = new Date(now.getTime()+1).toISOString();
  const old = "2020-01-01T00:00:00.000Z";
  const tables = { member_history:[
    {player_tag:"#NOW",first_seen:now.toISOString(),is_current_member:true},
    {player_tag:"#JOIN_FUTURE",first_seen:future,is_current_member:true},
    {player_tag:"#LEFT_FUTURE",first_seen:old,last_left_at:future,is_current_member:false},
    {player_tag:"#LEGACY_FUTURE",first_seen:old,last_seen:future,is_current_member:false},
    {player_tag:"#EVENT_FUTURE",first_seen:old,is_current_member:true},
  ], club_events:[{id:1,player_tag:"#EVENT_FUTURE",event_type:"join",event_time:future}] };
  const route = loadTypeScript("src/app/api/history/route.ts", {
    "next/server":next,"@/lib/supabase-admin":{supabaseAdmin:readOnlyDatabase(tables)},
    "@/lib/admin-auth":{verifyAdminSession:() => false},
  },{Date:FixedDate});
  const body = await (await route.GET(request("90d"))).json();
  assert.deepEqual(body.history.map(row => row.player_tag),["#NOW"]);
  assert.equal((await (await route.GET(request("all"))).json()).history.length,5);
});
