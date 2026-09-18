const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, action } = require("./helpers/client-renderer.cjs");

const EVENT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const observedMember = (values = {}) => ({ playerTag: "#AAA", playerName: "Amine", observedBattles: 0, lastObservedBattleAt: null,
  explicitMegaPigBattles: 0, lastExplicitMegaPigBattleAt: null, authoritativeWins: null, ticketsRemaining: null,
  coverage: { baselineAt: null, checkedAt: null, status: "unknown", possibleGap: false }, ...values });
const observation = (values = {}) => ({ clubTag: "#CLUB", eventId: EVENT, eventVersion: 2, status: "planned",
  startsAt: "2026-09-17T09:00:00Z", endsAt: "2026-09-19T09:00:00Z", observedUntil: "2026-09-17T12:00:00Z", generatedAt: "2026-09-17T12:00:00Z",
  hasStarted: true, historyLimited: true, classification: "explicit_battle_type_only", sync: { lastFullSyncAt: null, lastBattleSyncAt: null, stale: true },
  members: [observedMember()], ...values });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function target(extra = {}) {
  const listeners = new Map();
  return { ...extra, addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); }, removeEventListener(name, listener) { listeners.get(name)?.delete(listener); }, emit(name, detail) { for (const listener of [...listeners.get(name) || []]) listener({ type: name, detail }); }, get listenerCount() { return [...listeners.values()].reduce((sum, value) => sum + value.size, 0); } };
}
function lifecycleRenderer() {
  const base = hookRenderer(), cleanups = new Set();
  return { ...base, react: { ...base.react, useEffect(callback, dependencies) { base.react.useEffect(() => { const cleanup = callback(); if (cleanup) cleanups.add(cleanup); return () => { cleanups.delete(cleanup); cleanup?.(); }; }, dependencies); } }, unmount() { for (const cleanup of cleanups) cleanup(); cleanups.clear(); } };
}
function harness({ response = () => observation(), admin = true, loading = false, hidden = false } = {}) {
  const renderer = lifecycleRenderer(), browser = target(), document = target({ visibilityState: hidden ? "hidden" : "visible" }), requests = [], intervals = new Map();
  let nextTimer = 0, isAdmin = admin, isLoading = loading, props = { eventId: EVENT, version: 2 };
  const { ClubEventObservationsPanel } = loadTypeScript("src/components/club-event-observations.tsx", { ...componentMocks, react: renderer.react,
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin, isLoading }) },
    "@/lib/client-fetch": { fetchJsonWithTimeout(url, options = {}) { const request = { url, ...options }; requests.push(request); return Promise.resolve().then(() => response(request, requests)); } },
  }, { window: browser, document, setInterval(callback, delay) { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id; }, clearInterval(id) { intervals.delete(id); } });
  return { requests, browser, document, intervals, setProps(next) { props = { ...props, ...next }; }, session(admin, loading = false) { isAdmin = admin; isLoading = loading; browser.emit("admin-session-changed"); }, tick() { for (const interval of [...intervals.values()]) interval.callback(); }, unmount: renderer.unmount, render: () => renderer.render(() => ClubEventObservationsPanel(props)) };
}
const rowText = tree => elements(tree).filter(node => node.type === "li").map(textContent).join(" ");

test("event observations poll saved data only while visible and authenticated, without game refresh requests", async () => {
  const page = harness({ hidden: true }); let tree = await page.render(); assert.equal(page.requests.length, 0);
  page.tick(); await page.render(); assert.equal(page.requests.length, 0);
  page.document.visibilityState = "visible"; page.document.emit("visibilitychange"); tree = await page.render(); assert.equal(page.requests.length, 1);
  assert.match(textContent(tree), /Activity observed for 0 of 1 saved event members/);
  assert.deepEqual([...page.intervals.values()].map(row => row.delay), [120000]); page.tick(); await page.render(); assert.equal(page.requests.length, 2);
  page.document.visibilityState = "hidden"; page.tick(); page.browser.emit("focus"); page.browser.emit("club-data-updated"); await page.render(); assert.equal(page.requests.length, 2);
  assert.ok(page.requests.every(request => request.url === `/api/club-event-observations?event=${EVENT}&version=2` && !request.method && request.cache === "no-store" && request.signal));
  page.unmount(); assert.equal(page.intervals.size, 0); assert.equal(page.browser.listenerCount, 0); assert.equal(page.document.listenerCount, 0);
  for (const state of [{ admin: false }, { admin: true, loading: true }]) { const anonymous = harness(state); assert.equal(await anonymous.render(), null); assert.equal(anonymous.requests.length, 0); anonymous.unmount(); }
});

test("changing event or revision aborts the old read and cannot show another saved event's results", async () => {
  const first = deferred(), second = deferred(), third = deferred();
  const page = harness({ response: (_, requests) => requests.length === 1 ? first.promise : requests.length === 2 ? second.promise : third.promise });
  await page.render(); page.setProps({ eventId: OTHER, version: 3 }); let tree = await page.render(); assert.equal(page.requests[0].signal.aborted, true);
  first.resolve(observation({ members: [observedMember({ playerName: "Old private name", observedBattles: 10 })] })); tree = await page.render(); assert.doesNotMatch(textContent(tree), /Old private name/);
  second.resolve(observation({ eventId: OTHER, eventVersion: 3, members: [observedMember({ playerName: "New event", observedBattles: 4 })] })); tree = await page.render(); assert.match(rowText(tree), /New event/);
  page.setProps({ version: 4 }); tree = await page.render(); assert.equal(page.requests[1].signal.aborted, true); assert.doesNotMatch(rowText(tree), /New event/);
  third.resolve(observation({ eventId: OTHER, eventVersion: 3 })); tree = await page.render(); assert.match(textContent(tree), /Event observations are unavailable/); assert.equal(rowText(tree), ""); page.unmount();
});

test("changing the observation draft pauses reads and ignores old results until saved dates and members are restored", async () => {
  const pending = deferred(); let reads = 0;
  const page = harness({ response: () => ++reads === 1 ? pending.promise : observation() }); await page.render();
  page.setProps({ draftChanged: true }); let tree = await page.render(); assert.equal(page.requests[0].signal.aborted, true); assert.equal(page.intervals.size, 0);
  assert.match(textContent(tree), /Save the event dates and members/); assert.equal(elements(tree).some(node => node.type === "Button" && textContent(node) === "Refresh"), false);
  pending.resolve(observation({ members: [observedMember({ playerName: "Wrong draft", observedBattles: 9 })] })); page.tick(); tree = await page.render(); assert.doesNotMatch(textContent(tree), /Wrong draft/); assert.equal(page.requests.length, 1);
  page.setProps({ draftChanged: false }); tree = await page.render(); assert.equal(page.requests.length, 2); assert.match(rowText(tree), /Amine/); page.unmount();
});

test("auth and club boundaries flush private results and abort both existing and future late responses", async () => {
  for (const boundary of ["logout", "club"]) {
    const pending = deferred(); let reads = 0;
    const page = harness({ response: () => ++reads === 1 ? observation({ members: [observedMember({ playerName: "Private old member" })] }) : pending.promise });
    let tree = await page.render(); assert.match(rowText(tree), /Private old member/); action(tree, "Refresh")(); await page.render();
    if (boundary === "logout") page.session(false); else page.browser.emit("club-data-updated", { clubChanged: true });
    tree = await page.render(); assert.equal(page.requests[1].signal.aborted, true); assert.doesNotMatch(textContent(tree), /Private old member/);
    page.unmount(); pending.resolve(observation({ members: [observedMember({ playerName: "Late private response" })] })); await new Promise(resolve => setImmediate(resolve));
    assert.ok(page.requests.every(request => request.signal.aborted)); assert.equal(page.intervals.size, 0);
  }
});

test("zero observations mean unknown attendance and explicit mode markers never become official wins or tickets", async () => {
  const page = harness({ response: () => observation({ members: [observedMember(), observedMember({ playerTag: "#BBB", playerName: "Bilel", observedBattles: 5, lastObservedBattleAt: "2026-09-17T11:00:00Z", explicitMegaPigBattles: 2 })] }) });
  const tree = await page.render(); assert.match(textContent(tree), /Activity observed for 1 of 2 saved event members/);
  assert.match(rowText(tree), /No battles observed; attendance is unknown/); assert.match(rowText(tree), /5 recorded player results/); assert.match(rowText(tree), /2 results explicitly labelled Mega Pig/);
  assert.match(textContent(tree), /official contribution totals unavailable/); assert.match(textContent(tree), /Wins and tickets must be confirmed separately/); assert.match(textContent(tree), /Missing battles do not prove absence or affect member comparisons/);
  assert.match(textContent(tree), /Battle data checked: Unknown.*Refresh delayed/); assert.equal(elements(tree).filter(node => ["Input", "select", "textarea", "form"].includes(node.type)).length, 0);
  assert.doesNotMatch(rowText(tree), /Absent|Present|wins: 0|tickets: 0/); page.unmount();
});

test("a future event explains when monitoring starts instead of presenting zero activity as a current result", async () => {
  const page = harness({ response: () => observation({ hasStarted: false }) }); const tree = await page.render();
  assert.match(textContent(tree), /Observation starts at the saved event start time/); assert.doesNotMatch(textContent(tree), /Activity observed for 0/); assert.equal(rowText(tree), ""); page.unmount();
});

test("failed observation refresh removes outdated counts while keeping a usable retry", async () => {
  let fail = false;
  const page = harness({ response: () => fail ? Promise.reject(new Error("Unavailable")) : observation({ members: [observedMember({ observedBattles: 9 })] }) });
  let tree = await page.render(); assert.match(rowText(tree), /9 recorded/); fail = true; action(tree, "Refresh")(); tree = await page.render();
  assert.match(textContent(tree), /Event observations are unavailable/); assert.equal(rowText(tree), ""); assert.equal(elements(tree).find(node => node.type === "Button" && textContent(node) === "Refresh").props.disabled, false); page.unmount();
});

const event = (values = {}) => ({ id: EVENT, version: 2, title: "Mega Pig edition", kind: "mega_pig", cycleLabel: "Current edition", startsAt: "2026-09-17T09:00:00Z", endsAt: "2026-09-19T09:00:00Z", teamSize: 3, ticketAllowance: null, status: "planned", notes: "Private event draft", updatedAt: "2026-09-17T08:00:00Z", ...values });
const entry = (values = {}) => ({ playerTag: "#AAA", playerName: "Amine", team: 1, slot: "starter", attendance: "invited", wins: null, ticketsRemaining: null, observedAt: null, notes: "", ...values });
function editorHarness({ savedEvent = event(), entries = [entry()], roster = [{ tag: "#AAA", name: "Amine" }, { tag: "#BBB", name: "Bilel" }] } = {}) {
  const renderer = lifecycleRenderer(), saves = [];
  const client = loadTypeScript("src/lib/club-planning-client.ts", { react: renderer.react });
  const { ClubEventEditor } = loadTypeScript("src/components/club-event-editor.tsx", { ...componentMocks, react: renderer.react,
    "@/components/club-event-observations": { ClubEventObservationsPanel: "ObservationsPanel" },
    "@/lib/club-planning-client": { ...client, usePlanningMutation: () => ({ busy: false, error: "", save: async value => { saves.push(value); } }) },
  });
  return { saves, render: () => renderer.render(() => ClubEventEditor({ event: savedEvent, data: { goals: [], events: savedEvent ? [savedEvent] : [], roster, ...(savedEvent ? { eventDetail: { id: savedEvent.id, entries, revisions: [] } } : {}) }, onSaved() {}, onCancel() {} })) };
}
function input(tree, label) { const wrapper = elements(tree).find(node => node.type === "label" && textContent(node).startsWith(label)); return elements(wrapper).find(node => ["Input", "select", "textarea"].includes(node.type)); }
const panel = tree => elements(tree).find(node => node.type === "ObservationsPanel");

test("only saved active Mega Pig events mount observations and changing dates, status or member list pauses them", async () => {
  for (const savedEvent of [null, event({ kind: "ranked" }), event({ status: "cancelled" })]) { const editor = editorHarness({ savedEvent }); assert.equal(panel(await editor.render()), undefined); }
  const editor = editorHarness(); let tree = await editor.render(); assert.deepEqual(JSON.parse(JSON.stringify(panel(tree).props)), { eventId: EVENT, version: 2, draftChanged: false });
  input(tree, "Private event notes").props.onChange({ target: { value: "Unsaved private note" } }); tree = await editor.render(); assert.equal(panel(tree).props.draftChanged, false);
  input(tree, "Starts at").props.onChange({ target: { value: "2026-09-17T11:00" } }); tree = await editor.render(); assert.equal(panel(tree).props.draftChanged, true);
  assert.equal(editor.saves.length, 0);
  const members = editorHarness(); tree = await members.render(); action(tree, "Add remaining club members")(); tree = await members.render(); assert.equal(panel(tree).props.draftChanged, true);
  const status = editorHarness(); tree = await status.render(); input(tree, "Status").props.onChange({ target: { value: "completed" } }); tree = await status.render(); assert.equal(panel(tree).props.draftChanged, true);
});

test("adding remaining members respects thirty entries and team capacity while preserving saved manual zeroes and private drafts", async () => {
  const original = entry({ playerTag: "#FORMER", playerName: "Former member", team: 2, slot: "substitute", attendance: "present", wins: 0, ticketsRemaining: null, observedAt: "2026-09-17T10:00:00Z", notes: "Saved private context" });
  const editor = editorHarness({ savedEvent: event({ teamSize: 2 }), entries: [original, entry({ playerTag: "#STARTER", playerName: "Existing starter" })], roster: Array.from({ length: 30 }, (_, index) => ({ tag: `#P${index}`, name: `Player ${index}` })) });
  let tree = await editor.render(); input(tree, "Private member note").props.onChange({ target: { value: "Draft preserved through bulk add" } }); tree = await editor.render();
  action(tree, "Add remaining club members")(); tree = await editor.render(); assert.equal(panel(tree).props.draftChanged, true);
  assert.equal(input(tree, "Manual wins").props.value, 0); assert.equal(input(tree, "Manual tickets remaining").props.value, "");
  assert.equal(input(tree, "Private member note").props.value, "Draft preserved through bulk add"); assert.equal(editor.saves.length, 0);
  elements(tree).find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await editor.render(); const payload = editor.saves[0];
  assert.equal(payload.version, 2); assert.equal(payload.entries.length, 30); assert.equal(new Set(payload.entries.map(row => row.playerTag)).size, 30);
  const retained = payload.entries.find(row => row.playerTag === "#FORMER"); assert.equal(retained.attendance, "present"); assert.equal(retained.wins, 0); assert.equal(retained.ticketsRemaining, null); assert.equal(retained.notes, "Draft preserved through bulk add"); assert.equal(retained.team, 2); assert.equal(retained.slot, "substitute");
  const added = payload.entries.filter(row => !["#FORMER", "#STARTER"].includes(row.playerTag)); assert.ok(added.every(row => row.attendance === "invited" && row.wins === null && row.ticketsRemaining === null && row.observedAt === null));
  for (const team of new Set(payload.entries.map(row => row.team))) assert.ok(payload.entries.filter(row => row.team === team && row.slot === "starter").length <= 2);
});

test("automatic observation refresh does not edit or save a manual attendance and results draft", async () => {
  const editor = editorHarness(); let tree = await editor.render();
  input(tree, "Manual attendance").props.onChange({ target: { value: "absent" } }); tree = await editor.render();
  input(tree, "Manual wins").props.onChange({ target: { value: "0" } }); tree = await editor.render();
  input(tree, "Private member note").props.onChange({ target: { value: "Keep manual judgment separate" } }); tree = await editor.render(); assert.equal(panel(tree).props.draftChanged, false);
  const observations = harness({ response: () => observation({ members: [observedMember({ observedBattles: 8, explicitMegaPigBattles: 2 })] }) });
  observations.setProps(panel(tree).props); let observed = await observations.render(); action(observed, "Refresh")(); observed = await observations.render(); assert.match(rowText(observed), /8 recorded/);
  tree = await editor.render(); assert.equal(input(tree, "Manual attendance").props.value, "absent"); assert.equal(input(tree, "Manual wins").props.value, 0); assert.equal(input(tree, "Manual tickets remaining").props.value, ""); assert.equal(input(tree, "Private member note").props.value, "Keep manual judgment separate"); assert.equal(editor.saves.length, 0);
  assert.ok(observations.requests.every(request => !request.method && !request.body)); observations.unmount();
});
