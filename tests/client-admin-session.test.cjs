const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent } = require("./helpers/client-renderer.cjs");
const settle = () => new Promise(resolve => setImmediate(resolve));
const json = value => Response.json(value);
function target() {
  const events = new Map();
  return { events, addEventListener(type, callback) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(callback); },
    removeEventListener(type, callback) { events.get(type)?.delete(callback); },
    dispatchEvent(event) { for (const callback of [...events.get(event.type) || []]) callback(event); } };
}
function fixture() {
  const window = target(), document = { ...target(), visibilityState: "visible" }, requests = [], invalidations = [], events = [], writes = [];
  window.localStorage = { setItem: (...args) => writes.push(args) };
  window.addEventListener("admin-session-changed", event => events.push(event.detail));
  const sessionStore = loadTypeScript("src/lib/client-admin-session.ts", {
    "@/lib/client-data-cache": { invalidateJsonCache: (...args) => invalidations.push(args) },
  }, { window, document, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) });
  return { module: sessionStore, window, document, requests, invalidations, events, writes };
}

test("many admin controls share one read and one listener set, including a fresh route remount", async () => {
  const f = fixture(); let notified = 0;
  const stops = Array.from({ length: 19 }, () => f.module.subscribeAdminSession(() => notified++));
  assert.equal(f.requests.length, 1);
  assert.equal(f.window.events.get("focus").size, 1);
  assert.equal(f.module.getAdminSession().isLoading, true);
  f.requests[0].resolve(json({ configured: true, isAdmin: true })); await settle();
  assert.equal(notified, 19); assert.equal(f.module.getAdminSession().isAdmin, true);
  stops.forEach(stop => stop()); assert.equal(f.window.events.get("focus").size, 0);
  const stop = f.module.subscribeAdminSession(() => {}); await settle();
  assert.equal(f.requests.length, 1, "A fresh accepted session is reused across navigation"); stop();
});

test("logout clears private UI and requests immediately; a delayed old GET cannot restore admin", async () => {
  const f = fixture(); const stop = f.module.subscribeAdminSession(() => {});
  const old = f.requests[0];
  const logout = f.module.logoutAdmin();
  assert.equal(old.options.signal.aborted, true);
  assert.equal(f.module.getAdminSession().isAdmin, false);
  assert.equal(f.module.getAdminSession().isLoading, true);
  assert.equal(f.invalidations[0][0], "/api/"); assert.equal(f.invalidations[0][1].cancelPending, true);
  assert.equal(f.events.at(-1).pending, true);
  assert.equal(f.requests[1].options.method, "DELETE");
  f.requests[1].resolve(json({ success: true })); await logout;
  old.resolve(json({ configured: true, isAdmin: true })); await settle();
  assert.equal(f.module.getAdminSession().isAdmin, false);
  assert.equal(f.module.getAdminSession().isLoading, false);
  assert.equal(f.events.at(-1).pending, false);
  assert.doesNotMatch(JSON.stringify(f.writes), /isAdmin|password/); stop();
});

test("failed sign-out rechecks the actual cookie session and never claims success", async () => {
  const f = fixture(); const stop = f.module.subscribeAdminSession(() => {});
  f.requests[0].resolve(json({ configured: true, isAdmin: true })); await settle();
  const logout = f.module.logoutAdmin(); const rejected = assert.rejects(logout, /Could not sign out/);
  const joinedRefresh = f.module.refreshAdminSession();
  assert.equal(f.module.getAdminSession().isAdmin, false);
  f.requests[1].resolve(Response.json({ error: "Could not sign out" }, { status: 503 })); await settle();
  assert.equal(f.requests.length, 3); assert.equal(f.requests[2].options.method, undefined);
  assert.equal(f.module.getAdminSession().isAdmin, false, "Private UI stays closed until the replacement session read settles");
  f.requests[2].resolve(json({ configured: true, isAdmin: true }));
  await rejected; await joinedRefresh;
  assert.equal(f.module.getAdminSession().isAdmin, true, "The server may still have a valid cookie after failed DELETE"); stop();
});

test("cross-tab hints invalidate auth immediately and never supply an authorization value", async () => {
  const f = fixture(); const stop = f.module.subscribeAdminSession(() => {});
  f.requests[0].resolve(json({ configured: true, isAdmin: true })); await settle();
  f.window.dispatchEvent({ type: "storage", key: "brawl-club-manager-admin-session-updated", newValue: '{"isAdmin":true}' });
  assert.equal(f.module.getAdminSession().isAdmin, false);
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(json({ configured: true, isAdmin: false })); await settle();
  assert.equal(f.module.getAdminSession().isAdmin, false); stop();
});

test("the admin hook uses the shared external store for every consumer", () => {
  const f = fixture(); const subscriptions = [];
  const { useAdminSession } = loadTypeScript("src/hooks/use-admin-session.ts", {
    "@/lib/client-admin-session": f.module,
    react: { useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) { subscriptions.push(subscribe); assert.equal(getServerSnapshot().isAdmin, false); return getSnapshot(); } },
  });
  const values = Array.from({ length: 19 }, useAdminSession);
  assert.equal(new Set(subscriptions).size, 1);
  assert.equal(new Set(values.map(value => value.login)).size, 1);
  assert.equal(new Set(values.map(value => value.logout)).size, 1);
  assert.equal(f.requests.length, 0, "Reads start on subscription rather than during rendering");
});

test("admin logout failure stays visible outside the private gate and does not redirect", async () => {
  const renderer = hookRenderer(); const redirects = []; let fail = true;
  const Page = loadTypeScript("src/app/admin/page.tsx", {
    ...componentMocks, react: renderer.react,
    "next/navigation": { useRouter: () => ({ replace: path => redirects.push(path) }) },
    "@/hooks/use-admin-session": { useAdminSession: () => ({ logout: async () => { if (fail) throw new Error("offline"); } }) },
  }).default;
  let tree = await renderer.render(Page);
  const logout = () => elements(tree).find(element => element.type === "AdminGate").props.children.props.onLogout();
  await logout(); tree = await renderer.render(Page);
  assert.match(textContent(tree), /Could not sign out/); assert.equal(redirects.length, 0);
  assert.equal(elements(elements(tree).find(element => element.type === "AdminGate")).some(element => element.props?.role === "alert"), false,
    "The error must survive AdminGate unmounting its private child during sign-out");
  fail = false; await logout(); tree = await renderer.render(Page);
  assert.deepEqual(redirects, ["/"]); assert.doesNotMatch(textContent(tree), /Could not sign out/);
});
