const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, action } = require("./helpers/client-renderer.cjs");

const member = (values = {}) => ({ playerTag: "#AAA", playerName: "Amine", reportedWins: 0, reportedTicketsRemaining: null, ...values });
const snapshot = (values = {}) => ({ clubTag: "#CLUB", source: { name: "BrawlAce", url: "https://brawlace.com/clubs/CLUB", official: false, cycleVerified: false, updatedAt: null },
  status: "available", fetchedAt: "2026-09-17T12:00:00Z", lastAttemptAt: "2026-09-17T12:00:00Z", nextCheckAt: "2026-09-17T12:20:00Z", changedAt: null, updating: false,
  totalWins: 82, reportedPlayersPlayed: 24, matchedMembers: 1, sourceMembers: 1, rosterMembers: 1, members: [member()], ...values });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function target(extra = {}) {
  const listeners = new Map();
  return { ...extra, addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); }, removeEventListener(name, listener) { listeners.get(name)?.delete(listener); }, emit(name, detail) { for (const listener of [...listeners.get(name) || []]) listener({ type: name, detail }); }, get listenerCount() { return [...listeners.values()].reduce((sum, value) => sum + value.size, 0); } };
}
function lifecycleRenderer() {
  const base = hookRenderer(), cleanups = new Set();
  return { ...base, react: { ...base.react, useEffect(callback, dependencies) { base.react.useEffect(() => { const cleanup = callback(); if (cleanup) cleanups.add(cleanup); return () => { cleanups.delete(cleanup); cleanup?.(); }; }, dependencies); } }, unmount() { for (const cleanup of cleanups) cleanup(); cleanups.clear(); } };
}
function harness({ response = () => snapshot(), admin = true, loading = false, hidden = false, locale = "en" } = {}) {
  const renderer = lifecycleRenderer(), browser = target(), document = target({ visibilityState: hidden ? "hidden" : "visible" }), requests = [], intervals = new Map();
  let nextTimer = 0, isAdmin = admin, isLoading = loading, clubTag = "#CLUB";
  const { translate } = loadTypeScript("src/lib/i18n/messages.ts");
  const i18n = componentMocks["@/components/locale-provider"].useI18n();
  const { MegaPigSourcePanel } = loadTypeScript("src/components/mega-pig-source-panel.tsx", { ...componentMocks, react: renderer.react,
    "@/components/locale-provider": { useI18n: () => ({ ...i18n, t: (key, values) => translate(key, locale, values) }) },
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin, isLoading }) },
    "@/lib/store": { useAppStore: selector => selector({ clubTag }) },
    "@/lib/client-fetch": { fetchJsonWithTimeout(url, options = {}) { const request = { url, ...options }; requests.push(request); return Promise.resolve().then(() => response(request, requests)); } },
  }, { window: browser, document, setInterval(callback, delay) { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id; }, clearInterval(id) { intervals.delete(id); } });
  return { requests, browser, document, intervals, session(admin, loading = false) { isAdmin = admin; isLoading = loading; browser.emit("admin-session-changed"); }, club(tag, announce = true) { clubTag = tag; if (announce) browser.emit("club-data-updated", { clubChanged: true }); }, tick() { for (const interval of [...intervals.values()]) interval.callback(); }, unmount: renderer.unmount, render: () => renderer.render(MegaPigSourcePanel) };
}
const memberRows = tree => elements(tree).filter(node => node.type === "tbody").map(textContent).join("");

test("Mega Pig source reads only the app cache, polls visibly, coalesces in-flight reads, and cleans up", async () => {
  const pending = deferred();
  const page = harness({ hidden: true, response: (_, requests) => requests.length === 1 ? pending.promise : snapshot() });
  await page.render(); page.tick(); page.browser.emit("focus"); await page.render(); assert.equal(page.requests.length, 0);
  page.document.visibilityState = "visible"; page.document.emit("visibilitychange"); let tree = await page.render(); assert.equal(page.requests.length, 1);
  page.tick(); page.browser.emit("focus"); page.browser.emit("club-data-updated"); await page.render(); assert.equal(page.requests.length, 1, "events do not duplicate a pending read");
  pending.resolve(snapshot()); tree = await page.render(); assert.match(textContent(tree), /Reported total wins82/);
  assert.deepEqual([...page.intervals.values()].map(row => row.delay), [120000]); page.tick(); await page.render(); assert.equal(page.requests.length, 2);
  page.document.visibilityState = "hidden"; page.tick(); page.browser.emit("focus"); page.browser.emit("club-data-updated"); await page.render(); assert.equal(page.requests.length, 2);
  page.document.visibilityState = "visible"; page.browser.emit("focus"); tree = await page.render(); assert.equal(page.requests.length, 3);
  action(tree, "Refresh")(); await page.render(); assert.equal(page.requests.length, 4);
  assert.ok(page.requests.every(request => request.url === "/api/mega-pig-source" && !request.method && !request.body && request.cache === "no-store" && request.signal));
  page.unmount(); assert.equal(page.intervals.size, 0); assert.equal(page.browser.listenerCount, 0); assert.equal(page.document.listenerCount, 0);
  for (const state of [{ admin: false }, { admin: true, loading: true }]) { const anonymous = harness(state); assert.equal(await anonymous.render(), null); assert.equal(anonymous.requests.length, 0); anonymous.unmount(); }
});

test("reported zero remains zero, missing counters stay unknown, and details are collapsed without attendance claims", async () => {
  const page = harness({ response: () => snapshot({ members: [member({ playerName: "<c3>Amine</c> ✨" })] }) });
  const tree = await page.render(); assert.match(textContent(tree), /Players reported by source24/); assert.match(textContent(tree), /does not identify the cycle or when its counters changed/);
  assert.match(textContent(tree), /do not record attendance or affect member comparison/);
  assert.match(memberRows(tree), /Amine ✨#AAA0Unknown/); assert.doesNotMatch(memberRows(tree), /<c3>|Absent|Present/);
  const details = elements(tree).find(node => node.type === "details"); assert.equal(details.props.open, undefined);
  assert.ok(elements(details).some(node => node.type === "table")); assert.ok(elements(details).some(node => node.type === "bdi" && node.props.dir === "ltr"));
  const link = elements(details).find(node => node.type === "a"); assert.equal(link.props.href, "https://brawlace.com/clubs/CLUB"); assert.match(link.props.rel, /noopener/);
  assert.equal(elements(tree).filter(node => ["Input", "input", "textarea", "select", "form"].includes(node.type)).length, 0);
  assert.match(textContent(tree), /Last fetched from source: 2026-09-17T12:00:00Z/); assert.match(textContent(details), /does not force a provider update/); page.unmount();
});

test("source roster differences are disclosed rather than treating unmatched current members as absent", async () => {
  const page = harness({ response: () => snapshot({ matchedMembers: 1, sourceMembers: 3, rosterMembers: 2, members: [member(), member({ playerTag: "#BBB", playerName: "New player", reportedWins: null, reportedTicketsRemaining: null })] }) });
  const tree = await page.render(); assert.match(textContent(tree), /Matched 1 of 2 current members/); assert.match(textContent(tree), /source lists 3 members; 1 match/);
  assert.match(memberRows(tree), /New player#BBBUnknownUnknown/); assert.doesNotMatch(memberRows(tree), /Absent|0UnknownUnknown/); page.unmount();
});

test("all thirty identities can match while two members have unknown counters without a roster mismatch warning", async () => {
  const members = Array.from({ length: 30 }, (_, index) => member({ playerTag: `#P${index}`, playerName: `Player ${index}`, reportedWins: index < 10 ? 4 : index < 24 ? 3 : index < 28 ? 0 : null, reportedTicketsRemaining: index < 28 ? 0 : null }));
  const page = harness({ response: () => snapshot({ members, matchedMembers: 30, sourceMembers: 30, rosterMembers: 30 }) });
  const tree = await page.render(), details = elements(tree).find(node => node.type === "details");
  assert.match(textContent(details), /source lists 30 members; 30 match/);
  assert.match(textContent(details), /Matching a member does not mean their wins or tickets are available/);
  assert.equal((memberRows(tree).match(/Unknown/g) || []).length, 4);
  assert.match(memberRows(tree), /Player 2400|Player 24#P2400/);
  assert.match(textContent(tree), /Reported total wins82/); assert.match(textContent(tree), /Players reported by source24/);
  assert.doesNotMatch(textContent(tree), /Matched 30 of 30 current members/); assert.equal(details.props.open, undefined); page.unmount();
  const known = harness({ response: () => snapshot({ members: [member({ reportedTicketsRemaining: 0 })] }) });
  assert.doesNotMatch(textContent(await known.render()), /Matching a member does not mean/); known.unmount();
});

test("pending and unavailable source states do not display stale supplied totals, while stale data is labelled", async () => {
  for (const status of ["pending", "unavailable", "stale"]) {
    const page = harness({ response: () => snapshot({ status }) }); const tree = await page.render();
    if (status === "stale") { assert.match(textContent(tree), /Reported total wins82/); assert.match(textContent(tree), /saved counters; the source refresh is delayed/); }
    else { assert.doesNotMatch(textContent(tree), /Reported total wins82/); assert.equal(memberRows(tree), ""); assert.match(textContent(tree), status === "pending" ? /source is being checked/ : /counters are unavailable/); }
    page.unmount();
  }
});

test("logout and a new admin session cannot reuse or reveal an old pending private response", async () => {
  const old = deferred(), fresh = deferred(); let reads = 0;
  const page = harness({ response: () => ++reads === 1 ? snapshot({ members: [member({ playerName: "Private previous user" })] }) : reads === 2 ? old.promise : fresh.promise });
  let tree = await page.render(); assert.match(memberRows(tree), /Private previous user/); action(tree, "Refresh")(); await page.render();
  page.session(false); assert.equal(await page.render(), null); assert.equal(page.requests[1].signal.aborted, true); assert.equal(page.intervals.size, 0);
  page.session(true); tree = await page.render(); assert.equal(memberRows(tree), ""); old.resolve(snapshot({ members: [member({ playerName: "Late old user" })] })); tree = await page.render(); assert.doesNotMatch(textContent(tree), /Late old user|Private previous user/);
  fresh.resolve(snapshot({ members: [member({ playerName: "Current session" })] })); tree = await page.render(); assert.match(memberRows(tree), /Current session/); page.unmount();
});

test("club keys hide old data immediately and reject a response for another club", async () => {
  const pending = deferred(); let reads = 0;
  const page = harness({ response: () => ++reads === 1 ? snapshot({ members: [member({ playerName: "Old club player" })] }) : pending.promise });
  let tree = await page.render(); assert.match(memberRows(tree), /Old club player/);
  page.club("#NEW", false); tree = await page.render(); assert.equal(memberRows(tree), "");
  pending.resolve(snapshot()); tree = await page.render(); assert.equal(memberRows(tree), ""); assert.match(textContent(tree), /counters are unavailable/); page.unmount();
  const delayed = deferred(), changed = harness({ response: () => delayed.promise }); await changed.render(); changed.club("#OTHER"); await changed.render(); assert.equal(changed.requests[0].signal.aborted, true);
  changed.unmount(); delayed.resolve(snapshot({ members: [member({ playerName: "Late club response" })] })); await new Promise(resolve => setImmediate(resolve)); assert.ok(changed.requests.every(request => request.signal.aborted));
});

test("malformed counts and failed refreshes cannot keep presenting the previous result as current", async () => {
  let fail = false;
  const page = harness({ response: () => fail ? Promise.reject(new Error("Unavailable")) : snapshot() });
  let tree = await page.render(); fail = true; action(tree, "Refresh")(); tree = await page.render(); assert.match(textContent(tree), /counters are unavailable/); assert.equal(memberRows(tree), "");
  assert.equal(elements(tree).find(node => node.type === "Button").props.disabled, false); page.unmount();
  for (const value of [snapshot({ totalWins: -1 }), snapshot({ members: [member({ reportedTicketsRemaining: "0" })] })]) { const bad = harness({ response: () => value }); assert.match(textContent(await bad.render()), /counters are unavailable/); bad.unmount(); }
});

test("source panel is available without a planned cycle only in the admin Events overview", async () => {
  for (const isAdmin of [true, false]) {
    const renderer = lifecycleRenderer(), browser = target();
    const { PlanningWorkspace } = loadTypeScript("src/app/club-planning/page.tsx", { ...componentMocks, react: renderer.react,
      "@/components/mega-pig-source-panel": { MegaPigSourcePanel: "MegaPigSourcePanel" },
      "@/components/club-event-editor": { ClubEventEditor: "EventEditor" },
      "@/lib/club-planning-client": { eventKindLabels: {}, usePlanningResource: () => ({ data: { events: [], roster: [] }, error: null, loading: false, reload: async () => true }) },
    }, { window: browser });
    const render = () => renderer.render(() => PlanningWorkspace({ isAdmin })); let tree = await render(); assert.equal(elements(tree).some(node => node.type === "MegaPigSourcePanel"), isAdmin);
    assert.doesNotMatch(textContent(tree), /Optional goals|Create goal/);
    assert.match(textContent(tree), /No club events have been planned yet/);
    if (isAdmin) { action(tree, "Plan event")(); tree = await render(); assert.equal(elements(tree).some(node => node.type === "MegaPigSourcePanel"), false); elements(tree).find(node => node.type === "EventEditor").props.onCancel(); tree = await render(); assert.ok(elements(tree).some(node => node.type === "MegaPigSourcePanel")); }
    renderer.unmount();
  }
});

test("member-history deep links select the private player archive and show the guest sign-in gate", async () => {
  for (const [search, expected] of [["?member=%20%23pylq%20", "#PYLQ"], ["?member=bad%20tag", ""], ["", ""]]) {
    for (const isAdmin of [true, false]) {
      const renderer = lifecycleRenderer(), browser = target(), scrolls = [];
      const { PlanningWorkspace, PlanningEntry } = loadTypeScript("src/app/club-planning/page.tsx", { ...componentMocks, react: renderer.react,
        "next/navigation": { useSearchParams: () => new URLSearchParams(search) },
        "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin, isLoading: false }) },
        "@/components/mega-pig-source-panel": { MegaPigSourcePanel: "MegaPigSourcePanel" },
        "@/components/mega-pig-archive-panel": { MegaPigArchivePanel: "MegaPigArchivePanel" },
        "@/lib/club-planning-client": { eventKindLabels: {}, usePlanningResource: () => ({ data: { events: [], roster: [] }, error: null, loading: false, reload: async () => true }) },
      }, { window: browser, document: { getElementById(id) { return { scrollIntoView(options) { scrolls.push({ id, block: options.block }); } }; } } });
      const entry = PlanningEntry();
      assert.equal(entry.key, `${isAdmin ? "admin" : "public"}:${expected}`);
      const tree = await renderer.render(() => PlanningWorkspace(entry.props));
      const archive = elements(tree).find(node => node.type === "MegaPigArchivePanel");
      assert.equal(Boolean(archive), isAdmin);
      if (isAdmin) assert.equal(archive.props.initialPlayerTag, expected);
      else assert.equal(elements(tree).find(node => node.props?.id === "planning-admin").props.open, Boolean(expected));
      assert.deepEqual(scrolls, isAdmin && expected ? [{ id: "mega-pig-history", block: "start" }] : []);
      renderer.unmount();
    }
  }
});

test("the Arabic source panel translates the counters, provenance and unknown member values", async () => {
  const page = harness({ locale: "ar" }); const tree = await page.render(); assert.match(textContent(tree), /عدادات Mega Pig/); assert.match(textContent(tree), /مصدر خارجي/); assert.match(textContent(tree), /إجمالي الانتصارات بحسب المصدر/);
  assert.doesNotMatch(textContent(tree), /Reported total wins|Players reported by source|Unknown|Last fetched/); assert.match(textContent(tree), /لا تسجّل الحضور ولا تؤثر/); page.unmount();
  assert.match(textContent(tree), /مطابقة العضو لا تعني توفر/);
});

test("the community-rule stage estimate handles stage boundaries and never confirms reward receipt", async () => {
  for (const [totalWins, stage] of [[64, "4/5"], [79, "4/5"], [80, "5/5"], [null, "Unknown"]]) {
    const page = harness({ response: () => snapshot({ totalWins }) }); const tree = await page.render();
    assert.ok(textContent(tree).includes(`Estimated stage: ${stage}`)); assert.match(textContent(tree), /Based on 16 wins per stage/);
    assert.equal(textContent(tree).includes("Target reached by this estimate"), totalWins === 80); assert.doesNotMatch(textContent(tree), /Reward received/);
    assert.match(textContent(tree), /does not identify the cycle/); page.unmount();
  }
});
