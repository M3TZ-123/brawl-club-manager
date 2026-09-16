const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, action, windowMock } = require("./helpers/client-renderer.cjs");
const quiet = { ...console, error() {} };
const clone = value => JSON.parse(JSON.stringify(value));
const saved = { clubTag: "#OLD", clubName: "Old club", apiKeyConfigured: true, requiredTrophies: 1000,
  inactivityThreshold: 48, notificationsEnabled: true, hasLoadedSettings: true, isLoadingSettings: false,
  lastSyncTime: "2026-09-16T00:00:00Z" };
function storeFixture(fetch) {
  const store = loadTypeScript("src/lib/store.ts", { "zustand/middleware": { persist: init => init } }, { fetch, Error }).useAppStore;
  store.setState(saved);
  return store;
}
function pageFixture(store, fetch) {
  const renderer = hookRenderer();
  const Page = loadTypeScript("src/app/settings/page.tsx", { ...componentMocks, react: renderer.react,
    "@/lib/store": { useAppStore: () => store.getState() },
    "@/components/ui/switch": { Switch: "Switch" },
    "@/components/ui/tabs": Object.fromEntries(["Tabs", "TabsContent", "TabsList", "TabsTrigger"].map(key => [key, key])),
  }, { fetch, console: quiet, Error }).default;
  return { render: () => renderer.render(Page) };
}
const field = (tree, id) => elements(tree).find(node => node.props?.id === id);
const section = (tree, value) => elements(tree).find(node => node.type === "TabsContent" && node.props.value === value);
const save = (tree, value) => elements(section(tree, value)).find(node => node.type === "Button").props.onClick();

test("failed settings save keeps accepted configuration and local drafts separate across tabs", async () => {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return Response.json({ error: "Save unavailable" }, { status: 503 });
  };
  const store = storeFixture(fetch), page = pageFixture(store, fetch);
  let tree = await page.render();
  field(tree, "settings-notifications").props.onCheckedChange(false);
  field(tree, "settings-inactivity-threshold").props.onChange({ target: { value: "72" } });
  tree = await page.render();
  await save(tree, "general");
  assert.deepEqual(requests[0].body, { club_tag: "#OLD" }, "General must not save another tab's unsaved draft");
  assert.equal(store.getState().notificationsEnabled, true);
  assert.equal(store.getState().inactivityThreshold, 48);
  tree = await page.render();
  assert.match(textContent(section(tree, "general")), /Save unavailable/);
  assert.equal(field(tree, "settings-notifications").props.checked, false);
  assert.equal(field(tree, "settings-inactivity-threshold").props.value, 72);
  await save(tree, "activity");
  await save(await page.render(), "notifications");
  assert.deepEqual(requests.slice(1).map(row => row.body), [{ inactivity_threshold: "72" }, { notifications_enabled: "false" }]);
  assert.equal(store.getState().inactivityThreshold, 48);
  assert.equal(store.getState().notificationsEnabled, true);
});

test("changed club is verified before the accepted tag, name, requirements and completion change", async () => {
  let verificationFails = true;
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url === "/api/verify-club") return verificationFails
      ? Response.json({ error: "Club not found" }, { status: 404 })
      : Response.json({ success: true, clubTag: "#NEW", clubName: "New club", requiredTrophies: 5000 });
    return Response.json({ success: true, requiresSync: true });
  };
  const store = storeFixture(fetch), page = pageFixture(store, fetch);
  let tree = await page.render();
  field(tree, "settings-club-tag").props.onChange({ target: { value: "new" } });
  await save(await page.render(), "general");
  assert.equal(requests.length, 1);
  assert.equal(store.getState().clubTag, "#OLD");
  assert.equal(store.getState().lastSyncTime, saved.lastSyncTime);
  verificationFails = false;
  await save(await page.render(), "general");
  assert.deepEqual(requests.at(-1).body, { club_tag: "#NEW", club_name: "New club", required_trophies: "5000" });
  assert.equal(store.getState().clubName, "New club");
  assert.equal(store.getState().requiredTrophies, 5000);
  assert.equal(store.getState().lastSyncTime, null);
});

test("initial settings failure is retryable and blocks editing or fabricated onboarding", async () => {
  let fail = true, reads = 0;
  const store = storeFixture(async () => {
    reads++;
    if (fail) return Response.json({ error: "Unavailable" }, { status: 503 });
    return Response.json({ club_tag: "#REAL", api_key_configured: "true", last_sync_time: "" });
  });
  store.setState({ hasLoadedSettings: false, isLoadingSettings: true });
  await Promise.all([store.getState().loadSettingsFromDB(), store.getState().loadSettingsFromDB()]);
  assert.equal(reads, 1);
  assert.match(store.getState().settingsError, /Could not load settings/);
  assert.equal(store.getState().clubTag, "#OLD", "A failed read must not erase the last accepted configuration");
  await assert.rejects(store.getState().saveSettingsToDB({ inactivityThreshold: 72 }), /Could not load settings/);
  const page = pageFixture(store);
  let tree = await page.render();
  assert.match(textContent(tree), /Could not load settings/);
  assert.equal(elements(tree).some(node => node.type === "Input"), false);
  const wizardRenderer = hookRenderer();
  const hook = Object.assign(() => store.getState(), { getState: store.getState });
  const { SetupWizard } = loadTypeScript("src/components/setup-wizard.tsx", { ...componentMocks, react: wizardRenderer.react,
    "@/lib/store": { useAppStore: hook }, "@/lib/client-data-cache": { invalidateJsonCache() {} },
  });
  const wizard = await wizardRenderer.render(SetupWizard);
  assert.match(textContent(wizard), /Could not load settings/);
  assert.doesNotMatch(textContent(wizard), /Step 1|Step 3|verified/);
  fail = false;
  action(tree, "Retry")();
  await new Promise(resolve => setImmediate(resolve));
  tree = await page.render();
  assert.equal(store.getState().settingsError, null);
  assert.equal(field(tree, "settings-club-tag").props.value, "#REAL");
});

test("settings reads started before or during a save cannot overwrite its accepted result", async () => {
  const requests = [];
  const store = storeFixture((url, options) => new Promise(resolve => requests.push({ url, options, resolve })));
  const first = store.getState().loadSettingsFromDB(true);
  const write = store.getState().saveSettingsToDB({ clubTag: "#NEW", clubName: "New club", notificationsEnabled: false });
  const during = store.getState().loadSettingsFromDB(true);
  requests[1].resolve(Response.json({ success: true, requiresSync: true })); await write;
  requests[0].resolve(Response.json({ club_tag: "#BEFORE", api_key_configured: "false", last_sync_time: saved.lastSyncTime }));
  requests[2].resolve(Response.json({ club_tag: "#DURING", notifications_enabled: "true", last_sync_time: saved.lastSyncTime }));
  await Promise.all([first, during]);
  assert.equal(store.getState().clubTag, "#NEW");
  assert.equal(store.getState().clubName, "New club");
  assert.equal(store.getState().notificationsEnabled, false);
  assert.equal(store.getState().apiKeyConfigured, true);
  assert.equal(store.getState().lastSyncTime, null);
  assert.equal(store.getState().isLoadingSettings, false);
});

test("sync confirmation keeps setup mounted and reports a missing server completion marker", async () => {
  let resolveSettings;
  const fetch = async url => {
    if (url === "/api/sync") return Response.json({ success: true });
    if (url === "/api/settings") return new Promise(resolve => { resolveSettings = resolve; });
    throw new Error(`Unexpected request ${url}`);
  };
  const store = storeFixture(fetch);
  store.setState({ lastSyncTime: null });
  const hook = Object.assign(() => store.getState(), { getState: store.getState });
  const dashboardRenderer = hookRenderer();
  const Dashboard = loadTypeScript("src/app/page.tsx", { ...componentMocks, react: dashboardRenderer.react,
    "@/lib/store": { useAppStore: hook }, "@/components/setup-wizard": { SetupWizard: "SetupWizard" },
    "@/lib/client-data-cache": { fetchJsonCached: async () => { throw new Error("Incomplete setup must not request dashboard data"); } },
  }, { window: windowMock, console: quiet }).default;
  const renderer = hookRenderer();
  const { SetupWizard } = loadTypeScript("src/components/setup-wizard.tsx", { ...componentMocks, react: renderer.react,
    "@/lib/store": { useAppStore: hook }, "@/lib/client-data-cache": { invalidateJsonCache() {} },
  }, { fetch, console: quiet, Error });
  assert.equal((await dashboardRenderer.render(Dashboard)).type, "SetupWizard");
  const pending = action(await renderer.render(SetupWizard), "Start Using App")();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof resolveSettings, "function");
  assert.equal(store.getState().isLoadingSettings, false);
  assert.equal((await dashboardRenderer.render(Dashboard)).type, "SetupWizard", "Forced settings confirmation must not replace the wizard with the dashboard's loading branch");
  assert.match(textContent(await renderer.render(SetupWizard)), /Starting sync/);
  resolveSettings(Response.json({ club_tag: "#OLD", api_key_configured: "true", last_sync_time: "" }));
  await pending;
  assert.equal((await dashboardRenderer.render(Dashboard)).type, "SetupWizard");
  const tree = await renderer.render(SetupWizard);
  assert.match(textContent(tree), /Sync finished, but its completion could not be confirmed/);
  assert.ok(action(tree, "Start Using App"), "The same wizard retains a visible retry action");
  assert.equal(store.getState().lastSyncTime, null);
});

test("setup verification followed by failed persistence retains only local credentials", async () => {
  const store = storeFixture(async () => Response.json({ error: "Save unavailable" }, { status: 503 }));
  store.setState({ clubTag: "", clubName: "", apiKeyConfigured: false, lastSyncTime: null });
  const hook = Object.assign(() => store.getState(), { getState: store.getState });
  const renderer = hookRenderer();
  const { SetupWizard } = loadTypeScript("src/components/setup-wizard.tsx", { ...componentMocks, react: renderer.react,
    "@/lib/store": { useAppStore: hook }, "@/lib/client-data-cache": { invalidateJsonCache() {} },
  }, { Error, fetch: async () => Response.json({ success: true, clubTag: "#NEW", clubName: "New club", requiredTrophies: 1000 }) });
  let tree = await renderer.render(SetupWizard);
  field(tree, "setup-api-key").props.onChange({ target: { value: "private-test-key" } });
  action(await renderer.render(SetupWizard), "Continue")();
  tree = await renderer.render(SetupWizard);
  field(tree, "setup-club-tag").props.onChange({ target: { value: "#NEW" } });
  await action(await renderer.render(SetupWizard), "Verify Club")();
  tree = await renderer.render(SetupWizard);
  assert.match(textContent(tree), /Save unavailable/);
  assert.match(textContent(tree), /Step 2/);
  assert.equal(store.getState().apiKeyConfigured, false);
  assert.equal(store.getState().apiKey, "");
  assert.equal(store.getState().clubTag, "");
});

function settingsApi() {
  let written = [], reads = 0;
  const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { reads++; return { data: { value: "#OLD" }, error: null }; } }) }),
    upsert: async rows => { written = clone(rows); return { error: null }; } }) };
  const route = loadTypeScript("src/app/api/settings/route.ts", { "@/lib/supabase-admin": { supabaseAdmin: db },
    "@/lib/admin-auth": { rejectUnauthorizedAdminMutation: () => null }, "next/server": { NextResponse: { json: Response.json } },
  }, { console: quiet });
  return { module: route, written: () => written, reads: () => reads };
}
const request = body => new Request("https://app.test/api/settings", { method: "POST", body: JSON.stringify(body) });

test("invalid settings are rejected before writes and webhook secrets never appear in errors", async () => {
  for (const body of [{ club_tag: " " }, { club_tag: "#BAD/TAG" }, { discord_webhook: "https://evil.test/api/webhooks/id/private-secret" }, { discord_webhook: "http://discord.com/api/webhooks/id/private-secret" }]) {
    const f = settingsApi(); const response = await f.module.POST(request(body));
    assert.equal(response.status, 400); assert.equal(f.written().length, 0);
    assert.doesNotMatch(JSON.stringify(await response.json()), /private-secret/);
  }
  const f = settingsApi();
  assert.equal((await f.module.POST(new Request("https://app.test/api/settings", { method: "POST", body: "{" }))).status, 400);
});

test("canonical club changes clear old metadata and all server freshness markers atomically", async () => {
  const f = settingsApi();
  assert.equal((await (await f.module.POST(request({ club_tag: "%23old" }))).json()).requiresSync, false);
  assert.deepEqual(f.written(), [{ key: "club_tag", value: "#OLD" }]);
  const response = await f.module.POST(request({ club_tag: "new", last_sync_time: "forged" }));
  assert.equal((await response.json()).requiresSync, true);
  const values = Object.fromEntries(f.written().map(row => [row.key, row.value]));
  assert.equal(values.club_tag, "#NEW"); assert.equal(values.club_name, ""); assert.equal(values.required_trophies, "");
  assert.deepEqual(Object.keys(values).filter(key => key.startsWith("last_")).sort(), ["last_battle_sync_time", "last_full_sync_time", "last_ranked_attempt_time", "last_ranked_sync_time", "last_roster_sync_time", "last_sync_time"]);
  assert.equal(Object.values(values).includes("forged"), false);
});

test("club verification uses a saved or environment key only after authorization and valid input", async () => {
  let authorized = true, savedKey = "private-saved-key", settingsReads = 0;
  const calls = [];
  const route = loadTypeScript("src/app/api/verify-club/route.ts", {
    "next/server": { NextResponse: { json: Response.json } },
    "@/lib/admin-auth": { rejectUnauthorizedAdminMutation: () => authorized ? null : Response.json({ error: "Unauthorized" }, { status: 401 }) },
    "@/lib/supabase-admin": { supabaseAdmin: { from: table => { assert.equal(table, "settings"); return { select: columns => {
      assert.equal(columns, "value"); return { eq: (key, value) => { assert.equal(key, "key"); assert.equal(value, "api_key");
        return { maybeSingle: async () => { settingsReads++; return { data: { value: savedKey }, error: null }; } }; } }; } }; } } },
    "@/lib/brawl-api": { BrawlApiError: Error, getClub: async (tag, key) => { calls.push({ tag, key }); return { tag: "#NEW", name: "New club", members: [], requiredTrophies: 0 }; } },
  }, { console: quiet, process: { env: { BRAWL_API_KEY: "private-env-key" } } });
  authorized = false;
  assert.equal((await route.POST(request({ clubTag: "#NEW" }))).status, 401);
  authorized = true;
  assert.equal((await route.POST(request({ clubTag: "bad tag" }))).status, 400);
  assert.equal(settingsReads, 0);
  let response = await route.POST(request({ clubTag: "%23new" }));
  assert.equal(calls[0].key, "private-saved-key"); assert.equal(calls[0].tag, "#NEW");
  assert.doesNotMatch(JSON.stringify(await response.json()), /private-/);
  savedKey = "";
  response = await route.POST(request({ clubTag: "#NEW" }));
  assert.equal(response.status, 200); assert.equal(calls[1].key, "private-env-key");
});

test("missing notification storage is an unavailable read or mutation, never false empty/success", async () => {
  const result = { data: null, error: { code: "PGRST205", message: "private.notifications fixture" } };
  const builder = new Proxy({}, { get: (_target, name) => name === "then" ? (resolve, reject) => Promise.resolve(result).then(resolve, reject) : () => builder });
  const route = loadTypeScript("src/app/api/notifications/route.ts", { "next/server": { NextResponse: { json: Response.json } },
    "@/lib/supabase-admin": { supabaseAdmin: { from: () => builder } }, "@/lib/admin-auth": { rejectUnauthorizedAdminMutation: () => null },
  }, { console: quiet });
  for (const method of ["GET", "PATCH", "DELETE"]) {
    const req = new Request("https://app.test/api/notifications", { method, ...(method === "PATCH" ? { body: JSON.stringify({ all: true }) } : {}) });
    const response = await route[method](req), body = await response.json();
    assert.equal(response.status, 503); assert.equal(body.success, undefined); assert.equal(body.notifications, undefined);
    assert.doesNotMatch(JSON.stringify(body), /PGRST|private/);
  }
});

test("notification read action is a keyboard-accessible button and failures preserve unread state", async () => {
  const renderer = hookRenderer(); let admin = true, patchFails = true;
  const Page = loadTypeScript("src/app/notifications/page.tsx", { ...componentMocks, react: renderer.react,
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: admin }) },
    "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
    "@/lib/client-data-cache": { invalidateJsonCache() {}, fetchJsonCached: async () => ({ unreadCount: 1, notifications: [
      { id: 1, type: "join", title: "Member Joined", message: "A joined", is_read: false, created_at: "2026-09-16T00:00:00Z" },
    ] }) },
  }, { window: windowMock, CustomEvent: class {}, console: quiet, fetch: async () => patchFails
    ? Response.json({ error: "Unavailable" }, { status: 503 }) : Response.json({ success: true, unreadCount: 0 }) }).default;
  let tree = await renderer.render(Page);
  const button = elements(tree).find(node => node.type === "Button" && textContent(node) === "Mark as read");
  assert.ok(button); await button.props.onClick();
  tree = await renderer.render(Page);
  assert.match(textContent(tree), /Could not update notifications/); assert.ok(action(tree, "Mark as read"));
  patchFails = false; await action(tree, "Mark as read")(); tree = await renderer.render(Page);
  assert.equal(elements(tree).some(node => node.type === "Button" && textContent(node) === "Mark as read"), false);
  admin = false; tree = await renderer.render(Page);
  assert.equal(elements(tree).some(node => node.type === "Button" && textContent(node) === "Mark as read"), false);
});
