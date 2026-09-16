const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, windowMock, elements, textContent } = require("./helpers/client-renderer.cjs");

const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const summary = count => ({ summary: { totalMembers: count, totalTrophies: 100, activeMembers: count, avgTrophies: 100 }, topMembers: [], topGainers: [], attentionMembers: [], recentEvents: [], changeSummary: { joins: 0, leaves: 0, nameChanges: 0, roleChanges: 0 } });
const insights = () => ({ insights: { megaBoss: { isTracked: false }, winRate: 50, totalWins: 1, totalBattlesThisWeek: 2, thisWeekTotal: 2, prevWeekTotal: 0, trendDiff: 0 }, period: { start: "2026-09-10T00:00:00Z", end: "2026-09-16T10:00:00Z" } });
const picker = tree => elements(tree).find(element => element.type === "TimeRangePicker");
const stats = tree => elements(tree).find(element => element.type === "StatsCards");

function fixture(fetchJsonCached) {
  const renderer = hookRenderer();
  const page = loadTypeScript("src/app/page.tsx", {
    ...componentMocks, react: renderer.react,
    "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
    "@/components/setup-wizard": { SetupWizard: "SetupWizard" },
    "@/lib/store": { useAppStore: () => ({ clubTag: "#ABC", apiKeyConfigured: true, lastSyncTime: "2026-09-16T10:00:00Z", hasLoadedSettings: true, isLoadingSettings: false, loadSettingsFromDB() {} }) },
    "@/lib/client-data-cache": { fetchJsonCached },
  }, { window: windowMock }).default;
  return () => renderer.render(page);
}

test("clicking the dashboard's selected period leaves its loaded content visible", async () => {
  const urls = [];
  const render = fixture(async url => { urls.push(url); return url.startsWith("/api/dashboard") ? summary(7) : insights(); });
  let tree = await render();
  assert.equal(stats(tree).props.totalMembers, 7);
  assert.equal(picker(tree).props.value, "7d");
  picker(tree).props.onChange("7d");
  tree = await render();
  assert.equal(stats(tree).props.totalMembers, 7);
  assert.equal(urls.length, 2, "Clicking the selected button must not clear data or trigger another request");
  assert.match(textContent(tree), /2026-09-10T00:00:00Z.*2026-09-16T10:00:00Z/);
});

test("dashboard period races cannot put an older response beneath the newest period", async () => {
  const older = pending(), newer = pending();
  const render = fixture(async url => {
    const range = new URL(url, "http://fixture").searchParams.get("range");
    if (!url.startsWith("/api/dashboard")) return insights();
    if (range === "30d") return older.promise;
    if (range === "90d") return newer.promise;
    return summary(7);
  });
  let tree = await render();
  picker(tree).props.onChange("30d");
  tree = await render();
  assert.equal(stats(tree), undefined, "Old content is hidden immediately during the new range request");
  picker(tree).props.onChange("90d");
  await render();
  newer.resolve(summary(90));
  tree = await render();
  assert.equal(stats(tree).props.totalMembers, 90);
  older.resolve(summary(30));
  tree = await render();
  assert.equal(picker(tree).props.value, "90d");
  assert.equal(stats(tree).props.totalMembers, 90);
});
