const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, windowMock, elements, textContent, action } = require("./helpers/client-renderer.cjs");

const mocks = {
  ...componentMocks,
  "next/dynamic": () => "Dynamic",
  "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
  "@/components/membership-timeline": { MembershipTimeline: "MembershipTimeline" },
  "@/components/history-member-card": { HistoryMemberCard: "HistoryMemberCard" },
  "@/components/ui/table": Object.fromEntries(["Table", "TableBody", "TableCell", "TableHead", "TableHeader", "TableRow"].map(name => [name, name])),
  "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: false }) },
};
const quietConsole = { ...console, error() {} };
const picker = tree => elements(tree).find(element => element.type === "TimeRangePicker");
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const json = value => JSON.parse(JSON.stringify(value));

test("period picker offers five consistent periods and All only for an explicit history consumer", async () => {
  const renderer = hookRenderer();
  const { TimeRangePicker } = loadTypeScript("src/components/time-range-picker.tsx", { ...componentMocks, react: renderer.react });
  const changes = [];
  let props = { value: "7d", onChange: range => changes.push(range) };
  let tree = await renderer.render(() => TimeRangePicker(props));
  assert.equal(elements(tree).filter(element => element.type === "Button").length, 5);
  assert.equal(elements(tree).filter(element => element.props?.["aria-pressed"] === true).length, 1);
  await action(tree, "3 months")();
  assert.deepEqual(changes, ["90d"]);
  props = { ...props, value: "all", includeAll: true };
  tree = await renderer.render(() => TimeRangePicker(props));
  assert.doesNotMatch(textContent(tree), /Last 7 days/);
  await action(tree, "All Time")();
  assert.deepEqual(changes, ["90d", "all"]);
  props = { ...props, value: "24h", includeAll: false, dayBased: true };
  tree = await renderer.render(() => TimeRangePicker(props));
  assert.match(textContent(tree), /Today \(UTC\)/);
});

test("trophy charts retain real timestamps and null gaps without inventing a starting balance", async () => {
  const renderer = hookRenderer();
  const chartModule = loadTypeScript("src/components/period-trophy-chart.tsx", {
    ...componentMocks, react: renderer.react,
    recharts: Object.fromEntries(["CartesianGrid", "Line", "LineChart", "ResponsiveContainer", "Tooltip", "XAxis", "YAxis"].map(name => [name, name])),
  });
  const observations = [
    { recordedAt: "2026-09-16T09:13:41Z", trophies: 120 },
    { recordedAt: "2026-09-15T08:06:25Z", trophies: null },
    { recordedAt: "2026-09-14T07:04:11Z", trophies: 100 },
  ];
  assert.deepEqual(json(chartModule.prepareTrophyObservations(observations)), [
    { timestamp: Date.parse(observations[2].recordedAt), trophies: 100 },
    { timestamp: Date.parse(observations[1].recordedAt), trophies: null },
    { timestamp: Date.parse(observations[0].recordedAt), trophies: 120 },
  ]);
  let tree = await renderer.render(() => chartModule.PeriodTrophyChart({ points: observations }));
  assert.equal(elements(tree).find(element => element.type === "Line").props.connectNulls, false);
  assert.equal(elements(tree).find(element => element.type === "LineChart").props.data.length, 3);
  tree = await renderer.render(() => chartModule.PeriodTrophyChart({ points: [{ recordedAt: observations[0].recordedAt, trophies: null }] }));
  assert.match(textContent(tree), /Not enough history/);
  assert.equal(elements(tree).some(element => element.type === "LineChart"), false);
  const sparse = chartModule.prepareTrophyObservations([
    { recordedAt: "2026-09-14T23:59:00Z", trophies: 100 },
    { recordedAt: "2026-09-15T00:01:00Z", trophies: 101 },
    { recordedAt: "2026-09-17T12:34:56Z", trophies: 120 },
  ], 86_400_000);
  assert.deepEqual(json(sparse), [
    { timestamp: Date.parse("2026-09-14T23:59:00Z"), trophies: 100 },
    { timestamp: Date.parse("2026-09-15T00:01:00Z"), trophies: 101 },
    { timestamp: Date.parse("2026-09-16T00:00:00Z"), trophies: null },
    { timestamp: Date.parse("2026-09-17T12:34:56Z"), trophies: 120 },
  ], "Only a missing sampling bucket inserts a null separator; actual observations keep their timestamps");
});

test("member overview distinguishes insufficient trophy history and no recorded battles from zero performance", async () => {
  const renderer = hookRenderer();
  const { MemberPeriodOverview } = loadTypeScript("src/components/member-period-overview.tsx", {
    ...mocks, react: renderer.react,
    "@/components/period-trophy-chart": { PeriodTrophyChart: "PeriodTrophyChart" },
  });
  const tree = await renderer.render(() => MemberPeriodOverview({ range: "90d", trophyChange: null, observations: [],
    stats: { battles: 0, wins: 0, losses: 0, winRate: 0, activeDays: 0 },
    period: { start: "2026-06-19", end: "2026-09-16" },
  }));
  assert.match(textContent(tree), /Not enough history for this period/);
  assert.match(textContent(tree), /2026-06-19.*2026-09-16.*UTC/);
  assert.doesNotMatch(textContent(tree), /0%|28 days|\/7/);
});

test("history defaults to all time and late responses cannot replace the selected period", async () => {
  const renderer = hookRenderer(), requests = [], initial = pending(), newest = pending();
  const component = loadTypeScript("src/app/history/page.tsx", {
    ...mocks, react: renderer.react,
    "@/lib/client-fetch": { fetchJsonWithTimeout: url => { requests.push(url); return url.includes("range=90d") ? newest.promise : initial.promise; } },
  }, { window: windowMock, console: quietConsole }).default;
  let tree = await renderer.render(component);
  assert.equal(requests[0], "/api/history?range=all");
  picker(tree).props.onChange("90d");
  await renderer.render(component);
  newest.resolve({ history: [{ player_tag: "#NEW", player_name: "Selected period", is_current_member: true, times_joined: null, times_left: null }] });
  tree = await renderer.render(component);
  assert.match(textContent(tree), /Selected period/);
  initial.resolve({ history: [{ player_tag: "#OLD", player_name: "Wrong period", is_current_member: true }] });
  tree = await renderer.render(component);
  assert.match(textContent(tree), /Selected period/);
  assert.doesNotMatch(textContent(tree), /Wrong period/);
  assert.equal(elements(tree).some(element => element.type === "TableHead" && textContent(element) === "Notes"), false);
  assert.equal(elements(tree).some(element => element.type === "TableHead" && textContent(element) === "Latest recorded event"), true);
});

test("history load failures show a retry rather than an empty history or zero member counts", async () => {
  const renderer = hookRenderer();
  const component = loadTypeScript("src/app/history/page.tsx", {
    ...mocks, react: renderer.react,
    "@/lib/client-fetch": { fetchJsonWithTimeout: async () => { throw Error("offline"); } },
  }, { window: windowMock, console: quietConsole }).default;
  const tree = await renderer.render(component);
  assert.match(textContent(tree), /Could not load member history/);
  assert.doesNotMatch(textContent(tree), /No member history found/);
  assert.ok(action(tree, "Retry"));
});

test("notification period switches ignore earlier responses and hide capacity filters from visitors", async () => {
  const renderer = hookRenderer(), requests = [], initial = pending(), newest = pending();
  const component = loadTypeScript("src/app/notifications/page.tsx", {
    ...mocks, react: renderer.react,
    "@/lib/client-data-cache": { fetchJsonCached: url => { requests.push(url); return url.includes("range=3d") ? newest.promise : initial.promise; } },
  }, { window: windowMock, console: quietConsole }).default;
  let tree = await renderer.render(component);
  assert.equal(new URL(requests[0], "http://fixture").searchParams.get("range"), "7d");
  assert.equal(elements(tree).some(element => element.type === "option" && element.props.value === "capacity"), false);
  picker(tree).props.onChange("3d");
  await renderer.render(component);
  newest.resolve({ notifications: [{ id: 2, title: "New period", message: "Current", created_at: "2026-09-16T00:00:00Z", is_read: true }], unreadCount: 0 });
  await renderer.render(component);
  initial.resolve({ notifications: [{ id: 1, title: "Old period", message: "Wrong", created_at: "2026-09-16T00:00:00Z", is_read: false }], unreadCount: 2 });
  tree = await renderer.render(component);
  assert.match(textContent(tree), /New period/);
  assert.doesNotMatch(textContent(tree), /Old period/);
});

test("failed notification loads do not claim all notifications are read", async () => {
  const renderer = hookRenderer();
  const component = loadTypeScript("src/app/notifications/page.tsx", {
    ...mocks, react: renderer.react,
    "@/lib/client-data-cache": { fetchJsonCached: async () => { throw Error("offline"); } },
  }, { window: windowMock, console: quietConsole }).default;
  const tree = await renderer.render(component);
  assert.match(textContent(tree), /Could not load notifications/);
  assert.doesNotMatch(textContent(tree), /No unread notifications|All caught up|No notifications found/);
});

const detailFixture = {
  member: { player_tag: "#ABC", player_name: "Member", trophies: 1000, highest_trophies: 1010, role: "member", activity_status: "active", trio_victories: 10, solo_victories: 3, duo_victories: 2, trophies_7d: null, trophies_90d: 50 },
  activityHistory: [{ recorded_at: "2026-09-16T12:34:56Z", trophies: 1000 }],
  memberHistory: { first_seen: null, times_joined: null, times_left: null },
  enhancedStats: { totalBattles: 30, totalWins: 20, totalLosses: 10, winRate: 66.7, activeDays: 3 },
};

test("member detail separates current account from period totals and passes its period into admin reviews", async () => {
  const renderer = hookRenderer(), requests = [];
  const component = loadTypeScript("src/app/members/[tag]/page.tsx", {
    ...mocks, react: { ...renderer.react, use: value => value },
    "@/lib/client-data-cache": { fetchJsonCached: async url => { requests.push(url); return detailFixture; } },
  }, { window: windowMock, console: quietConsole }).default;
  const render = () => renderer.render(() => component({ params: { tag: "%23ABC" } }));
  let tree = await render();
  assert.equal(requests[0], "/api/members/%23ABC?range=7d");
  assert.match(textContent(tree), /Current account|Lifetime victories and current brawlers/);
  assert.doesNotMatch(textContent(tree), /Admin Only|Refresh Stats|Original Member|Since before tracking/);
  assert.equal(elements(tree).find(element => element.props?.observations)?.props.trophyChange, null);
  picker(tree).props.onChange("90d");
  tree = await render();
  assert.equal(requests.at(-1), "/api/members/%23ABC?range=90d");
  assert.equal(elements(tree).find(element => element.type === "MemberReviewButton").props.initialRange, "90d");
  const overview = elements(tree).find(element => element.props?.observations);
  assert.equal(overview.props.trophyChange, 50);
  assert.equal(overview.props.observations[0].recordedAt, "2026-09-16T12:34:56Z");
});

test("member load errors are recoverable and do not masquerade as a missing member", async () => {
  const renderer = hookRenderer();
  const component = loadTypeScript("src/app/members/[tag]/page.tsx", {
    ...mocks, react: { ...renderer.react, use: value => value },
    "@/lib/client-data-cache": { fetchJsonCached: async () => { throw Error("offline"); } },
  }, { window: windowMock, console: quietConsole }).default;
  const tree = await renderer.render(() => component({ params: { tag: "%23ABC" } }));
  assert.match(textContent(tree), /Could not load this member/);
  assert.doesNotMatch(textContent(tree), /Member not found/);
  assert.ok(action(tree, "Retry"));
});

test("background member updates keep the review sheet mounted while new data loads", async () => {
  const renderer = hookRenderer(), update = pending(), listeners = {};
  let calls = 0;
  const component = loadTypeScript("src/app/members/[tag]/page.tsx", {
    ...mocks, react: { ...renderer.react, use: value => value },
    "@/lib/client-data-cache": { fetchJsonCached: () => ++calls === 1 ? Promise.resolve(detailFixture) : update.promise },
  }, { window: { addEventListener(name, handler) { listeners[name] = handler; }, removeEventListener() {} }, console: quietConsole }).default;
  const render = () => renderer.render(() => component({ params: { tag: "%23ABC" } }));
  let tree = await render();
  assert.ok(elements(tree).some(element => element.type === "MemberReviewButton"));
  listeners["club-data-updated"]();
  tree = await render();
  assert.ok(elements(tree).some(element => element.type === "MemberReviewButton"), "An open review draft must not be unmounted by background loading");
  update.resolve(detailFixture);
  await render();
});

test("reports request the selected period and disable export when the report could not load", async () => {
  const renderer = hookRenderer(), urls = [];
  const component = loadTypeScript("src/app/reports/page.tsx", {
    ...mocks, react: renderer.react,
    "@/lib/client-data-cache": { fetchJsonCached: async url => { urls.push(url); throw Error("offline"); } },
  }, { window: windowMock, console: quietConsole }).default;
  let tree = await renderer.render(component);
  assert.equal(urls[0], "/api/reports/weekly?range=7d");
  assert.match(textContent(tree), /Could not load the report/);
  assert.equal(elements(tree).find(element => element.props?.["aria-label"] === "Export").props.disabled, true);
  picker(tree).props.onChange("30d");
  tree = await renderer.render(component);
  assert.equal(urls.at(-1), "/api/reports/weekly?range=30d");
  assert.equal(picker(tree).props.dayBased, true);
});

test("review queue stays admin gated and empty search results do not imply that reviews are complete", async () => {
  const renderer = hookRenderer(), requests = [], session = { isAdmin: false, isLoading: false };
  const component = loadTypeScript("src/app/reviews/page.tsx", { ...mocks, react: { ...renderer.react, Suspense: "Suspense" },
    "next/navigation": { useSearchParams: () => new URLSearchParams() },
    "@/hooks/use-admin-session": { useAdminSession: () => session },
  }, {
    window: windowMock, fetch: async url => {
      requests.push(url);
      if (url === "/api/member-reviews?include_history=1") return Response.json({ reviews: [], historySummaries: [] });
      if (url === "/api/members") return Response.json({ members: [{ player_tag: "#ABC", player_name: "Example member", activity_status: "inactive" }] });
      assert.equal(url, "/api/history?range=all"); return Response.json({ history: [] });
    },
  }).default;
  const shell = component();
  assert.equal(shell.props.children.type, "AdminGate");
  const queue = elements(shell).find(element => element.type?.name === "ReviewQueue").type;
  assert.equal(await renderer.render(queue), null);
  assert.equal(requests.length, 0, "Visitors must not request private reviews or history summaries");
  session.isAdmin = true;
  let tree = await renderer.render(queue);
  assert.match(textContent(tree), /Example member/);
  assert.ok(requests.includes("/api/member-reviews?include_history=1"));
  assert.doesNotMatch(textContent(tree), /Pending/);
  elements(tree).find(element => element.type === "Input").props.onChange({ target: { value: "missing member" } });
  tree = await renderer.render(queue);
  assert.match(textContent(tree), /No matching members/);
  assert.match(textContent(tree), /Try another search or membership filter/);
  assert.doesNotMatch(textContent(tree), /No review needed|All reviews complete/);
});
