const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent } = require("./helpers/client-renderer.cjs");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(respond) {
  const renderer = hookRenderer(), listeners = new Map(), cleanups = new Set(), requests = [];
  const session = { isAdmin: true, isLoading: false };
  const window = { addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } };
  const fetch = (url, options = {}) => { const request = { url, options, body: options.body && JSON.parse(options.body) }; requests.push(request); return respond(request); };
  const store = loadTypeScript("src/lib/store.ts", { "zustand/middleware": { persist: init => init } }, { fetch, Error }).useAppStore;
  store.setState({ clubTag: "#OLD", clubName: "Old club", apiKeyConfigured: true, discordWebhookConfigured: true,
    hasLoadedSettings: true, isLoadingSettings: false, lastSyncTime: "2026-09-16T00:00:00Z" });
  const Page = loadTypeScript("src/app/settings/page.tsx", { ...componentMocks,
    react: { ...renderer.react, useEffect(callback, deps) { renderer.react.useEffect(() => { const cleanup = callback(); if (cleanup) cleanups.add(cleanup); return cleanup; }, deps); } },
    "@/lib/store": { useAppStore: () => store.getState() },
    "@/hooks/use-admin-session": { useAdminSession: () => session },
    "@/components/ui/switch": { Switch: "Switch" },
    "@/components/ui/tabs": Object.fromEntries(["Tabs", "TabsContent", "TabsList", "TabsTrigger"].map(name => [name, name])),
  }, { window, fetch, Error }).default;
  return { store, session, requests, render: () => renderer.render(Page), logout() { session.isAdmin = false; listeners.get("admin-session-changed")?.(); }, unmount() { for (const cleanup of cleanups) cleanup(); } };
}
const field = (tree, id) => elements(tree).find(node => node.props?.id === id);
const save = (tree, value) => elements(elements(tree).find(node => node.type === "TabsContent" && node.props.value === value)).find(node => node.type === "Button").props.onClick();

test("logout clears settings secret drafts and cancels verification before it can submit settings", async () => {
  const pending = deferred();
  const page = fixture(request => request.url === "/api/verify-club" ? pending.promise : Promise.reject(new Error("Unexpected settings write")));
  let tree = await page.render();
  field(tree, "settings-club-tag").props.onChange({ target: { value: "#NEW" } });
  field(tree, "settings-api-key").props.onChange({ target: { value: "draft-api-key" } });
  field(tree, "settings-discord-webhook").props.onChange({ target: { value: "draft-webhook" } });
  const saving = save(await page.render(), "general");
  assert.equal(page.requests.length, 1);
  page.logout(); tree = await page.render();
  assert.equal(page.requests[0].options.signal.aborted, true);
  for (const id of ["settings-api-key", "settings-discord-webhook"]) assert.equal(field(tree, id).props.value, "");
  assert.equal(field(tree, "settings-club-tag").props.value, "#OLD");
  pending.resolve(Response.json({ clubTag: "#NEW", clubName: "New club", requiredTrophies: 3000 }));
  await saving;
  assert.equal(page.requests.length, 1);
  page.session.isAdmin = true; tree = await page.render();
  assert.equal(field(tree, "settings-api-key").props.value, "");
  assert.equal(field(tree, "settings-discord-webhook").props.value, "");
  assert.doesNotMatch(textContent(tree), /Saved!|Request cancelled/);
  page.unmount();
});

test("a settings write aborted by logout cannot apply a late success to shared state", async () => {
  const pending = deferred();
  const page = fixture(request => request.url === "/api/verify-club"
    ? Promise.resolve(Response.json({ clubTag: "#NEW", clubName: "New club", requiredTrophies: 3000 })) : pending.promise);
  let tree = await page.render();
  field(tree, "settings-club-tag").props.onChange({ target: { value: "#NEW" } });
  const saving = save(await page.render(), "general");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.requests.length, 2);
  page.logout(); await page.render();
  assert.equal(page.requests[1].options.signal.aborted, true);
  pending.resolve(Response.json({ success: true, requiresSync: true }));
  await saving;
  assert.equal(page.store.getState().clubTag, "#OLD");
  assert.equal(page.store.getState().clubName, "Old club");
  assert.equal(page.store.getState().lastSyncTime, "2026-09-16T00:00:00Z");
  assert.doesNotMatch(textContent(await page.render()), /Saved!/);
  page.unmount();
});

test("leaving settings cancels an in-flight save, and an already-aborted store request never sends a POST", async () => {
  const pending = deferred(), page = fixture(() => pending.promise);
  const saving = save(await page.render(), "activity");
  page.unmount();
  assert.equal(page.requests[0].options.signal.aborted, true);
  pending.resolve(Response.json({ success: true }));
  await saving;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(page.store.getState().saveSettingsToDB({ notificationsEnabled: false }, { signal: controller.signal }));
  assert.equal(page.requests.length, 1);
});

test("a successful club change discards cached and pending old-club responses before notifying consumers", async () => {
  let newClub = false, pendingSignal;
  const pending = deferred(), events = [];
  const fetch = async (url, options = {}) => {
    if (url === "/api/settings") { newClub = true; return Response.json({ success: true, requiresSync: true }); }
    if (url === "/api/dashboard") { pendingSignal = options.signal; return pending.promise; }
    if (url === "/api/members") return Response.json({ club: newClub ? "new" : "old" });
    throw new Error("Unexpected request");
  };
  const cache = loadTypeScript("src/lib/client-data-cache.ts", {}, { fetch });
  const store = loadTypeScript("src/lib/store.ts", {
    "zustand/middleware": { persist: init => init }, "@/lib/client-data-cache": cache,
  }, { fetch, window: { dispatchEvent(event) { events.push({ type: event.type, detail: event.detail, oldRequestAborted: pendingSignal.aborted }); } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
  }).useAppStore;
  assert.equal((await cache.fetchJsonCached("/api/members")).club, "old");
  const oldRead = cache.fetchJsonCached("/api/dashboard");
  const rejected = assert.rejects(oldRead, /cancelled/i);
  await store.getState().saveSettingsToDB({ clubTag: "#NEW" });
  await rejected;
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{ type: "club-data-updated", detail: { clubChanged: true }, oldRequestAborted: true }]);
  assert.equal(store.getState().lastSyncTime, null);
  assert.equal((await cache.fetchJsonCached("/api/members")).club, "new");
  pending.resolve(Response.json({ club: "old" }));
});
