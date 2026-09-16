const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, i18n, componentMocks, windowMock, elements, textContent, action } = require("./helpers/client-renderer.cjs");

const locale = { ...i18n, delta: value => value == null ? "—" : value > 0 ? `+${value}` : String(value) };
const mocks = {
  ...componentMocks,
  "@/components/locale-provider": { T: "T", useI18n: () => locale },
  "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
  "@/components/membership-timeline": { MembershipTimeline: "MembershipTimeline" },
  "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: false }) },
  "next/dynamic": () => "Dynamic",
};
const player = (tag, values = {}) => ({ tag, name: tag, brawler: "SHELLY", power: 11, result: "victory", trophy_change: 8, is_star_player: false, ...values });
const match = (values = {}) => ({ matchId: "match-1", battle_time: "2026-09-16T10:00:00Z", mode: "gemGrab", map: "Fixture map", clubPlayers: [player("#ONE")], ourTeam: null, theirTeam: null, ...values });
const select = (tree, label) => {
  const found = elements(tree).find(element => element.type === "select" && element.props["aria-label"] === label);
  assert.ok(found, `Missing labeled select ${label}`);
  return found;
};
const selectValues = element => elements(element).filter(child => child.type === "option").map(child => child.props.value);
const cards = tree => elements(tree).filter(element => element.type?.name === "MatchCard");

function feedHarness(response = {}) {
  const renderer = hookRenderer(), requests = [];
  const target = () => { const listeners = new Map(); return {
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) { for (const callback of [...listeners.get(event.type) || []]) callback(event); },
  }; };
  const window = target(), document = { ...target(), visibilityState: "visible" };
  let activeRenderer = renderer;
  const react = new Proxy({}, { get: (_, key) => (...args) => activeRenderer.react[key](...args) });
  const component = loadTypeScript("src/app/battle-feed/page.tsx", {
    ...mocks, react,
    "@/lib/supabase": { supabase: { channel() { assert.fail("Feed must share the status monitor's subscription"); } } },
    "@/lib/client-data-cache": { fetchJsonCached: async url => {
      assert.ok(url.startsWith("/api/battles/feed?"), `Unexpected request ${url}`);
      requests.push(new URL(url, "http://fixture").searchParams);
      return typeof response === "function" ? response(requests.at(-1)) : {
        matches: [match()], modes: ["gemGrab"], total: 1, nextOffset: null, ...response,
      };
    } },
  }, { window, document }).default;
  return {
    requests, window, document,
    render() { activeRenderer = renderer; return renderer.render(component); },
    mount(element) {
      const child = hookRenderer();
      return { render() { activeRenderer = child; return child.render(() => element.type(element.props)); } };
    },
  };
}

test("the feed uses one response for roster and battles, ignores rank-only updates, and defers hidden refreshes", async () => {
  const page = feedHarness({ members: [{ tag: "#ONE", name: "One" }] });
  await page.render(); assert.equal(page.requests.length, 1);
  page.window.dispatchEvent({ type: "club-data-updated", detail: { datasets: ["ranked"] } });
  await page.render(); assert.equal(page.requests.length, 1);
  page.window.dispatchEvent({ type: "club-data-updated", detail: { datasets: ["battles"] } });
  await page.render(); assert.equal(page.requests.length, 2);
  page.document.visibilityState = "hidden";
  for (let i = 0; i < 3; i++) page.window.dispatchEvent({ type: "club-data-updated", detail: { datasets: ["roster"] } });
  await page.render(); assert.equal(page.requests.length, 2);
  page.document.visibilityState = "visible"; page.document.dispatchEvent({ type: "visibilitychange" });
  await page.render(); assert.equal(page.requests.length, 3); assert.equal(page.requests.at(-1).get("offset"), "0");
});

test("desktop and mobile distinguish modes from battle types, retaining zero-count special events", async () => {
  const page = feedHarness({
    modes: ["airHockey", "brawlHockey", "deathmatch", "tagTeam", "newFutureMode"],
    contexts: [{ key: "unknown", label: "Unclassified", count: 9 }, { key: "mega_pig", label: "Mega Pig", count: 0 }],
  });
  const tree = await page.render();
  const modeSelects = elements(tree).filter(element => element.type === "select" && element.props["aria-label"] === "Game mode");
  const contextSelects = elements(tree).filter(element => element.type === "select" && element.props["aria-label"] === "Battle type / event");
  assert.equal(modeSelects.length, 2, "The desktop and mobile filter sheet use the same mode controls");
  assert.equal(contextSelects.length, 2);
  for (const control of modeSelects) {
    assert.deepEqual(selectValues(control).sort(), ["", "brawlHockey", "duels", "newFutureMode", "wipeout"].sort());
    assert.match(textContent(control), /Brawl Hockey/);
    assert.doesNotMatch(textContent(control), /Air Hockey|Deathmatch|Tag Team/);
  }
  for (const control of contextSelects) {
    assert.deepEqual(selectValues(control), ["", "ladder", "ranked", "challenge", "friendly", "mega_pig", "tournament", "unknown"]);
    assert.match(textContent(control), /Mega Pig \(0\)/);
    assert.match(textContent(control), /Unclassified \(9\)/);
  }
  assert.match(textContent(tree), /may be unclassified if the game does not identify its event/);
});

test("mode, context and period filters survive pagination and clear together", async () => {
  const page = feedHarness(params => ({
    matches: [match({ matchId: `match-${params.get("offset")}` })], modes: ["gemGrab"], total: 100,
    nextOffset: params.get("offset") === "0" ? 50 : null,
  }));
  let tree = await page.render();
  select(tree, "Game mode").props.onChange({ target: { value: "gemGrab" } });
  tree = await page.render();
  select(tree, "Battle type / event").props.onChange({ target: { value: "ranked" } });
  tree = await page.render();
  elements(tree).find(element => element.type === "TimeRangePicker").props.onChange("30d");
  tree = await page.render();
  await action(tree, "Load More")();
  tree = await page.render();
  const latest = page.requests.at(-1);
  assert.equal(latest.get("offset"), "50");
  assert.equal(latest.get("mode"), "gemGrab");
  assert.equal(latest.get("context"), "ranked");
  assert.equal(latest.get("range"), "30d");
  assert.equal(cards(tree).length, 2);
  elements(tree).find(element => element.props?.["aria-label"] === "Clear filters").props.onClick();
  tree = await page.render();
  assert.equal(page.requests.at(-1).has("mode"), false);
  assert.equal(page.requests.at(-1).has("context"), false);
  assert.equal(page.requests.at(-1).get("offset"), "0");
  assert.equal(select(tree, "Battle type / event").props.value, "");
});

test("empty event filters explain missing identification instead of claiming that the event never occurred", async () => {
  const page = feedHarness({ matches: [], total: 0 });
  let tree = await page.render();
  select(tree, "Battle type / event").props.onChange({ target: { value: "mega_pig" } });
  tree = await page.render();
  assert.match(textContent(tree), /No recorded battles match this battle type and period/);
  assert.match(textContent(tree), /may be unclassified.*Mega Pig, tournaments and older battles/);
});

test("unknown outcomes stay neutral and zero trophies differ from unreported trophies", async () => {
  for (const value of [0, null]) {
    const page = feedHarness({ matches: [match({ mode: "unknown", clubPlayers: [player("#ONE", { result: "unknown", trophy_change: value })] })] });
    const pageTree = await page.render();
    const mounted = page.mount(cards(pageTree)[0]);
    const tree = await mounted.render();
    assert.match(textContent(tree), /Unknown mode.*Unclassified.*Unknown result/);
    assert.doesNotMatch(textContent(tree), /Friendly|Draw|Ladder|Club Squad|Points N\/A/);
    assert.equal(textContent(elements(tree).find(element => element.props?.title === "Reported change")), value === 0 ? "0" : "—");
    const playerElement = elements(tree).find(element => element.type?.name === "PlayerRow");
    const row = await page.mount(playerElement).render();
    assert.equal(textContent(elements(row).find(element => element.props?.title === "Reported change")), value === 0 ? "0" : "—");
    assert.doesNotMatch(textContent(row), /Friendly|N\/A|±0/);
  }
});

test("explicit battle metadata selects type independently from mode and trophy changes", async () => {
  for (const [battle_type, label] of [["teamRanked", "Ranked"], ["ranked", "Trophy matches"], ["friendly", "Friendly"], [null, "Unclassified"]]) {
    const page = feedHarness({ matches: [match({ mode: "tagTeam", battle_type, clubPlayers: [player("#ONE", { trophy_change: 0 })] })] });
    const tree = await page.mount(cards(await page.render())[0]).render();
    assert.match(textContent(tree), /Duels/);
    assert.ok(elements(tree).some(element => element.type === "T" && element.props.text === label));
  }
  const page = feedHarness({ matches: [match({ context: { key: "ranked", label: "Ranked" }, battle_type: null })] });
  const tree = await page.mount(cards(await page.render())[0]).render();
  assert.ok(elements(tree).some(element => element.type === "T" && element.props.text === "Ranked"), "The API's resolved context is authoritative");
});

test("trio showdown preserves multiple teams and opposing club members do not imply a premade squad", async () => {
  const teams = Array.from({ length: 4 }, (_, team) => Array.from({ length: 3 }, (_, index) => player(`#T${team}P${index}`)));
  const clubPlayers = [player("#T0P0", { trophy_change: 8 }), player("#T1P0", { result: "defeat", trophy_change: null })];
  const page = feedHarness({ matches: [match({ mode: "trioShowdown", isShowdown: true, teamCount: 4, teams, clubPlayers })] });
  const mounted = page.mount(cards(await page.render())[0]);
  let tree = await mounted.render();
  assert.match(textContent(tree), /Trio Showdown.*Mixed results/);
  assert.doesNotMatch(textContent(tree), /Club Squad/);
  assert.equal(textContent(elements(tree).find(element => element.props?.title === "Reported change")), "—", "A partial sum must not masquerade as the total");
  const compactRows = elements(tree).filter(element => element.type?.name === "PlayerRow");
  assert.deepEqual(compactRows.map(element => element.props.result), ["victory", "defeat"]);
  await action(tree, "Match details")();
  tree = await mounted.render();
  assert.match(textContent(tree), /Team 1.*Team 2.*Team 3.*Team 4/);
  assert.doesNotMatch(textContent(tree), /Your Team|Opponents|Club Squad/);
  assert.equal(elements(tree).filter(element => element.type?.name === "PlayerRow").length, 14);
  assert.equal(elements(tree).find(element => element.type === "button").props["aria-expanded"], true);
});

test("missing team data uses a players list without inventing team membership", async () => {
  const page = feedHarness({ matches: [match({ clubPlayers: [player("#ONE"), player("#TWO")] })] });
  const mounted = page.mount(cards(await page.render())[0]);
  let tree = await mounted.render();
  await action(tree, "Match details")();
  tree = await mounted.render();
  assert.match(textContent(tree), /Players/);
  assert.doesNotMatch(textContent(tree), /Your Team|Opponents|Club Squad/);
});

test("member recent battles share canonical labels, category metadata and nullable trophy formatting", async () => {
  const renderer = hookRenderer();
  const recentMatches = [
    { battle_time: "2026-09-16T10:00:00Z", mode: "airHockey", battle_type: "teamRanked", result: "victory", trophy_change: 0 },
    { battle_time: "2026-09-16T09:00:00Z", mode: "deathmatch", battle_type: null, result: "unknown", trophy_change: null },
  ];
  const component = loadTypeScript("src/app/members/[tag]/page.tsx", {
    ...mocks, react: { ...renderer.react, use: value => value },
    "@/lib/client-data-cache": { fetchJsonCached: async () => ({
      member: { player_tag: "#ONE", player_name: "One", trophies: 1000, highest_trophies: 1000, role: "member", activity_status: "active", trio_victories: 1, solo_victories: 1, duo_victories: 1 }, recentMatches,
    }) },
  }, { window: windowMock }).default;
  const tree = await renderer.render(() => component({ params: { tag: "%23ONE" } }));
  const card = elements(tree).find(element => element.type === "Card" && textContent(element).includes("Recent Matches"));
  assert.ok(card);
  assert.match(textContent(card), /Brawl Hockey.*Ranked/);
  assert.match(textContent(card), /Unknown result.*Wipeout.*Unclassified/);
  assert.doesNotMatch(textContent(card), /airHockey|deathmatch|Friendly|Draw/);
  assert.deepEqual(elements(card).filter(element => element.props?.title === "Reported change").map(textContent), ["0", "—"]);
});

test("point units control labels and mixed units or unreported legacy values cannot form a trophy total", async () => {
  for (const [unit, title] of [["trophies", "Trophy change"], ["unknown", "Reported change"]]) {
    const page = feedHarness({ matches: [match({ clubPlayers: [player("#ONE", { pointData: { change: 1, unit } })] })] });
    const tree = await page.mount(cards(await page.render())[0]).render();
    const row = await page.mount(elements(tree).find(element => element.type?.name === "PlayerRow")).render();
    assert.equal(textContent(elements(row).find(element => element.props?.title === title)), "+1");
    assert.equal(textContent(elements(tree).find(element => element.props?.title === (unit === "trophies" ? "Club trophy change" : "Reported change"))), "+1");
  }
  const page = feedHarness({ matches: [match({ clubPlayers: [
    player("#ONE", { pointData: { change: 8, unit: "trophies" } }),
    player("#TWO", { pointData: { change: 1, unit: "unknown" } }),
  ] })] });
  const tree = await page.mount(cards(await page.render())[0]).render();
  assert.equal(textContent(elements(tree).find(element => element.props?.title === "Reported change")), "—");
  assert.equal(elements(tree).some(element => element.props?.title === "Club trophy change"), false);
  const legacyPage = feedHarness({ matches: [match({ clubPlayers: [player("#ONE", { trophy_change: 0, pointData: { change: null, unit: "unknown" } })] })] });
  const legacyTree = await legacyPage.mount(cards(await legacyPage.render())[0]).render();
  const legacyRow = await legacyPage.mount(elements(legacyTree).find(element => element.type?.name === "PlayerRow")).render();
  assert.equal(textContent(elements(legacyRow).find(element => element.props?.title === "Reported change")), "—", "Explicit provenance overrides older synthesized zero");
});
