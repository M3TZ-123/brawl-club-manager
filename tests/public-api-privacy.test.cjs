const { reportingReadRpc } = require("./helpers/reporting-reads-database.cjs");
const { battleFeedRpc } = require("./helpers/battle-feed-database.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { readOnlyDatabase } = require("./helpers/read-only-database.cjs");
const timestamp = "2026-09-16T12:00:00.000Z";
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [timestamp])); } static now() { return Date.parse(timestamp); } }
const owner = "private-owner-fixture-identifier";
function tables() {
  const rows = {
    members: [{ player_tag: "#A", player_name: "Public fixture", trophies: 1000, highest_trophies: 1500, role: "member", is_active: true, last_updated: timestamp, rank_current: "Diamond I", ranked_points: 3417, ranked_provenance: { rank_current: { source: "profile", checked_at: timestamp } } }],
    member_history: [{ player_tag: "#A", is_current_member: true }],
    club_events: [{ id: 1, event_type: "join", player_tag: "#A", player_name: "Public fixture", event_time: timestamp }],
    notifications: [{ id: 1, type: "join", title: "Joined", message: "Public fixture joined", player_tag: "#A", player_name: "Public fixture", is_read: false, created_at: timestamp }],
    battle_history: [{ player_tag: "#A", battle_time: timestamp, mode: "brawlBall", map: "Fixture map", result: "victory", trophy_change: 8, is_star_player: false, brawler_name: "SHELLY", brawler_power: 11, teams_json: [[{tag:"#A",name:"Public fixture",owner_user_id:owner}],[{tag:"#B",name:"Opponent",owner_user_id:owner}]] }],
    daily_stats: [{ player_tag: "#A", date: "2026-09-16", battles: 1, wins: 1, losses: 0, star_player: 0, trophies_gained: 8, trophies_lost: 0 }],
    player_tracking: [{ player_tag: "#A", total_battles: 1, total_wins: 1, active_days: 1 }],
    settings: [{ key: "last_sync_time", value: timestamp }],
  };
  return Object.fromEntries(Object.entries(rows).map(([table, data]) => [table, data.map(row => ({...row, owner_user_id: owner}))]));
}
// Match PostgREST's explicit column projection, keeping raw ownership fields in
// the database fixtures so a select('*') regression exposes the real leak.
function projectedDatabase(selections) {
  const database = readOnlyDatabase(tables());
  return { async rpc(name, args) {
    if (["report_dashboard_read","report_leaderboard_read"].includes(name)) return reportingReadRpc(tables())(name,args);
    if (name.startsWith("battle_feed_")) return battleFeedRpc(tables().battle_history)(name, args);
    assert.equal(name, "report_account_trophy_trend");
    return { data: [{ date: "2026-09-16", trophies: 1000, observed_members: 1, total_members: 1, owner_user_id: owner }], error: null };
  }, from(table) {
    const base = database.from(table); let columns = "*", head = false;
    const query = new Proxy(base, { get(target, name) {
      if (name === "select") return (value, options = {}) => { columns = value; head = !!options.head; selections.push({table, columns, head}); return query; };
      if (name === "not") return (key, operator, value) => { assert.equal(operator, "is"); target.neq(key, value); return query; };
      if (name === "then") return (resolve, reject) => target.then(result => {
        const project = row => columns === "*" || row == null ? row : Object.fromEntries(columns.split(",").map(key => key.trim()).filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
        return resolve({...result, data: head ? null : Array.isArray(result.data) ? result.data.map(project) : project(result.data)});
      }, reject);
      const value = target[name];
      return typeof value === "function" ? (...args) => { value.apply(target, args); return query; } : value;
    } });
    return query;
  } };
}
const routes = [
  ["members", "src/app/api/members/route.ts", body => assert.equal(body.members[0].player_name, "Public fixture")],
  ["dashboard", "src/app/api/dashboard/route.ts", body => assert.equal(body.recentEvents[0].player_name, "Public fixture")],
  ["events", "src/app/api/events/route.ts", body => assert.deepEqual(Object.keys(body.events[0]).sort(), ["event_time", "event_type", "id", "player_name", "player_tag"])],
  ["battles/feed", "src/app/api/battles/feed/route.ts", body => assert.equal(body.matches[0].clubPlayers[0].tag, "#A")],
  ["notifications", "src/app/api/notifications/route.ts", body => assert.equal(body.notifications[0].message, "Public fixture joined")],
  ["leaderboard", "src/app/api/leaderboard/route.ts", body => assert.equal(body.leaderboards.trophyLeaders[0].name, "Public fixture")],
  ["insights", "src/app/api/insights/route.ts", body => assert.equal(body.insights.totalBattlesThisWeek, 1)],
  ["reports/weekly", "src/app/api/reports/weekly/route.ts", body => assert.equal(body.recentEvents[0].player_name, "Public fixture")],
];
for (const [route, file, verifyPublicFields] of routes) test("public " + route + " response excludes legacy ownership fields", async () => {
  const selections = [];
  const {GET} = loadTypeScript(file, {
    "next/server": {NextResponse: {json: (body, init) => Response.json(body, init)}},
    "@/lib/supabase-admin": {supabaseAdmin: projectedDatabase(selections)},
    "@/lib/admin-auth": {rejectUnauthorizedAdminMutation: () => null},
    "@/lib/member-activity-metrics": {appendMemberActivityMetrics: async rows => rows.map(row => ({...row, activity_status:"active", trophies_24h:8, trophies_3d:8, trophies_7d:8, last_battle_at:timestamp}))},
  }, {Date:FixedDate});
  const url = "http://fixture/api/" + route;
  const response = await GET(Object.assign(new Request(url), {nextUrl:new URL(url)}));
  assert.equal(response.status, 200);
  if (route === "members") {
    const { members } = await response.clone().json();
    assert.equal(members[0].rank_current, "Diamond I");
    assert.equal(Object.hasOwn(members[0], "ranked_provenance"), false);
    assert.equal(Object.hasOwn(members[0], "ranked_points"), false);
  }
  const body = await response.json();
  assert.doesNotMatch(JSON.stringify(body), /owner_user_id|private-owner-fixture-identifier/);
  verifyPublicFields(body);
  assert.ok(selections.every(selection => selection.head || selection.columns !== "*"), "Public data queries must use explicit column selections");
});
