const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, action } = require("./helpers/client-renderer.cjs");

test("notification mutations reject malformed bodies and IDs before writes, and retain valid explicit all/ID actions", async () => {
  const writes = [];
  let dbCalls = 0;
  const route = loadTypeScript("src/app/api/notifications/route.ts", {
    "@/lib/admin-auth": { rejectUnauthorizedAdminMutation: () => null },
    "@/lib/supabase-admin": { supabaseAdmin: { from() { dbCalls++; return {
      update: values => ({ in: async (key, ids) => { writes.push({ values, key, ids }); return { error: null }; },
        eq: async () => { writes.push({ all: true }); return { error: null }; } }),
      select: () => ({ eq: async () => ({ count: 0, error: null }) }),
    }; } } },
  });
  const request = body => new Request("http://fixture/api/notifications", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const body of [null, [], "wrong", {}, { all: false }, { ids: [] }, { ids: ["12oops"] }, { ids: [1, "2"] },
    { ids: [1.5] }, { ids: [0] }, { ids: [-1] }, { ids: [2_147_483_648] }, { ids: Array(101).fill(1) }, { all: true, ids: [1] }, { all: true, unknown: true }]) {
    const response = await route.PATCH(request(body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(dbCalls, 0);
  let response = await route.PATCH(request({ ids: [12, 12, 13] }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0])), { values: { is_read: true }, key: "id", ids: [12, 13] });
  response = await route.PATCH(request({ all: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(writes[1], { all: true });
});

function fixture(respond, timers = {}) {
  const renderer = hookRenderer(), listeners = new Map(), requests = [], emitted = [];
  const session = { isAdmin: true, isLoading: false };
  const window = { addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) { emitted.push(event.type); for (const listener of [...listeners.get(event.type) || []]) listener(event); } };
  const Page = loadTypeScript("src/app/notifications/page.tsx", { ...componentMocks, react: renderer.react,
    "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
    "@/hooks/use-admin-session": { useAdminSession: () => session },
    "@/lib/client-data-cache": { invalidateJsonCache() {}, fetchJsonCached: async () => ({ unreadCount: 1, nextCursor: null, notifications: [
      { id: 12, type: "join", title: "Joined", message: "A member joined", is_read: false, created_at: "2026-09-17T00:00:00Z" },
    ] }) },
  }, { Error, window, CustomEvent: class { constructor(type) { this.type = type; } }, ...timers,
    fetch: (url, options) => { requests.push({ url, options }); return respond(); },
  }).default;
  return { requests, emitted, render: () => renderer.render(Page), logout() { session.isAdmin = false; window.dispatchEvent({ type: "admin-session-changed" }); } };
}

test("malformed successful notification responses never clear unread state or announce a completed mutation", async () => {
  for (const response of [() => new Response("<html>not JSON</html>"), () => Response.json({}), () => Response.json({ success: false, unreadCount: 0 }), () => Response.json({ success: true, unreadCount: -1 })]) {
    const page = fixture(async () => response());
    let tree = await page.render();
    await action(tree, "Mark all read")(); tree = await page.render();
    assert.match(textContent(tree), /Could not update notifications/);
    assert.match(textContent(tree), /Unread \(1\)/);
    assert.equal(page.emitted.includes("notifications-updated"), false);
    assert.equal(elements(tree).find(node => node.type === "Button" && textContent(node).trim() === "Mark all read").props.disabled, false);
  }
});

test("notification saves are single-flight, bounded, and cancelled across logout without late success effects", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const page = fixture(() => pending);
  let tree = await page.render();
  const save = action(tree, "Mark all read");
  const saving = save(); await save();
  assert.equal(page.requests.length, 1);
  tree = await page.render();
  assert.equal(elements(tree).find(node => node.type === "Button" && textContent(node).trim() === "Mark all read").props.disabled, true);
  page.logout(); await page.render();
  assert.equal(page.requests[0].options.signal.aborted, true);
  resolve(Response.json({ success: true, unreadCount: 0 })); await saving;
  tree = await page.render();
  assert.equal(page.emitted.includes("notifications-updated"), false);
  assert.doesNotMatch(textContent(tree), /Could not update notifications/);
  assert.match(textContent(tree), /Unread \(1\)/);

  const timeout = fixture(() => new Promise(() => {}), { setTimeout: callback => setTimeout(callback, 5), clearTimeout });
  await action(await timeout.render(), "Mark all read")();
  assert.equal(timeout.requests[0].options.signal.aborted, true);
  assert.match(textContent(await timeout.render()), /Could not update notifications/);
});
