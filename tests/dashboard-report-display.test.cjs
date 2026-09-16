const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, windowMock, elements, textContent, action } = require("./helpers/client-renderer.cjs");

const mocks = {
  ...componentMocks,
  "next/dynamic": () => "Dynamic",
  "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
  "@/components/ui/tabs": Object.fromEntries(["Tabs", "TabsContent", "TabsList", "TabsTrigger"].map(name => [name, name])),
  "@/components/ui/table": Object.fromEntries(["Table", "TableBody", "TableCell", "TableHead", "TableHeader", "TableRow"].map(name => [name, name])),
};
const { translate } = loadTypeScript("src/lib/i18n/messages.ts");
const member = {
  tag: "#ONE", name: "One", role: "member", trophies: 1000, highestTrophies: 1100,
  brawlersCount: 10, activityStatus: "active", lastBattleAt: "2026-09-16T09:00:00Z",
  weekly: { battles: 10, wins: 2, losses: 3, starPlayer: 1, activeDays: 3, winRate: 20, netTrophies: 10 },
};
const boards = value => Object.fromEntries(["trophyLeaders", "weeklyBattlers", "weeklyWinRate", "weeklyTrophyGainers", "weeklyStarPlayers", "mostActive"].map(key => [key, value]));

function activityHarness(response) {
  const renderer = hookRenderer();
  let activeRenderer = renderer;
  const react = new Proxy({}, { get: (_, key) => key === "memo" ? component => component : (...args) => activeRenderer.react[key](...args) });
  const component = loadTypeScript("src/app/activity/page.tsx", {
    ...mocks, react,
    "@/lib/client-data-cache": { fetchJsonCached: async () => response },
  }, { window: windowMock }).default;
  return {
    render() { activeRenderer = renderer; return renderer.render(component); },
    async renderChild(element) { activeRenderer = hookRenderer(); return activeRenderer.render(() => element.type(element.props)); },
  };
}
const podium = (tree, key) => elements(elements(tree).find(element => element.type === "TabsContent" && element.props.value === key))
  .find(element => element.type?.name === "Podium");

test("leaderboard never invents draws from results that are neither an explicit win nor loss", async () => {
  const harness = activityHarness({ leaderboards: boards([member]), memberCount: 1 });
  const tree = await harness.render();
  const subtitle = podium(tree, "weeklyBattlers").props.subtitle;
  assert.equal(subtitle(member), "2 wins · 3 losses · 5 other results");
  assert.doesNotMatch(subtitle(member), /draws/);
  assert.equal(subtitle({ ...member, weekly: { ...member.weekly, battles: 5 } }), "2 wins · 3 losses");
});

test("leaderboard empty filters offer a filter explanation, and Reset restores the existing members", async () => {
  const harness = activityHarness({ leaderboards: boards([member]), memberCount: 1 });
  let tree = await harness.render();
  const search = elements(tree).find(element => element.type === "input" && element.props.placeholder === "Search player or tag");
  search.props.onChange({ target: { value: "not a member" } });
  tree = await harness.render();
  const empty = await harness.renderChild(podium(tree, "weeklyTrophyGainers"));
  assert.match(textContent(empty), /No members match these filters/);
  assert.doesNotMatch(textContent(empty), /Run Sync Now|No tracked data/);
  action(tree, "Reset")();
  tree = await harness.render();
  assert.equal(podium(tree, "weeklyTrophyGainers").props.members.length, 1);
});

test("leaderboard separates an empty recorded period from filters that hide loaded members", async () => {
  const harness = activityHarness({ leaderboards: boards([]), memberCount: 1 });
  const tree = await harness.render();
  const empty = await harness.renderChild(podium(tree, "weeklyBattlers"));
  assert.match(textContent(empty), /No recorded results for this period/);
  assert.doesNotMatch(textContent(empty), /No members match|Run Sync Now/);
});

const eventLabels = { join: "Joined", leave: "Left", promotion: "Promoted", demotion: "Demoted", name_change: "Name Changed", role_change: "Role Changed", future_event: "Club event" };
const events = Object.keys(eventLabels).map((event_type, id) => ({ id, event_type, player_name: `Player ${event_type}`, player_tag: `#${id}`, event_time: "2026-09-16T09:00:00Z" }));

test("reports identify joins, leaves, name changes and role changes without claiming departures", async () => {
  const renderer = hookRenderer();
  const component = loadTypeScript("src/app/reports/page.tsx", {
    ...mocks, react: renderer.react,
    "@/lib/client-data-cache": { fetchJsonCached: async () => ({
      generatedAt: "2026-09-16T10:00:00Z", period: { start: "2026-09-10", end: "2026-09-16" },
      summary: { totalMembers: 1, totalTrophies: 1000, avgTrophies: 1000, activeMembers: 1, activityRate: 100, weeklyWins: 2, weeklyBattles: 10, weeklyWinRate: 20 },
      topGainers: [], topLosers: [], activityDistribution: { active: 1, minimal: 0, inactive: 0 },
      trophyTrend: [], recentEvents: events,
    }) },
  }, { window: windowMock }).default;
  const tree = await renderer.render(component);
  assert.match(textContent(tree), /Club changes/);
  const rows = elements(tree).filter(element => element.type === "div" && element.props.className?.includes("bg-muted/50"));
  assert.equal(rows.length, events.length);
  for (const [index, event] of events.entries()) {
    assert.ok(textContent(rows[index]).includes(eventLabels[event.event_type]), `Wrong label for ${event.event_type}: ${textContent(rows[index])}`);
    if (event.event_type !== "leave") assert.doesNotMatch(textContent(rows[index]), /Left/);
  }
});

test("dashboard timeline labels common name and role changes through the Arabic dictionary", () => {
  const { ActivityTimeline } = loadTypeScript("src/components/activity-timeline.tsx", { ...mocks, react: { memo: component => component } });
  const tree = ActivityTimeline({ events });
  const badges = elements(tree).filter(element => element.type === "Badge");
  for (const [index, event] of events.entries()) {
    assert.equal(textContent(badges[index]), eventLabels[event.event_type]);
  }
  assert.equal(translate(textContent(badges[4]), "ar"), "تغيير اسم");
  assert.equal(translate(textContent(badges[5]), "ar"), "تغيير رتبة");
});
