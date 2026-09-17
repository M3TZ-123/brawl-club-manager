const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { readOnlyDatabase } = require("./helpers/read-only-database.cjs");

const now = new Date("2026-09-15T22:00:00.000Z");
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
  static now() { return now.getTime(); }
}
const ago = hours => new Date(now.getTime() - hours * 3_600_000).toISOString();
const responseMock = { NextResponse: { json: (body, init) => Response.json(body, init) } };

function fixture(threshold = "48") {
  return {
    settings: [{ key: "inactivity_threshold", value: threshold }, { key: "club_tag", value: "#CLUB" }, { key: "last_sync_time", value: now.toISOString() }],
    activity_summary: [1, 30, 70].map((hours, index) => ({
      player_tag: ["#A", "#B", "#C"][index], last_battle_at: ago(hours), last_activity_at: ago(hours),
      trophies_24h: index === 0 ? 8 : null, trophies_3d: 8, trophies_7d: 8, trophies_30d: index === 0 ? 300 : null, trophies_90d: null,
    })),
    member_history: ["#A", "#B", "#C"].map(player_tag => ({ player_tag, is_current_member: true })),
    members: [
      { player_tag: "#A", player_name: "Active", trophies: 1000, is_active: false },
      { player_tag: "#B", player_name: "Low", trophies: 2000, is_active: true },
      { player_tag: "#C", player_name: "Inactive", trophies: 3000, is_active: true },
      { player_tag: "#FORMER", player_name: "Former", trophies: 9000, is_active: true },
    ],
    activity_log: [{ player_tag: "#C", recorded_at: ago(1), trophy_change: 0, trophies: 3000, activity_type: "minimal" }],
    player_tracking: [],
    player_brawler_details: [],
    battle_history: [
      { player_tag: "#A", battle_time: ago(1), mode: "brawlBall", trophy_change: 8 },
      { player_tag: "#B", battle_time: ago(30), mode: "brawlBall", trophy_change: 8 },
      { player_tag: "#C", battle_time: ago(70), mode: "brawlBall", trophy_change: 8 },
    ],
    daily_stats: [
      { player_tag: "#A", date: "2026-09-08", battles: 99, wins: 99, trophies_gained: 999 },
      { player_tag: "#A", date: "2026-09-09", battles: 10, wins: 5, trophies_gained: 100, trophies_lost: 20 },
      { player_tag: "#A", date: "2026-09-15", battles: 20, wins: 20, trophies_gained: 200, trophies_lost: 50 },
      { player_tag: "#A", date: "2026-09-16", battles: 999, wins: 999, trophies_gained: 999 },
      { player_tag: "#FORMER", date: "2026-09-15", battles: 999, wins: 999 },
    ],
    club_events: [
      { event_type: "join", player_name: "Old", event_time: "2026-09-08T23:59:59.999Z" },
      { event_type: "join", player_name: "Included", event_time: "2026-09-09T00:00:00.000Z" },
      { event_type: "join", player_name: "Future", event_time: "2026-09-16T00:00:00.000Z" },
    ],
  };
}

function load(file, tables) {
  return loadTypeScript(file, {
    "@/lib/supabase-admin": { supabaseAdmin: database(tables) },
    "next/server": responseMock,
  }, { Date: FixedDate });
}

function database(tables) {
  return { ...readOnlyDatabase(tables), async rpc(name, args) {
    if (name === "report_account_trophy_trend") {
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      return { data: Array.from({ length: args.p_days }, (_, index) => ({ date: new Date(today - (args.p_days - 1 - index) * 86_400_000).toISOString().slice(0, 10), trophies: null, observed_members: 0, total_members: args.p_player_tags.length })), error: null };
    }
    if (name === "report_member_activity_history") return { data: tables.activity_log.filter(row => row.player_tag === args.p_player_tag), error: null };
    assert.equal(name, "sync_activity_summary_v2");
    assert.equal(args.p_now, now.toISOString());
    return { data: tables.activity_summary.filter(row => args.p_player_tags.includes(row.player_tag)), error: null };
  } };
}

test("activity classifies durable evidence using configured inactivity thresholds", async () => {
  for (const [threshold, expected] of [["48", "inactive"], ["96", "minimal"]]) {
    const tables = fixture(threshold);
    const { appendMemberActivityMetrics } = load("src/lib/member-activity-metrics.ts", tables);
    const members = await appendMemberActivityMetrics(tables.members.slice(0, 3), now);
    assert.equal(members[0].activity_status, "active");
    assert.equal(members[1].activity_status, "minimal");
    assert.equal(members[2].activity_status, expected);
  }
});

test("a real trophy change is activity even if the available battle log is old", async () => {
  const tables = fixture();
  tables.activity_log[0].trophy_change = 10;
  tables.activity_summary[2].last_activity_at = ago(1);
  const { appendMemberActivityMetrics } = load("src/lib/member-activity-metrics.ts", tables);
  const [member] = await appendMemberActivityMetrics([tables.members[2]], now);
  assert.equal(member.activity_status, "active");
  assert.equal(member.last_battle_at, ago(70));
});

test("weekly totals, chart, events, and insights share the same seven UTC dates", async () => {
  const tables = fixture();
  const report = await (await load("src/app/api/reports/weekly/route.ts", tables).GET()).json();
  assert.equal(report.period.start, "2026-09-09T00:00:00.000Z");
  assert.equal(report.period.end, now.toISOString());
  assert.equal(report.summary.totalMembers, 3);
  assert.equal(report.summary.totalTrophies, 6000);
  assert.equal(report.summary.weeklyBattles, 30);
  assert.equal(report.summary.weeklyWins, 25);
  assert.equal(report.topGainers[0].trophyChange, 8);
  assert.equal(report.trophyTrend.length, 7);
  assert.equal(report.trophyTrend[0].date, report.period.start.slice(0, 10));
  assert.equal(report.trophyTrend[6].date, report.period.end.slice(0, 10));
  assert.deepEqual(report.recentEvents.map(event => event.player_name), ["Included"]);
  const { insights } = await (await load("src/app/api/insights/route.ts", tables).GET()).json();
  assert.equal(insights.totalBattlesThisWeek, report.summary.weeklyBattles);
  assert.equal(insights.totalWins, report.summary.weeklyWins);
});

test("report activity is calculated now instead of trusting old is_active flags", async () => {
  const report = await (await load("src/app/api/reports/weekly/route.ts", fixture()).GET()).json();
  assert.equal(report.summary.activeMembers, 1);
  assert.equal(report.summary.activityRate, 33);
  assert.deepEqual(report.activityDistribution, { active: 1, minimal: 1, inactive: 1 });
});

test("weekly UTC dates remain correct across year and leap-day boundaries", () => {
  const { getWeeklyReportingPeriod } = loadTypeScript("src/lib/reporting-period.ts");
  assert.equal(getWeeklyReportingPeriod(new Date("2026-01-02T00:15:00Z")).dates[0], "2025-12-27");
  const leapPeriod = getWeeklyReportingPeriod(new Date("2024-03-02T23:00:00-08:00"));
  assert.equal(leapPeriod.dates[0], "2024-02-26");
  assert.equal(leapPeriod.dates[6], "2024-03-03");
  assert.ok(leapPeriod.dates.includes("2024-02-29"));
});

test("activity cutoffs use actual elapsed time and reject invalid future evidence", () => {
  const { classifyActivity } = loadTypeScript("src/lib/activity-status.ts");
  assert.equal(classifyActivity(new Date(ago(24)), now, 48), "active");
  assert.equal(classifyActivity(new Date(ago(48)), now, 48), "minimal");
  assert.equal(classifyActivity(new Date(ago(48.01)), now, 48), "inactive");
  assert.equal(classifyActivity(new Date(ago(-24)), now, 48), "inactive");
  assert.equal(classifyActivity(new Date("invalid"), now, 48), "inactive");
});

test("member detail and roster agree when corrupt tracking dates coexist with real activity", async () => {
  const tables = fixture();
  tables.battle_history = [];
  tables.brawler_snapshots = [];
  tables.player_tracking = [{ player_tag: "#C", last_battle_date: "2026-09-18" }];
  tables.activity_log[0].trophy_change = 10;
  tables.activity_summary[2].last_activity_at = ago(1);
  tables.activity_summary[2].last_battle_at = null;
  const route = loadTypeScript("src/app/api/members/[tag]/route.ts", {
    "@/lib/supabase-admin": { supabaseAdmin: database(tables) },
    "@/lib/brawl-api": { calculateEnhancedStats: () => null },
    "@/lib/admin-auth": { rejectUnauthorizedAdminMutation: () => null },
    "next/server": responseMock,
  }, { Date: FixedDate });
  const response = await route.GET(new Request("http://localhost/api/members/%23C"), { params: Promise.resolve({ tag: "#C" }) });
  assert.equal(response.status, 200);
  const detail = await response.json();
  const { appendMemberActivityMetrics } = load("src/lib/member-activity-metrics.ts", tables);
  const [member] = await appendMemberActivityMetrics([tables.members[2]], now);
  assert.equal(detail.member.activity_status, "active");
  assert.equal(detail.member.activity_status, member.activity_status);
  assert.equal(detail.lastBattleTime, null);
});

test("member brawler personal best comes from the official profile; old snapshots remain history only", async () => {
  const tables = fixture(); tables.members[0].brawlers_count = 1;
  tables.brawler_snapshots = [{ player_tag: "#A", brawler_id: 1, brawler_name: "SHELLY", power_level: 10, trophies: 900, rank: 20, recorded_at: ago(24) }];
  const get = async () => {
    const response = await load("src/app/api/members/[tag]/route.ts", tables).GET(new Request("http://fixture/api/members/%23A"), { params: Promise.resolve({ tag: "#A" }) });
    assert.equal(response.status, 200); return response.json();
  };
  assert.equal((await get()).topBrawlers[0].highestTrophies, null, "An observed daily maximum is not an official personal best");
  tables.player_brawler_details = [{ player_tag: "#A", brawler_id: 1, brawler_name: "SHELLY", power_level: 11, trophies: 750, rank: 25, highest_trophies: 1000 }];
  const official = await get(); assert.equal(official.topBrawlers[0].highestTrophies, 1000); assert.equal(official.topBrawlers[0].trophies, 750); assert.equal(official.powerDistribution.maxedCount, 1);
  tables.player_brawler_details = []; tables.members[0].brawlers_count = 0;
  const empty = await get(); assert.deepEqual(empty.topBrawlers, []); assert.equal(empty.powerDistribution, null);
});
