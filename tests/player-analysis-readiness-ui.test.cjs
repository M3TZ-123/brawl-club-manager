const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, i18n, componentMocks, elements, textContent, action } = require("./helpers/client-renderer.cjs");

function target() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) { for (const callback of [...listeners.get(event.type) || []]) callback(event); },
  };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness(path, response, { name = "default", props = {}, query = "", locale = i18n } = {}) {
  const renderer = hookRenderer(), requests = [];
  const window = target(), document = { ...target(), visibilityState: "visible" };
  const loaded = loadTypeScript(path, {
    ...componentMocks, react: { ...renderer.react, Suspense: "Suspense" },
    "next/navigation": { useSearchParams: () => new URLSearchParams(query) },
    "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
    "@/components/locale-provider": { useI18n: () => locale, LocalDate: "LocalDate", T: "T" },
    "@/lib/client-data-cache": { fetchJsonCached: async (url, options) => {
      const params = new URL(url, "http://fixture").searchParams; requests.push({ url, params, options });
      return typeof response === "function" ? response(params, url) : response;
    } },
  }, { window, document });
  const component = loaded[name] || elements(loaded.default()).find(node => node.type?.name === name)?.type;
  assert.ok(component, `Missing component ${name}`);
  return { loaded, requests, window, document, render: () => renderer.render(() => component(props)) };
}
const control = (tree, id) => { const result = elements(tree).find(node => node.props?.id === id); assert.ok(result, `Missing control ${id}`); return result; };
const stats = values => ({ observations: 0, wins: 0, losses: 0, draws: 0, unknownResults: 0, winRate: null, durationObservations: 0, recordedDurationSeconds: 0, averageDurationSeconds: null, ...values });
function analysis(values = {}) {
  return {
    period: { key: "7d", days: 7, start: "2026-09-09T12:00:00Z", end: "2026-09-16T12:00:00Z", aggregation: "rolling" }, filters: {}, summary: stats(),
    modes: [], maps: [], brawlers: [], pairs: [], hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, ...stats() })),
    facets: { contexts: [], modes: [{ key: "brawlHockey", label: "Brawl Hockey", count: 0 }], maps: [{ key: "Map One", count: 0 }], brawlers: [{ key: "SHELLY", count: 0 }] },
    coverage: { status: "unknown", currentPlayers: 30, fullPeriodMonitoredPlayers: 0, stalePlayers: 2, affectedPlayers: 0, retainedGapWindowDays: 28, truncated: false },
    limits: { groupCounts: { modes: 0, maps: 0, brawlers: 0, pairs: 0 }, truncated: false }, ...values,
  };
}
const equipment = { gadgets: null, starPowers: [], gears: [{ id: 62000000, name: null }], hyperCharges: [], buffies: { gadget: null, starPower: false, hyperCharge: true }, fieldCheckedAt: {} };
function row(id = 16000000, tag = "#ONE") { return { player: { tag, name: tag }, brawler: { id, name: `Brawler ${id}` }, powerLevel: null, trophies: 0, highestTrophies: null, prestigeLevel: null, currentWinStreak: 0, maxWinStreak: null, observedAt: "2026-09-16T10:00:00Z", ...equipment }; }
function readiness(values = {}) { return { rows: [row()], members: [{ tag: "#ONE", brawlersObserved: 1 }], brawlers: [{ id: 16000000, name: "SHELLY", playersObserved: 1 }], total: 1, nextOffset: null, ...values }; }
function brawler(id = 16000000) { return { id, name: `Brawler ${id}`, power: 11, trophies: 0, rank: 1, highestTrophies: null, prestigeLevel: 0, currentWinStreak: 0, maxWinStreak: null, skin: null, lastCheckedAt: "2026-09-16T10:00:00Z", ...equipment }; }
function progress(values = {}) { return {
  playerTag: "#ONE", period: { key: "7d", days: 7 },
  profile: { highestTrophies: null, expPoints: 0, totalPrestigeLevel: null, fame: 0, fameTierName: null, lastCheckedAt: null, fieldCheckedAt: {} },
  collection: { items: [brawler()], total: 1, nextCursor: null, lastCheckedAt: "2026-09-16T12:00:00Z" },
  rankedHistory: { items: [], nextCursor: null, coverageStart: null, coverageEnd: null, retention: { detailedDays: 7, dailyDays: 90, olderAggregation: "latest_per_utc_day_and_season" } },
  brawlerHistory: { brawlerId: null, items: [], coverageStart: null, coverageEnd: null }, ...values,
}; }

test("analysis initializes game map/mode links and ignores responses from an older period", async () => {
  const old = deferred();
  const page = harness("src/app/analysis/page.tsx", params => params.get("range") === "7d" ? old.promise : analysis({ summary: stats({ observations: 30 }) }), { name: "AnalysisContent", query: "map=Map%20One&mode=airHockey" });
  let tree = await page.render();
  assert.equal(page.requests[0].params.get("map"), "Map One");
  assert.equal(page.requests[0].params.get("mode"), "brawlHockey");
  assert.match(textContent(tree), /Loading battle analysis/);
  elements(tree).find(node => node.type === "TimeRangePicker").props.onChange("30d");
  tree = await page.render();
  assert.equal(page.requests.at(-1).params.get("range"), "30d");
  assert.match(textContent(tree), /Member participations30/);
  old.resolve(analysis({ summary: stats({ observations: 999 }) }));
  tree = await page.render();
  assert.doesNotMatch(textContent(tree), /999/);
  assert.match(textContent(tree), /Member participations30/);
});

test("analysis sends independent filters, shows null statistics honestly, and refreshes only relevant visible data", async () => {
  const page = harness("src/app/analysis/page.tsx", analysis(), { name: "AnalysisContent" });
  let tree = await page.render();
  assert.match(textContent(tree), /Decided-result win rateUnknown/);
  assert.match(textContent(tree), /Recorded match durationUnknown/);
  assert.match(textContent(tree), /Average recorded duration.*Unknown/);
  assert.match(textContent(tree), /not time online/);
  for (const [id, value] of [["analysis-context", "ranked"], ["analysis-mode", "brawlHockey"], ["analysis-map", "Map One"], ["analysis-brawler", "SHELLY"]]) {
    control(tree, id).props.onChange({ target: { value } }); tree = await page.render();
  }
  const params = page.requests.at(-1).params;
  assert.equal(params.get("context"), "ranked"); assert.equal(params.get("mode"), "brawlHockey");
  assert.equal(params.get("map"), "Map One"); assert.equal(params.get("brawler"), "SHELLY");
  const before = page.requests.length;
  page.window.dispatchEvent({ type: "club-data-updated", detail: { datasets: ["ranked"] } });
  await page.render(); assert.equal(page.requests.length, before);
  page.document.visibilityState = "hidden";
  page.window.dispatchEvent({ type: "club-data-updated", detail: { datasets: ["battles"] } });
  await page.render(); assert.equal(page.requests.length, before);
  page.document.visibilityState = "visible"; page.document.dispatchEvent({ type: "visibilitychange" });
  await page.render(); assert.equal(page.requests.length, before + 1); assert.equal(page.requests.at(-1).options.force, true);
});

test("analysis keeps teammate counts separate from participations and preserves coverage/limit caveats", async () => {
  const page = harness("src/app/analysis/page.tsx", analysis({
    summary: stats({ observations: 6, wins: 4, losses: 2, winRate: 66.666 }),
    pairs: [{ player1: { tag: "#ONE", name: "One" }, player2: { tag: "#TWO", name: "Two" }, context: { key: "ladder", label: "Trophy matches" }, matches: 2, wins: 1, losses: 1, draws: 0, unknownResults: 0, winRate: 50 }],
    coverage: { status: "possible_gap", currentPlayers: 30, fullPeriodMonitoredPlayers: 2, stalePlayers: 1, affectedPlayers: 3, retainedGapWindowDays: 28, truncated: true },
    limits: { truncated: true, groupCounts: { pairs: 300, maps: 0, modes: 0, brawlers: 0 } },
  }), { name: "AnalysisContent" });
  let tree = await page.render();
  assert.match(textContent(tree), /Possible gaps in battle history/); assert.match(textContent(tree), /exceeds the analysis limit/);
  action(tree, "Teammates")(); tree = await page.render();
  assert.match(textContent(tree), /2 shared matches/); assert.match(textContent(tree), /do not prove a premade party/);
  assert.match(textContent(tree), /Showing 1 of 300 groups/);
  assert.equal(elements(tree).filter(node => node.type === "Link").length, 2);
});

test("readiness filters are current snapshots, pagination preserves filters and deduplicates player-brawler rows", async () => {
  const page = harness("src/app/readiness/page.tsx", params => params.has("offset") ? readiness({ rows: [row(), row(16000001)], nextOffset: null, total: 2 }) : readiness({ nextOffset: 24, total: 2 }));
  let tree = await page.render();
  assert.match(textContent(tree), /Power Unknown/); assert.match(textContent(tree), /Official highest trophiesUnknown/);
  assert.match(textContent(tree), /Latest saved profiles, not a historical period/);
  control(tree, "readiness-power").props.onChange({ target: { value: "9" } }); tree = await page.render();
  control(tree, "readiness-brawler").props.onChange({ target: { value: "16000000" } }); tree = await page.render();
  control(tree, "readiness-search").props.onChange({ target: { value: "One" } }); tree = await page.render();
  elements(tree).find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); tree = await page.render();
  await action(tree, "Load more results")(); tree = await page.render();
  const last = page.requests.at(-1).params;
  assert.equal(last.get("offset"), "24"); assert.equal(last.get("brawler"), "16000000");
  assert.equal(last.get("minPower"), "9"); assert.equal(last.get("search"), "One"); assert.equal(last.get("range"), null);
  assert.equal(elements(tree).filter(node => node.type === "Card").length, 2);
  assert.equal(elements(tree).filter(node => node.props?.onClick && textContent(node) === "Load more results").length, 0);
});

test("readiness discards an in-flight old page when a filter changes", async () => {
  const next = deferred();
  const page = harness("src/app/readiness/page.tsx", params => params.has("offset") ? next.promise : readiness({ rows: [row(params.get("minPower") ? 16000011 : 16000000)], nextOffset: 24 }));
  let tree = await page.render();
  const pending = action(tree, "Load more results")();
  control(tree, "readiness-power").props.onChange({ target: { value: "11" } }); tree = await page.render();
  next.resolve(readiness({ rows: [row(999)], nextOffset: null })); await pending; tree = await page.render();
  assert.match(textContent(tree), /Brawler 16000011/); assert.doesNotMatch(textContent(tree), /Brawler 999/);
});

test("reported equipment distinguishes missing, explicit empty, numeric IDs and partial Buffies", () => {
  const loaded = loadTypeScript("src/components/reported-equipment.tsx", componentMocks);
  assert.match(textContent(loaded.EquipmentList({ label: "Reported gadgets", items: null })), /Not reported/);
  assert.match(textContent(loaded.EquipmentList({ label: "Reported gadgets", items: [] })), /None reported/);
  const item = loaded.EquipmentList({ label: "Reported gears", items: [{ id: 62000000, name: null, level: 0 }] });
  assert.match(textContent(item), /Unnamed item.*62000000.*Level 0/);
  assert.equal(elements(item).find(node => node.type === "bdi").props.dir, "ltr");
  const details = loaded.ReportedEquipmentDetails(equipment);
  assert.match(textContent(details), /do not confirm ownership or usability/);
  const terms = elements(details).filter(node => node.type === "dd").map(textContent);
  assert.deepEqual(terms, ["Not reported", "No", "Yes"]);
});

test("player collection shows explicit unknown highest, preserves reported zero, and fetches selected UTC history", async () => {
  const page = harness("src/components/player-progress.tsx", params => progress(params.has("brawlerId") ? {
    brawlerHistory: { brawlerId: 16000000, items: [{ recordedAt: "2026-09-15", trophies: 0, power: 11, rank: 1 }], coverageStart: "2026-09-15", coverageEnd: "2026-09-15" },
  } : {}), { name: "PlayerProgress", props: { playerTag: "#ONE", range: "7d" } });
  let tree = await page.render();
  assert.match(textContent(tree), /Official highest trophiesUnknown/); assert.match(textContent(tree), /Fame0/);
  assert.match(textContent(tree), /No ranked changes recorded.*does not mean/);
  assert.match(textContent(tree), /in detail for 7 days.*last observation per UTC day and season/);
  const choose = elements(tree).find(node => node.type === "button" && textContent(node).startsWith("Brawler 16000000"));
  assert.ok(choose); choose.props.onClick(); tree = await page.render();
  assert.equal(page.requests.at(-1).params.get("brawlerId"), "16000000");
  assert.equal(page.requests.at(-1).params.get("collectionLimit"), "1");
  assert.equal(page.requests.at(-1).params.get("collectionSearch"), "16000000");
  assert.match(textContent(tree), /Missing dates are not filled in/);
  const dates = elements(tree).filter(node => node.type === "LocalDate" && node.props.value === "2026-09-15");
  assert.ok(dates.length >= 1); assert.ok(dates.every(node => node.props.utc));
});

test("player collection cursor pages keep server search and do not replace ranked history", async () => {
  const rank = { id: "rank-one", seasonId: 42, observedAt: "2026-09-16T10:00:00Z", kind: "initial", currentRank: null, points: 0, seasonBest: null, seasonBestPoints: null, allTimeBest: null, allTimeBestPoints: null };
  const page = harness("src/components/player-progress.tsx", params => progress(params.has("collectionCursor") ? {
    collection: { items: [brawler(), brawler(16000001)], total: 2, nextCursor: null },
  } : { collection: { items: [brawler()], total: 2, nextCursor: 16000000 }, rankedHistory: { items: [rank], nextCursor: null, coverageStart: rank.observedAt, coverageEnd: rank.observedAt } }), { name: "PlayerProgress", props: { playerTag: "#ONE", range: "30d" } });
  let tree = await page.render();
  elements(tree).find(node => node.type === "details" && textContent(node).startsWith("Brawler collection")).props.onToggle({ currentTarget: { open: true } }); tree = await page.render();
  control(tree, "collection-search").props.onChange({ target: { value: "Brawler" } }); tree = await page.render();
  elements(tree).find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); tree = await page.render();
  await action(tree, "Load more brawlers")(); tree = await page.render();
  const last = page.requests.at(-1).params;
  assert.equal(last.get("collectionCursor"), "16000000"); assert.equal(last.get("collectionSearch"), "Brawler");
  assert.equal(last.get("range"), "30d"); assert.equal(last.get("rankLimit"), "1");
  assert.match(textContent(tree), /Season 42/); assert.match(textContent(tree), /Ranked points.*0/);
  assert.equal(elements(tree).find(node => node.type === "details" && textContent(node).startsWith("Brawler collection")).props.open, true);
  assert.equal(elements(tree).filter(node => node.type === "button" && textContent(node).startsWith("Brawler 1600000")).length, 2);
});

test("equipment keeps field observation dates for both readiness snake_case and player camelCase contracts", () => {
  const loaded = loadTypeScript("src/components/reported-equipment.tsx", componentMocks);
  for (const fields of [{ star_powers: "2026-09-14", hyper_charges: "2026-09-15" }, { starPowers: "2026-09-14", hyperCharges: "2026-09-15" }]) {
    const tree = loaded.ReportedEquipmentDetails({ ...equipment, fieldCheckedAt: fields });
    const lists = elements(tree).filter(node => node.type === loaded.EquipmentList);
    assert.equal(lists.find(node => node.props.label === "Reported star powers").props.checkedAt, "2026-09-14");
    assert.equal(lists.find(node => node.props.label === "Reported hypercharges").props.checkedAt, "2026-09-15");
  }
});

test("rank history cursor continuation preserves the full collection and distinct seasons", async () => {
  const rank = (id, seasonId) => ({ id, seasonId, observedAt: "2026-09-16T10:00:00Z", kind: "change", currentRank: "Gold I", points: 0, seasonBest: null, seasonBestPoints: null, allTimeBest: null, allTimeBestPoints: null });
  const page = harness("src/components/player-progress.tsx", params => progress(params.has("rankCursor") ? {
    rankedHistory: { items: [rank("99", 41)], nextCursor: null, coverageStart: "2026-09-01", coverageEnd: "2026-09-16" },
  } : { collection: { items: [brawler(), brawler(16000001)], total: 2, nextCursor: null }, rankedHistory: { items: [rank("100", 42)], nextCursor: "MTAw", coverageStart: "2026-09-01", coverageEnd: "2026-09-16" } }), { name: "PlayerProgress", props: { playerTag: "#ONE", range: "90d" } });
  let tree = await page.render(); await action(tree, "Load more ranked history")(); tree = await page.render();
  assert.equal(page.requests.at(-1).params.get("rankCursor"), "MTAw"); assert.equal(page.requests.at(-1).params.get("collectionLimit"), "1");
  assert.equal(page.requests.at(-1).params.get("range"), "90d");
  assert.match(textContent(tree), /Season 42/); assert.match(textContent(tree), /Season 41/);
  assert.equal(elements(tree).filter(node => node.type === "button" && textContent(node).startsWith("Brawler 1600000")).length, 2);
});

test("rank history keeps unknown seasons distinct and Arabic UI places the brawler sheet on the left", async () => {
  const page = harness("src/components/player-progress.tsx", progress(), { name: "PlayerProgress", props: { playerTag: "#ONE", range: "7d" }, locale: { ...i18n, direction: "rtl", locale: "ar" } });
  const groups = page.loaded.rankHistorySeasons([{ id: "a", seasonId: 5 }, { id: "b", seasonId: null }, { id: "c", seasonId: 5 }, { id: "d", seasonId: 4 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(([season, items]) => [season, items.map(item => item.id)]))), [[5, ["a", "c"]], [null, ["b"]], [4, ["d"]]]);
  const tree = await page.render(); assert.equal(elements(tree).find(node => node.type === "SheetContent").props.side, "left");
  const { translate } = loadTypeScript("src/lib/i18n/messages.ts");
  for (const key of ["Battle analysis", "Brawler readiness", "Player progress and collection", "Reported hypercharges", "No confirmed teammate pairs in these records."]) assert.notEqual(translate(key, "ar"), key);
});
