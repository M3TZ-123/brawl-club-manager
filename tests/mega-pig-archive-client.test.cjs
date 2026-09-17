const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, action } = require("./helpers/client-renderer.cjs");
const ID = "00000000-0000-4000-8000-000000000001", READING = "00000000-0000-4000-8000-000000000002", NEW = "00000000-0000-4000-8000-000000000003";
const NOW = Date.parse("2026-09-17T12:00:00Z");
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
const cycle = (values = {}) => ({ id: ID, title: "Saved September cycle", startsAt: "2026-09-17T09:00:00Z", endsAt: "2026-09-17T11:00:00Z", milestones: [16, 32, 48, 64, 80], version: 3, createdAt: "2026-09-17T08:00:00Z", updatedAt: "2026-09-17T10:00:00Z", captureEnabled: true, capturePausedReason: null, initialObservationId: READING, lastCapturedAt: "2026-09-17T10:30:00Z", reportedTotalWins: 64, reportedPlayersPlayed: 24, finalTotalWins: null, confirmedStage: null, rewardStatus: "unknown", finalizedAt: null, notes: "Private draft", ...values });
const reading = (values = {}) => ({ id: READING, firstFetchedAt: "2026-09-17T09:00:00Z", lastFetchedAt: "2026-09-17T10:00:00Z", totalWins: 64, reportedPlayersPlayed: 24, sourceMembers: 30, unknownMembers: 2, ...values });
const member = (values = {}) => ({ playerTag: "#PYLQ", playerName: "Former name", isCurrentMember: false, firstObservedAt: "2026-09-17T09:00:00Z", lastObservedAt: "2026-09-17T10:00:00Z", wins: 0, ticketsRemaining: 2, winsObservedAt: "2026-09-17T09:30:00Z", ticketsObservedAt: "2026-09-17T09:00:00Z", latestWinsUnknown: true, latestTicketsUnknown: false, ...values });
const sourceMember = (values = {}) => ({ playerTag: "#PYLQ", playerName: "Old source name", reportedWins: 0, reportedTicketsRemaining: null, ...values });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function target(extra = {}) { const listeners = new Map(); return { ...extra, addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); }, removeEventListener(name, callback) { listeners.get(name)?.delete(callback); }, emit(name, detail) { for (const callback of [...listeners.get(name) || []]) callback({ type: name, detail }); }, get listenerCount() { return [...listeners.values()].reduce((sum, list) => sum + list.size, 0); } }; }
function lifecycleRenderer() { const renderer = hookRenderer(), cleanups = new Set(); return { ...renderer, react: { ...renderer.react, useEffect(callback, dependencies) { renderer.react.useEffect(() => { const cleanup = callback(); if (cleanup) cleanups.add(cleanup); return () => { cleanups.delete(cleanup); cleanup?.(); }; }, dependencies); } }, unmount() { for (const cleanup of cleanups) cleanup(); cleanups.clear(); } }; }
function harness({ component = "MegaPigArchivePanel", props = {}, response, admin = true, hidden = false, locale = "en" } = {}) {
  const renderer = lifecycleRenderer(), browser = target(), document = target({ visibilityState: hidden ? "hidden" : "visible" }), requests = [], timers = new Map(), intervals = new Map();
  let serial = 0, isAdmin = admin, isLoading = false, clubTag = "#PYLQ", currentProps = props;
  const { translate } = loadTypeScript("src/lib/i18n/messages.ts"), i18n = componentMocks["@/components/locale-provider"].useI18n();
  const exported = loadTypeScript("src/components/mega-pig-archive-panel.tsx", { ...componentMocks, react: renderer.react,
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin, isLoading }) }, "@/lib/store": { useAppStore: select => select({ clubTag }) },
    "@/components/locale-provider": { useI18n: () => ({ ...i18n, t: (key, values) => translate(key, locale, values) }) },
  }, { window: browser, document, Date: FixedDate, crypto: { randomUUID }, setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval(callback, delay) { const id = ++serial; intervals.set(id, { callback, delay }); return id; }, clearInterval(id) { intervals.delete(id); }, fetch(url, init = {}) {
    const request = { url, ...init, payload: init.body ? JSON.parse(init.body) : null }; requests.push(request);
    return Promise.resolve().then(() => response ? response(request, requests) : init.method ? { id: ID, version: 4, replayed: false } : { clubTag, cycles: [cycle()], nextOffset: null, latestObservation: reading() }).then(value => value instanceof Response ? value : Response.json(value));
  } });
  return { browser, document, requests, timers, intervals, props(next) { currentProps = { ...currentProps, ...next }; }, session(value, loading = false) { isAdmin = value; isLoading = loading; browser.emit("admin-session-changed"); }, club(tag) { clubTag = tag; browser.emit("club-data-updated", { clubChanged: true }); }, tick() { for (const timer of [...intervals.values()]) timer.callback(); }, expire() { for (const timer of [...timers.values()]) timer.callback(); }, unmount: renderer.unmount, render: () => renderer.render(() => exported[component](currentProps)) };
}
const named = (tree, name) => elements(tree).filter(node => node.type?.name === name || node.type === name);
const errorText = tree => named(tree, "FormError").map(node => node.props.error).join(" ");
function input(tree, label) { const wrapper = elements(tree).find(node => node.type === "label" && textContent(node).startsWith(label)); assert.ok(wrapper, `Missing ${label}`); return elements(wrapper).find(node => ["Input", "input", "textarea", "select"].includes(node.type)); }
const submit = tree => elements(tree).find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
const change = (tree, label, value) => input(tree, label).props.onChange({ target: { value, checked: value } });
async function fillNew(form) { let tree = await form.render(); change(tree, "Cycle title", "September round"); tree = await form.render(); change(tree, "Starts at", "2026-09-17T09:00"); tree = await form.render(); change(tree, "Ends at", "2026-09-18T09:00"); return form.render(); }

test("archive reads only private app data while visible and aborts old navigation, club and session responses", async () => {
  const pending = deferred(); const page = harness({ hidden: true, response: () => pending.promise }); await page.render(); page.tick(); assert.equal(page.requests.length, 0);
  page.document.visibilityState = "visible"; page.document.emit("visibilitychange"); let tree = await page.render(); assert.equal(page.requests.length, 1);
  action(tree, "Saved readings")(); await page.render(); assert.equal(page.requests[0].signal.aborted, true); assert.match(page.requests[1].url, /mode=readings/);
  page.club("#GGRR"); await page.render(); assert.equal(page.requests[1].signal.aborted, true);
  page.session(false); assert.equal(await page.render(), null); assert.ok(page.requests.every(request => request.signal.aborted)); assert.equal(page.intervals.size, 0);
  pending.resolve({ clubTag: "#PYLQ", cycles: [cycle({ title: "Late private cycle" })], observations: [] }); await page.render();
  page.unmount(); assert.equal(page.browser.listenerCount, 0); assert.equal(page.document.listenerCount, 0); assert.equal(page.timers.size, 0);
  const anonymous = harness({ admin: false }); assert.equal(await anonymous.render(), null); assert.equal(anonymous.requests.length, 0); anonymous.unmount();
});

test("a member-history link opens that player's private archive without a search or mutation", async () => {
  const page = harness({ props: { initialPlayerTag: " pylq " }, response: request => {
    const params = new URL(request.url, "https://club.test").searchParams;
    return params.get("mode") === "player"
      ? { clubTag: "#PYLQ", playerTag: params.get("player"), history: [], playerReadings: [], nextOffset: null }
      : { clubTag: "#PYLQ", cycles: [], nextOffset: null };
  } });
  let tree = await page.render();
  assert.equal(page.requests.length, 1);
  assert.match(page.requests[0].url, /mode=player&player=%23PYLQ/);
  assert.equal(input(tree, "Find a member").props.value, "#PYLQ");
  assert.match(textContent(tree), /No saved cycle contributions for this tag yet/);
  assert.ok(page.requests.every(request => !request.method));
  action(tree, "Cycles")(); tree = await page.render();
  assert.match(textContent(tree), /No cycles yet/);
  assert.doesNotMatch(page.requests.at(-1).url, /mode=player/);
  page.unmount();
  const guest = harness({ props: { initialPlayerTag: "#PYLQ" }, admin: false });
  assert.equal(await guest.render(), null); assert.equal(guest.requests.length, 0); guest.unmount();
  const invalid = harness({ props: { initialPlayerTag: "not a tag" } });
  await invalid.render(); assert.doesNotMatch(invalid.requests[0].url, /player=/); invalid.unmount();
});

test("cycle member pagination appends retained former members and does not silently collapse on background polling", async () => {
  const page = harness({ response: request => {
    const url = new URL(request.url, "https://club.test");
    if (url.searchParams.get("mode") === "cycle") return { clubTag: "#PYLQ", cycle: cycle(), members: url.searchParams.get("offset") === "50" ? [member({ playerTag: "#GGRR", playerName: "Older former member" })] : Array.from({ length: 50 }, (_, index) => member({ playerTag: `#P${index}` })), nextOffset: url.searchParams.get("offset") === "50" ? null : 50 };
    return { clubTag: "#PYLQ", cycles: [cycle()], latestObservation: reading(), nextOffset: null };
  } });
  let tree = await page.render(); action(tree, "Open cycle")(); tree = await page.render(); assert.equal(named(tree, "MegaPigArchivedMember").length, 50); assert.match(textContent(tree), /Collection ended/); assert.doesNotMatch(textContent(tree), /Automatic collection enabled/);
  action(tree, "Load more")(); tree = await page.render(); assert.equal(named(tree, "MegaPigArchivedMember").length, 51); assert.match(page.requests.at(-1).url, /offset=50/);
  const count = page.requests.length; page.tick(); await page.render(); assert.equal(page.requests.length, count); page.unmount();
});

test("player lookup validates tags and appends both cycle contributions and independent source readings", async () => {
  const page = harness({ response: request => {
    const url = new URL(request.url, "https://club.test"), more = url.searchParams.get("offset") === "20";
    if (url.searchParams.get("mode") === "player") return { clubTag: "#PYLQ", playerTag: "#PYLQ", history: [{ cycle: cycle({ id: more ? NEW : ID }), member: member() }], playerReadings: [{ observation: reading({ id: more ? NEW : READING }), member: sourceMember({ playerName: more ? "Returning name" : "Original name" }) }], nextOffset: more ? null : 20 };
    return { clubTag: "#PYLQ", cycles: [], latestObservation: reading(), nextOffset: null };
  } });
  let tree = await page.render(); change(tree, "Find a member", "Amine"); tree = await page.render(); submit(tree); tree = await page.render(); assert.equal(page.requests.length, 1); assert.match(textContent(tree), /Enter a valid player tag/);
  change(tree, "Find a member", " pylq "); tree = await page.render(); submit(tree); tree = await page.render(); assert.match(page.requests.at(-1).url, /player=%23PYLQ/); assert.match(textContent(tree), /Original name/); assert.match(textContent(tree), /Tickets remaining: Unknown/);
  action(tree, "Load more")(); tree = await page.render(); assert.equal(named(tree, "MegaPigCycleSummary").length, 2); assert.match(textContent(tree), /Original name/); assert.match(textContent(tree), /Returning name/); assert.match(textContent(tree), /First fetched/); page.unmount();
});

test("saved readings work without cycle dates and open an explicit confirmation form", async () => {
  const page = harness({ response: request => {
    const mode = new URL(request.url, "https://club.test").searchParams.get("mode");
    return mode === "reading" ? { clubTag: "#PYLQ", observation: { ...reading(), members: [sourceMember()] } } : mode === "readings" ? { clubTag: "#PYLQ", observations: [reading()], nextOffset: null } : { clubTag: "#PYLQ", cycles: [], latestObservation: reading(), nextOffset: null };
  } });
  let tree = await page.render(); action(tree, "Saved readings")(); tree = await page.render(); action(tree, "Open saved reading")(); tree = await page.render();
  assert.match(page.requests.at(-1).url, new RegExp(`mode=reading&id=${READING}`)); assert.match(textContent(tree), /Old source name/); assert.equal(named(tree, "MegaPigCycleForm")[0].props.reading.id, READING); assert.ok(page.requests.every(request => !request.method)); page.unmount();
});

test("cycle creation leaves dates empty, labels editable preset and pins an explicitly confirmed reading across refresh", async () => {
  const saves = [], form = harness({ component: "MegaPigCycleForm", props: { reading: reading(), onSaved: id => saves.push(id) } });
  let tree = await form.render(); assert.equal(input(tree, "Starts at").props.value, ""); assert.equal(input(tree, "Ends at").props.value, ""); assert.match(textContent(tree), /community-reported rules, adjustable/);
  assert.equal(input(tree, "Collect future").props.disabled, true); assert.equal(input(tree, "Collect future").props.checked, false);
  tree = await fillNew(form); change(tree, "I confirm this reading", true); tree = await form.render(); form.props({ reading: reading({ id: NEW, totalWins: 80 }) }); tree = await form.render();
  submit(tree); await form.render(); const body = form.requests[0].payload; assert.equal(body.cycle.initialObservationId, READING); assert.equal(body.cycle.captureEnabled, true); assert.deepEqual(body.cycle.milestones, [16, 32, 48, 64, 80]); assert.match(body.requestId, /^[0-9a-f-]{36}$/); assert.deepEqual(saves, [ID]); form.unmount();
});

test("unknown targets and unconfirmed readings remain null; invalid partial stages cannot save", async () => {
  const form = harness({ component: "MegaPigCycleForm", props: { reading: reading(), onSaved() {} } }); let tree = await fillNew(form);
  action(tree, "Leave targets unknown")(); tree = await form.render(); submit(tree); await form.render(); assert.equal(form.requests[0].payload.cycle.milestones, null); assert.equal(form.requests[0].payload.cycle.initialObservationId, null); assert.equal(form.requests[0].payload.cycle.captureEnabled, false); form.unmount();
  const invalid = harness({ component: "MegaPigCycleForm", props: { reading: null, onSaved() {} } }); tree = await fillNew(invalid); change(tree, "Stage 1", ""); tree = await invalid.render(); submit(tree); tree = await invalid.render(); assert.match(errorText(tree), /Complete every stage/); assert.equal(invalid.requests.length, 0); invalid.unmount();
});

test("a new-cycle retry preserves its request ID and uses the current 90-day, 2000-character and 30000-win limits", async () => {
  const form = harness({ component: "MegaPigCycleForm", props: { reading: null, onSaved() {} }, response: (_, requests) => requests.length === 1 ? Response.json({ code: "unavailable" }, { status: 503 }) : { id: ID, version: 1, replayed: true } });
  let tree = await fillNew(form); change(tree, "Ends at", "2026-11-01T09:00"); tree = await form.render(); change(tree, "Private cycle notes", "n".repeat(1500)); tree = await form.render();
  assert.equal(input(tree, "Private cycle notes").props.maxLength, 2000); assert.equal(input(tree, "Stage 1").props.max, 30000);
  submit(tree); tree = await form.render(); assert.match(errorText(tree), /draft is preserved/); submit(tree); await form.render();
  assert.equal(form.requests.length, 2); assert.equal(form.requests[0].payload.id, null); assert.equal(form.requests[0].payload.requestId, form.requests[1].payload.requestId); assert.equal(form.requests[1].payload.cycle.notes.length, 1500); form.unmount();
});

test("creation retries keep a request ID and a conflict preserves notes and the original version", async () => {
  const form = harness({ component: "MegaPigCycleForm", props: { cycle: cycle(), reading: reading(), onSaved() {}, onReload() {} }, response: () => Response.json({ error: "Changed", code: "conflict" }, { status: 409 }) });
  let tree = await form.render(); change(tree, "Private cycle notes", "Unsaved note retained"); tree = await form.render(); form.props({ cycle: cycle({ version: 9, notes: "Another admin's note" }) }); tree = await form.render();
  assert.equal(input(tree, "Starts at").props.disabled, true); submit(tree); tree = await form.render(); assert.match(errorText(tree), /saved cycle changed/); assert.equal(input(tree, "Private cycle notes").props.value, "Unsaved note retained");
  submit(tree); await form.render(); assert.equal(form.requests[0].payload.version, 3); assert.equal(form.requests[1].payload.version, 3); assert.equal(form.requests[0].payload.requestId, form.requests[1].payload.requestId); assert.equal(form.requests[0].payload.cycle.initialObservationId, null); form.unmount();
});

test("resuming a decreased counter requires a different confirmed reading and an explanation", async () => {
  const form = harness({ component: "MegaPigCycleForm", props: { cycle: cycle({ captureEnabled: false, capturePausedReason: "counters_decreased", notes: "" }), reading: reading({ id: NEW }), onSaved() {} } });
  let tree = await form.render(); assert.equal(input(tree, "Collect future").props.disabled, true); change(tree, "I confirm this new reading", true); tree = await form.render(); submit(tree); tree = await form.render(); assert.match(errorText(tree), /explain why/); assert.equal(form.requests.length, 0);
  change(tree, "Reason for confirming", "Checked the game; still the same cycle"); tree = await form.render(); submit(tree); await form.render(); assert.equal(form.requests[0].payload.cycle.initialObservationId, NEW); assert.equal(form.requests[0].payload.cycle.captureEnabled, true); form.unmount();
});

test("finalization never prefills source totals or reward receipt and preserves explicit zero", async () => {
  const form = harness({ component: "MegaPigFinalizeForm", props: { cycle: cycle(), onSaved() {}, onReload() {} } });
  let tree = await form.render(); assert.equal(input(tree, "Confirmed final wins").props.value, ""); assert.equal(input(tree, "Confirmed final stage").props.value, ""); assert.equal(input(tree, "Reward receipt").props.value, "unknown");
  change(tree, "Confirmed final wins", "0"); tree = await form.render(); change(tree, "Confirmed final stage", "0"); tree = await form.render(); submit(tree); await form.render();
  assert.equal(form.requests[0].payload.finalTotalWins, 0); assert.equal(form.requests[0].payload.confirmedStage, 0); assert.equal(form.requests[0].payload.rewardStatus, "unknown"); form.unmount();
  const invalid = harness({ component: "MegaPigFinalizeForm", props: { cycle: cycle(), onSaved() {}, onReload() {} } }); tree = await invalid.render(); change(tree, "Confirmed final wins", "64"); tree = await invalid.render(); change(tree, "Confirmed final stage", "5"); tree = await invalid.render(); submit(tree); tree = await invalid.render(); assert.match(errorText(tree), /stage must agree/); assert.equal(invalid.requests.length, 0); invalid.unmount();
});

test("reopening requires a reason, retains the version and aborts a late save at logout", async () => {
  const pending = deferred(), saved = [], form = harness({ component: "MegaPigReopenForm", props: { cycle: cycle({ finalizedAt: "2026-09-17T11:10:00Z" }), onSaved: id => saved.push(id), onReload() {} }, response: () => pending.promise });
  let tree = await form.render(); submit(tree); tree = await form.render(); assert.equal(form.requests.length, 0); assert.match(errorText(tree), /Enter a reason/);
  change(tree, "Reason for reopening", "Correcting a mistaken confirmation"); tree = await form.render(); submit(tree); await form.render(); assert.equal(form.requests[0].payload.version, 3); assert.equal(form.requests[0].payload.action, "reopen_cycle");
  form.session(false); assert.equal(form.requests[0].signal.aborted, true); pending.resolve({ id: ID, version: 4, replayed: false }); await form.render(); assert.deepEqual(saved, []); form.unmount();
});

test("frozen GET and POST requests time out visibly instead of leaving permanent loading or losing drafts", async () => {
  const pending = deferred(), page = harness({ response: () => pending.promise }); await page.render(); page.expire(); let tree = await page.render(); assert.match(textContent(tree), /history is unavailable/); assert.equal(page.requests[0].signal.aborted, true); assert.equal(elements(tree).find(node => node.type === "Button" && textContent(node) === "Refresh history").props.disabled, false); page.unmount();
  const form = harness({ component: "MegaPigReopenForm", props: { cycle: cycle(), onSaved() {}, onReload() {} }, response: () => pending.promise }); tree = await form.render(); change(tree, "Reason for reopening", "Keep this draft"); tree = await form.render(); submit(tree); await form.render(); form.expire(); tree = await form.render(); assert.match(errorText(tree), /draft is preserved/); assert.equal(input(tree, "Reason for reopening").props.value, "Keep this draft"); assert.equal(elements(tree).find(node => node.type === "fieldset").props.disabled, false); form.unmount(); pending.resolve({});
});

test("a roster conflict or changed-club response clears the old archive instead of retaining it as a transient error", async () => {
  for (const changed of [Response.json({ error: "Club changed", code: "conflict" }, { status: 409 }), { clubTag: "#GGRR", cycles: [], nextOffset: null }]) {
    let reads = 0;
    const page = harness({ response: () => ++reads === 1 ? { clubTag: "#PYLQ", cycles: [cycle()], latestObservation: reading(), nextOffset: null } : changed });
    let tree = await page.render(); assert.equal(named(tree, "MegaPigCycleSummary").length, 1); action(tree, "Refresh history")(); tree = await page.render(); assert.equal(named(tree, "MegaPigCycleSummary").length, 0); assert.match(textContent(tree), /history is unavailable/); page.unmount();
  }
});

test("a saved cycle refreshes its version before remounting the editor baseline", async () => {
  const pending = deferred(); let details = 0;
  const page = harness({ response: request => new URL(request.url, "https://club.test").searchParams.get("mode") === "cycle" ? ++details === 1 ? { clubTag: "#PYLQ", cycle: cycle(), members: [], nextOffset: null } : pending.promise : { clubTag: "#PYLQ", cycles: [cycle()], nextOffset: null } });
  let tree = await page.render(); action(tree, "Open cycle")(); tree = await page.render(); const before = named(tree, "MegaPigCycleForm")[0]; before.props.onSaved(ID); tree = await page.render();
  assert.equal(named(tree, "MegaPigCycleForm")[0].key, before.key, "a pending read must not create another editor with the old version");
  pending.resolve({ clubTag: "#PYLQ", cycle: cycle({ version: 4 }), members: [], nextOffset: null }); tree = await page.render(); const after = named(tree, "MegaPigCycleForm")[0]; assert.notEqual(after.key, before.key); assert.equal(after.props.cycle.version, 4); page.unmount();
});

test("retained member values, observed stage and confirmed result remain distinct from rewards", async () => {
  const row = harness({ component: "MegaPigArchivedMember", props: { member: member(), onPlayer() {} } }); let tree = await row.render(); assert.match(textContent(tree), /Former member/); assert.match(textContent(tree), /Wins0.*Last known; missing from latest reading/); assert.match(textContent(tree), /2026-09-17T09:30:00Z/); row.unmount();
  for (const [value, expected] of [[cycle(), /Observed stage.*4\/5.*Observed below target/], [cycle({ finalizedAt: "2026-09-17T11:30:00Z", finalTotalWins: null, confirmedStage: null }), /Confirmed final wins: Unknown/], [cycle({ finalizedAt: "2026-09-17T11:30:00Z", finalTotalWins: 80, confirmedStage: 5 }), /Confirmed goal reached/]]) {
    const summary = harness({ component: "MegaPigCycleSummary", props: { cycle: value } }); tree = await summary.render(); assert.match(textContent(tree), expected); assert.match(textContent(tree), /Reward not confirmed/); assert.doesNotMatch(textContent(tree), /Reward received/); summary.unmount();
  }
});

test("Arabic archive forms translate cycle confirmation and expose local date controls with LTR direction", async () => {
  const form = harness({ component: "MegaPigCycleForm", locale: "ar", props: { reading: reading(), onSaved() {} } }); const tree = await form.render(); assert.match(textContent(tree), /عنوان الدورة/); assert.match(textContent(tree), /قواعد نقلها المجتمع/); assert.match(textContent(tree), /أؤكد أن هذه القراءة تخص هذه الدورة/); assert.doesNotMatch(textContent(tree), /Cycle title|Cumulative stage targets|Collect future|Private cycle notes/);
  assert.ok(elements(tree).filter(node => node.props?.type === "datetime-local").every(node => node.props.dir === "ltr")); form.unmount();
});
