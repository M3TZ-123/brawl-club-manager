const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { readOnlyDatabase } = require("./helpers/read-only-database.cjs");

const responseMock = { NextResponse: { json: (body, init) => Response.json(body, init) } };
const json = value => JSON.parse(JSON.stringify(value));

function loadRoute(path, database) {
  return loadTypeScript(path, {
    "@/lib/supabase-admin": { supabaseAdmin: database },
    "@/lib/admin-auth": { rejectUnauthorizedAdminMutation: () => null },
    "next/server": responseMock,
  });
}

function battleDatabase(tables) {
  const database = readOnlyDatabase(tables);
  return { from(table) {
    const query = database.from(table);
    query.not = (key, operator, value) => {
      assert.equal(operator, "is");
      return query.neq(key, value);
    };
    return query;
  } };
}

test("battle pagination keeps squads and interleaved same-time matches complete", async () => {
  const tags = ["#A", "#B", "#C", "#D"];
  const boundaryTime = "2026-01-01T20:00:00.000Z";
  const battle = (player_tag, battle_time, map = "Map") => ({ player_tag, battle_time, mode: "brawlBall", map, result: "victory" });
  const rows = Array.from({ length: 48 }, (_, index) => battle("#A", new Date(Date.UTC(2026, 0, 2) - index * 60_000).toISOString()));
  // A/C/D played together; B played a different map in the same second.
  rows.push(battle("#A", boundaryTime), battle("#B", boundaryTime, "Other"), battle("#C", boundaryTime), battle("#D", boundaryTime));
  rows.push(battle("#A", "2026-01-01T19:00:00.000Z"));
  const route = loadRoute("src/app/api/battles/feed/route.ts", battleDatabase({
    battle_history: rows,
    member_history: tags.map(player_tag => ({ player_tag, is_current_member: true })),
    members: tags.map(player_tag => ({ player_tag, player_name: player_tag })),
  }));
  const first = await (await route.GET(new Request("http://localhost/api/battles/feed?limit=50"))).json();
  assert.equal(first.nextOffset, 52);
  assert.deepEqual(first.matches.find(match => match.battle_time === boundaryTime && match.map === "Map").clubPlayers.map(player => player.tag), ["#A", "#C", "#D"]);
  const second = await (await route.GET(new Request(`http://localhost/api/battles/feed?limit=50&offset=${first.nextOffset}`))).json();
  assert.equal(second.nextOffset, null);
  assert.equal(second.matches.length, 1);
  assert.equal(second.matches[0].battle_time, "2026-01-01T19:00:00.000Z");
  const keys = [...first.matches, ...second.matches].map(match => `${match.battle_time}|${match.mode}|${match.map}`);
  assert.equal(keys.length, new Set(keys).size);
});

test("notification filters reach older unread records and paginate without gaps", async () => {
  const notifications = Array.from({ length: 205 }, (_, index) => ({
    id: 205 - index,
    created_at: new Date(Date.UTC(2026, 0, 2) - index * 60_000).toISOString(),
    type: index >= 100 ? "promotion" : "join",
    is_read: index < 100,
    title: `Notification ${index}`,
  }));
  const route = loadRoute("src/app/api/notifications/route.ts", readOnlyDatabase({ notifications }));
  const query = "http://localhost/api/notifications?limit=100&unreadOnly=true&types=promotion,demotion";
  const first = await (await route.GET(new Request(query))).json();
  assert.equal(first.unreadCount, 105);
  assert.equal(first.notifications.length, 100);
  assert.equal(first.notifications[0].id, 105);
  assert.equal(first.nextOffset, 100);
  const second = await (await route.GET(new Request(`${query}&offset=${first.nextOffset}`))).json();
  assert.equal(second.nextOffset, null);
  assert.deepEqual([...first.notifications, ...second.notifications].map(row => row.id), Array.from({ length: 105 }, (_, index) => 105 - index));
});

test("settings ignores client timestamps and resets completion only for a different club", async () => {
  const written = [];
  const database = { from(table) {
    assert.equal(table, "settings");
    const query = {
      select() { return query; },
      eq() { return query; },
      maybeSingle: async () => ({ data: { value: "#ABC" }, error: null }),
      upsert: async rows => { written.push(...json(rows)); return { error: null }; },
    };
    return query;
  } };
  const route = loadRoute("src/app/api/settings/route.ts", database);
  const save = body => route.POST(new Request("http://localhost/api/settings", { method: "POST", body: JSON.stringify(body) }));
  const unchanged = await (await save({ club_tag: "abc", inactivity_threshold: "72", last_sync_time: "forged", last_inactive_alert: "forged" })).json();
  assert.equal(unchanged.requiresSync, false);
  assert.equal(written.some(row => row.key.startsWith("last_")), false);
  const changed = await (await save({ club_tag: "#XYZ" })).json();
  assert.equal(changed.requiresSync, true);
  assert.deepEqual(written.filter(row => row.key === "last_sync_time"), [{ key: "last_sync_time", value: "" }]);
});

function loadStore(fetch) {
  return loadTypeScript("src/lib/store.ts", {
    "zustand/middleware": { persist: initializer => initializer },
  }, { fetch }).useAppStore;
}

test("settings reload replaces cached completion and saves exclude sync timestamps", async () => {
  const requests = [];
  const store = loadStore(async (url, options = {}) => {
    requests.push({ url, ...options });
    return Response.json(options.method === "POST"
      ? { success: true, requiresSync: true }
      : { club_tag: "#ABC", api_key_configured: "true", last_sync_time: "" });
  });
  store.setState({ lastSyncTime: "2020-01-01T00:00:00.000Z", hasLoadedSettings: true });
  await store.getState().loadSettingsFromDB(true);
  assert.equal(store.getState().lastSyncTime, null);
  store.getState().setLastSyncTime("2026-01-01T00:00:00.000Z");
  await store.getState().saveSettingsToDB();
  assert.equal(Object.hasOwn(JSON.parse(requests.at(-1).body), "last_sync_time"), false);
  assert.equal(store.getState().lastSyncTime, null);
});

// Render the real client component functions and effects without a browser or DOM.
// UI primitives stay as elements; event callbacks and all app data logic execute.
function hookRenderer() {
  const slots = [];
  const effects = [];
  let cursor = 0;
  let dirty = false;
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  function memo(factory, dependencies) {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { value: factory(), dependencies };
    return slots[index].value;
  }
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, update => {
        const value = typeof update === "function" ? update(slots[index].value) : update;
        if (!Object.is(value, slots[index].value)) dirty = true;
        slots[index].value = value;
      }];
    },
    useMemo: memo,
    useCallback: (callback, dependencies) => memo(() => callback, dependencies),
    useRef: value => memo(() => ({ current: value }), []),
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        slots[index]?.cleanup?.();
        slots[index] = { dependencies };
        effects.push(() => { slots[index].cleanup = callback(); });
      }
    },
  };
  return { react, async render(component) {
    for (let pass = 0; pass < 30; pass++) {
      cursor = 0;
      dirty = false;
      const tree = component();
      while (effects.length) effects.shift()();
      await new Promise(resolve => setImmediate(resolve));
      if (!dirty) return tree;
    }
    throw new Error("Client component did not settle");
  } };
}

const i18n = { t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`)), locale: "en", direction: "ltr", number: value => Number(value).toLocaleString("en-GB"), delta: value => String(value), date: value => value || "Unknown", dateTime: value => value || "Unknown", reportDate: value => value, relative: value => value || "Unknown" };
const componentMocks = {
  "@/components/locale-provider": { T: "T", LocalDate: "LocalDate", LanguageSelector: "LanguageSelector", useI18n: () => i18n },
  "@/components/sync-health": { SyncHealthCard: "SyncHealthCard", DataConfidenceNotice: "DataConfidenceNotice" },
  "@/components/member-review": { MemberReviewButton: "MemberReviewButton", MemberReviewSheet: "MemberReviewSheet" },
  "@/components/ui/sheet": Object.fromEntries(["Sheet", "SheetContent", "SheetHeader", "SheetTitle", "SheetDescription"].map(name => [name, name])),
  "@/components/admin-gate": { AdminGate: "AdminGate" },
  "@/components/layout-wrapper": { LayoutWrapper: "LayoutWrapper" },
  "@/components/stats-cards": { StatsCards: "StatsCards" },
  "@/components/activity-timeline": { ActivityTimeline: "ActivityTimeline" },
  "@/components/ui/button": { Button: "Button" },
  "@/components/ui/input": { Input: "Input" },
  "@/components/ui/badge": { Badge: "Badge" },
  "@/components/ui/card": Object.fromEntries(["Card", "CardContent", "CardHeader", "CardTitle", "CardDescription"].map(name => [name, name])),
  "next/link": "Link",
  "next/image": "Image",
  "lucide-react": new Proxy({}, { get: (_, name) => name }),
};
const windowMock = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
function elements(tree) {
  if (tree == null || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return [tree, ...elements(tree.props?.children)];
}
function textContent(tree) {
  if (tree == null) return "";
  if (Array.isArray(tree)) return tree.map(textContent).join("");
  if (tree?.type === "T") return i18n.t(String(tree.props.text || ""), tree.props.values);
  return typeof tree === "object" ? textContent(tree.props?.children) : String(tree);
}
function action(tree, text) {
  const match = elements(tree).find(element => element.props?.onClick && textContent(element).replace(/\s+/g, " ").trim() === text);
  assert.ok(match, `Missing action: ${text}`);
  return match.props.onClick;
}

test("saved credentials keep onboarding open, survive reload, and complete only after successful sync", async () => {
  const requests = [];
  let successfulSync = false;
  let syncFails = true;
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (url === "/api/settings") return Response.json({ club_tag: "#ABC", api_key_configured: "true", last_sync_time: successfulSync ? "2026-01-01T00:00:00.000Z" : "" });
    if (url === "/api/sync") {
      if (syncFails) return Response.json({ error: "Fixture sync failed" }, { status: 500 });
      successfulSync = true;
      return Response.json({ timestamp: "2026-01-01T00:00:00.000Z" });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const store = loadStore(fetch);
  await store.getState().loadSettingsFromDB();
  const storeHook = Object.assign(() => store.getState(), { getState: store.getState });
  const dashboardRenderer = hookRenderer();
  const dashboard = loadTypeScript("src/app/page.tsx", {
    ...componentMocks, react: dashboardRenderer.react,
    "@/lib/store": { useAppStore: storeHook },
    "@/components/setup-wizard": { SetupWizard: "SetupWizard" },
    "@/lib/client-data-cache": { fetchJsonCached: async url => {
      requests.push({ url });
      return url === "/api/insights" ? { insights: null } : { syncStatus: { lastSyncTime: store.getState().lastSyncTime } };
    } },
  }, { window: windowMock }).default;
  assert.equal((await dashboardRenderer.render(dashboard)).type, "SetupWizard");
  assert.equal(requests.some(request => request.url === "/api/dashboard"), false);

  const wizardRenderer = hookRenderer();
  const { SetupWizard } = loadTypeScript("src/components/setup-wizard.tsx", {
    ...componentMocks, react: wizardRenderer.react,
    "@/lib/store": { useAppStore: storeHook },
    "@/lib/client-data-cache": { invalidateJsonCache() {} },
  }, { fetch, console: { ...console, error() {} } });
  let tree = await wizardRenderer.render(SetupWizard);
  assert.match(textContent(tree), /Step 3: Sync your club/);
  await action(tree, "Start Using App")();
  tree = await wizardRenderer.render(SetupWizard);
  assert.match(textContent(tree), /Fixture sync failed/);
  assert.equal(elements(tree).find(element => textContent(element) === "Edit Configuration" && element.props?.href)?.props.href, "/settings");
  assert.equal(store.getState().lastSyncTime, null);
  assert.equal((await dashboardRenderer.render(dashboard)).type, "SetupWizard");
  syncFails = false;
  await action(tree, "Start Using App")();
  assert.equal(store.getState().lastSyncTime, "2026-01-01T00:00:00.000Z");
  assert.equal((await dashboardRenderer.render(dashboard)).type, "LayoutWrapper");
  assert.equal(requests.filter(request => request.url === "/api/sync").length, 2);
});

test("realtime insert bypasses a fresh battle cache and uses the server pagination cursor", async () => {
  const renderer = hookRenderer();
  let onInsert;
  let refreshTimer;
  const requests = [];
  let inserted = false;
  const match = tag => ({ battle_time: "2026-01-01T00:00:00.000Z", mode: "brawlBall", map: "Map", clubPlayers: [{ tag, result: "victory" }] });
  const cache = loadTypeScript("src/lib/client-data-cache.ts", {}, { fetch: async url => {
    requests.push(String(url));
    const row = match(inserted ? "#NEW" : "#OLD");
    if (!String(url).includes("offset=52")) row.clubPlayers.push({ tag: "#TEAMMATE", result: "victory" });
    return Response.json(String(url).startsWith("/api/battles/feed")
      ? { matches: [row], total: 70, nextOffset: 52 }
      : { members: [], list: [] });
  } });
  const channel = { on(_type, _filter, callback) { onInsert = callback; return channel; }, subscribe(callback) { callback("SUBSCRIBED"); return channel; } };
  const component = loadTypeScript("src/app/battle-feed/page.tsx", {
    ...componentMocks, react: renderer.react,
    "@/lib/client-data-cache": cache,
    "@/lib/supabase": { supabase: { channel: () => channel, removeChannel() {} } },
  }, { window: windowMock, document: windowMock, setTimeout: callback => { refreshTimer = callback; return 1; }, clearTimeout() {} }).default;
  let tree = await renderer.render(component);
  const before = requests.filter(url => url.startsWith("/api/battles/feed")).length;
  inserted = true;
  onInsert();
  await refreshTimer();
  tree = await renderer.render(component);
  assert.equal(requests.filter(url => url.startsWith("/api/battles/feed")).length, before + 1);
  assert.equal(elements(tree).find(element => element.props?.match)?.props.match.clubPlayers[0].tag, "#NEW");
  await action(tree, "Load More")();
  assert.ok(requests.some(url => url.includes("offset=52")));
  tree = await renderer.render(component);
  assert.equal(elements(tree).filter(element => element.props?.match).length, 1);
  assert.deepEqual(json(elements(tree).find(element => element.props?.match).props.match.clubPlayers.map(player => player.tag)), ["#NEW", "#TEAMMATE"]);
});

test("notification UI requests unread/category filters and follows nextOffset", async () => {
  const renderer = hookRenderer();
  const requests = [];
  const component = loadTypeScript("src/app/notifications/page.tsx", {
    ...componentMocks, react: renderer.react,
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: false }) },
    "@/lib/client-data-cache": { fetchJsonCached: async url => {
      requests.push(new URL(url, "http://localhost"));
      return { notifications: [{ id: 1, created_at: "2026-01-01T00:00:00.000Z", type: "promotion", title: "Promoted", message: "Player promoted", is_read: false }], unreadCount: 105, nextOffset: 100 };
    } },
  }, { window: windowMock }).default;
  let tree = await renderer.render(component);
  action(tree, "Unread (105)")();
  tree = await renderer.render(component);
  action(tree, "Promotions")();
  tree = await renderer.render(component);
  assert.equal(requests.at(-1).searchParams.get("unreadOnly"), "true");
  assert.equal(requests.at(-1).searchParams.get("types"), "promotion,demotion");
  await action(tree, "Load More")();
  assert.equal(requests.at(-1).searchParams.get("offset"), "100");
  tree = await renderer.render(component);
  assert.equal(elements(tree).filter(element => element.type === "Card" && element.key === "1").length, 1);
});
