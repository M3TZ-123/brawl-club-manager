const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, action } = require("./helpers/client-renderer.cjs");
const { buildMemberComparison } = loadTypeScript("src/lib/member-comparison.ts");

const NOW = "2026-09-17T12:00:00.000Z";
const CHECKED = "2026-09-17T11:55:00.000Z";
const profile = (values = {}) => ({ trophies: 20000, trophiesCheckedAt: CHECKED, power11: 10, profileCheckedAt: CHECKED, rank: "Mythic", rankedPoints: 6000, rankedSeasonId: 20, rankedCheckedAt: CHECKED, ...values });
function snapshot(range = "7d", overrides = {}) {
  const days = Array.from({ length: Number.parseInt(range) }, (_, index) => ({ date: new Date(Date.parse("2026-09-17") - (Number.parseInt(range) - index) * 86400000).toISOString().slice(0, 10), battles: 0, possibleGap: false, absenceOverlap: false }));
  const events = Array.from({ length: 3 }, (_, index) => ({ id: `event-${index}`, version: 2, title: `Club event ${index + 1}`, kind: "mega_pig", startsAt: `2026-09-${12 + index}T10:00:00Z`, endsAt: `2026-09-${12 + index}T11:00:00Z`, status: "completed", attendance: index ? "absent" : "present", observedAt: `2026-09-${12 + index}T10:45:00Z`, absenceOverlap: false }));
  const member = (tag, name, values = {}) => ({ tag, name, role: "member", profile: profile(), lastActivityAt: "2026-09-16T12:00:00Z", lastBattleAt: "2026-09-16T12:00:00Z", spell: { startedAt: "2026-01-01T00:00:00Z", source: "recorded", kind: "join", uncertain: false }, graceUntil: null, absence: null, coverage: { baselineAt: "2026-01-01T00:00:00Z", checkedAt: CHECKED, lastStatus: "observed", trailing48hGap: false, trailing48hExcused: false }, days, events, eventsTruncated: false, ...values });
  return buildMemberComparison({ clubTag: "#CLUB", generatedAt: NOW, range, rosterCheckedAt: CHECKED,
    members: [member("#A", "Amine"), member("#B", "Bilel", { days: days.map(day => ({ ...day, battles: 3 })), events: events.map(event => ({ ...event, attendance: "present" })) }), member("#L", "Leader", { role: "president" })],
    candidates: [{ kind: "candidate", tag: "#C", name: "Candidate One", status: "watching", commitment: "unknown", profile: profile({ trophies: 30000, power11: 20, rankedSeasonId: null }) }, { kind: "candidate", tag: "#D", name: "Candidate Two", status: "shortlisted", commitment: "unknown", profile: profile({ trophies: 31000, power11: null }) }], ...overrides });
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function eventTarget(extra = {}) {
  const listeners = new Map();
  return { ...extra, addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); }, removeEventListener(name, listener) { listeners.get(name)?.delete(listener); }, emit(name, detail) { for (const listener of [...listeners.get(name) || []]) listener({ type: name, detail }); } };
}
function testClock(start = NOW) {
  let time = Date.parse(start), nextId = 0; const timers = new Map();
  const ClockDate = class extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } };
  return { Date: ClockDate, setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { at: time + delay, callback }); return id; }, clearTimeout(id) { timers.delete(id); }, advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); } }, get timerCount() { return timers.size; } };
}
function harness({ active = true, admin = true, selection, response, clock = testClock() } = {}) {
  const base = hookRenderer(), cleanups = new Set(), requests = [], changes = [];
  const react = { ...base.react, useEffect(callback, deps) { base.react.useEffect(() => { const cleanup = callback(); if (cleanup) cleanups.add(cleanup); return () => { cleanups.delete(cleanup); cleanup?.(); }; }, deps); } };
  const browser = eventTarget(), document = eventTarget({ visibilityState: "visible" });
  let isAdmin = admin, isActive = active, added = 0;
  const { RecruitmentComparison } = loadTypeScript("src/components/recruitment-comparison.tsx", {
    ...componentMocks, react,
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin, isLoading: false }) },
    "@/lib/client-fetch": { fetchJsonWithTimeout(url, options = {}) { const request = { url, ...options, method: options.method || "GET", body: options.body && JSON.parse(options.body) }; requests.push(request); return Promise.resolve().then(() => response ? response(request, requests) : snapshot(new URL(url, "https://test.local").searchParams.get("range"))); } },
  }, { window: browser, document, Date: clock.Date, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  return { requests, changes, browser, document, clock, get added() { return added; }, setActive(value) { isActive = value; }, logout() { isAdmin = false; browser.emit("admin-session-changed"); }, login() { isAdmin = true; browser.emit("admin-session-changed"); }, unmount() { for (const cleanup of cleanups) cleanup(); cleanups.clear(); }, render: () => base.render(() => RecruitmentComparison({ active: isActive, initialSelection: selection, onAddCandidate() { added++; }, onCandidateUpdated(value) { changes.push(value); } })) };
}
function field(tree, label) { const wrapper = elements(tree).find(node => node.type === "label" && textContent(node).startsWith(label)); assert.ok(wrapper, `Missing label ${label}`); return elements(wrapper).find(node => ["select", "Input"].includes(node.type)); }
const articles = tree => elements(tree).filter(node => node.type === "article");
const metric = (tree, label) => { const section = elements(tree).find(node => node.props?.["aria-label"] === "Player comparison"); return elements(section).find(node => node.type === "div" && elements(node).some(child => child.type === "h3" && textContent(child) === label)); };

test("comparison loads only for an active admin and preserves queue filters when returning from a pair", async () => {
  const page = harness({ active: false }); let tree = await page.render(); assert.equal(tree, null); assert.equal(page.requests.length, 0);
  page.setActive(true); tree = await page.render(); assert.equal(page.requests.length, 1); assert.equal(page.requests[0].cache, "no-store");
  assert.match(textContent(tree), /Completed days only · UTC/); assert.match(textContent(tree), /Repeated recorded absences/);
  const period = elements(tree).find(node => node.type === "p" && textContent(node).startsWith("Completed days only · UTC"));
  const dates = elements(period).find(node => node.type === "bdi"); assert.equal(dates.props.dir, "ltr");
  assert.match(textContent(dates), /2026-09-10/); assert.doesNotMatch(textContent(dates), /Completed days/);
  field(tree, "Search members...").props.onChange({ target: { value: "Amine" } }); tree = await page.render();
  field(tree, "Review group").props.onChange({ target: { value: "review" } }); tree = await page.render();
  field(tree, "Sort by").props.onChange({ target: { value: "attendance" } }); tree = await page.render(); assert.equal(articles(tree).length, 1);
  action(articles(tree)[0], "Compare")(); tree = await page.render(); assert.equal(articles(tree).length, 0, "The queue must not stack underneath the pair");
  field(tree, "Compare with").props.onChange({ target: { value: "member:#B" } }); tree = await page.render();
  assert.match(textContent(metric(tree, "Recorded attendance")), /1 \/ 3/); assert.match(textContent(metric(tree, "Recorded attendance")), /3 \/ 3/);
  assert.match(textContent(tree), /Club event 1/); assert.match(textContent(tree), /2026-09-12T11:00:00.000Z/);
  assert.doesNotMatch(textContent(tree), /event-0/); assert.doesNotMatch(textContent(tree), /Possible roster snapshot change/);
  action(tree, "Back to roster review")(); tree = await page.render();
  assert.equal(field(tree, "Search members...").props.value, "Amine"); assert.equal(field(tree, "Review group").props.value, "review"); assert.equal(field(tree, "Sort by").props.value, "attendance");
  assert.equal(page.requests.length, 1, "Client queue and pair selection use the same bounded snapshot");
});

test("all pair kinds keep candidate commitment unknown, preserve null figures, and separate profile snapshot impact", async () => {
  const page = harness({ selection: { memberTag: "a", candidateTag: "c", range: "7d" } }); let tree = await page.render();
  assert.equal(field(tree, "First player").props.value, "member:#A"); assert.equal(field(tree, "Compare with").props.value, "candidate:#C");
  assert.match(textContent(metric(tree, "Observed active days")), /Unknown.*No tracked candidate activity/);
  assert.match(textContent(metric(tree, "Recorded attendance")), /Unknown/); assert.match(textContent(tree), /does not establish who will be more active/);
  assert.match(textContent(tree), /Possible roster snapshot changeCandidate minus current memberTrophies: 10000/);
  assert.doesNotMatch(textContent(metric(tree, "Ranked points")), /Second player minus first/);
  field(tree, "First player").props.onChange({ target: { value: "candidate:#D" } }); tree = await page.render();
  assert.doesNotMatch(textContent(tree), /Possible roster snapshot change/); assert.match(textContent(metric(tree, "Power 11 brawlers")), /Unknown/);
  field(tree, "Compare with").props.onChange({ target: { value: "member:#A" } }); tree = await page.render();
  assert.match(textContent(tree), /Possible roster snapshot changeCandidate minus current memberTrophies: 11000/);
  field(tree, "First player").props.onChange({ target: { value: "member:#L" } }); tree = await page.render();
  assert.match(textContent(tree), /selected member is protected/); assert.doesNotMatch(textContent(tree), /Possible roster snapshot change/);
  field(tree, "Compare with").props.onChange({ target: { value: "member:#L" } }); tree = await page.render();
  assert.match(textContent(tree), /Choose two different players/); assert.equal(metric(tree, "Trophies"), undefined);
});

test("period changes clear old evidence immediately and ignore late responses from the previous period", async () => {
  const old = deferred(), next = deferred(); let reads = 0;
  const page = harness({ response: () => ++reads === 1 ? snapshot() : reads === 2 ? old.promise : next.promise });
  let tree = await page.render(); action(tree, "Refresh")(); tree = await page.render(); const previous = page.requests.at(-1);
  action(tree, "1 month")(); tree = await page.render();
  assert.equal(previous.signal.aborted, true); assert.equal(articles(tree).length, 0); assert.doesNotMatch(textContent(tree), /Amine/);
  old.resolve(snapshot("7d")); tree = await page.render(); assert.equal(articles(tree).length, 0);
  next.resolve(snapshot("30d")); tree = await page.render(); assert.equal(articles(tree).length, 3); assert.match(page.requests.at(-1).url, /range=30d/);
  assert.equal(elements(tree).find(node => node.type === "Button" && textContent(node) === "1 month").props["aria-pressed"], true);
});

test("hidden comparison flushes old-club data and recovers on reactivation without hidden refreshes", async () => {
  const pending = deferred(); let reads = 0;
  const page = harness({ response: () => ++reads === 1 ? snapshot() : pending.promise }); let tree = await page.render(); assert.match(textContent(tree), /Amine/);
  page.setActive(false); tree = await page.render(); assert.equal(tree, null);
  page.browser.emit("club-data-updated", { clubChanged: true }); await page.render(); assert.equal(page.requests.length, 1);
  page.setActive(true); tree = await page.render(); assert.doesNotMatch(textContent(tree), /Amine/); assert.equal(page.requests.length, 2);
  pending.resolve(snapshot("7d", { clubTag: "#NEW", members: [] })); tree = await page.render(); assert.match(textContent(tree), /No current members found/);
});

test("logout aborts a candidate refresh and its late result cannot reintroduce private data", async () => {
  const pending = deferred();
  const page = harness({ selection: { candidateTag: "c" }, response: request => request.method === "POST" ? pending.promise : snapshot() });
  let tree = await page.render(); assert.equal(field(tree, "First player").props.value, ""); assert.equal(field(tree, "Compare with").props.value, "candidate:#C");
  const load = action(tree, "Load profile"); load(); load(); tree = await page.render(); assert.equal(page.requests.filter(request => request.method === "POST").length, 1);
  page.logout(); tree = await page.render(); assert.equal(tree, null); assert.equal(page.requests.at(-1).signal.aborted, true);
  pending.resolve({ candidate: { player_tag: "#C", version: 2 } }); tree = await page.render(); assert.equal(tree, null); assert.equal(page.changes.length, 0);
  page.login(); tree = await page.render(); assert.equal(articles(tree).length, 3); assert.equal(elements(tree).some(node => node.type === "select" && node.props.value === "candidate:#C"), false);
});

test("leaving and reopening a comparison during profile refresh does not leave the refresh control locked", async () => {
  const pending = deferred();
  const page = harness({ selection: { candidateTag: "c" }, response: request => request.method === "POST" ? pending.promise : snapshot() });
  let tree = await page.render(); action(tree, "Load profile")(); await page.render(); page.setActive(false); await page.render();
  pending.resolve({ candidate: { player_tag: "#C", version: 2 } }); await page.render(); page.setActive(true); tree = await page.render();
  assert.equal(elements(tree).find(node => node.type === "Button" && textContent(node) === "Load profile").props.disabled, false); assert.equal(page.changes.length, 0);
  action(tree, "Add candidate")(); assert.equal(page.added, 1);
});

test("missing event outcomes and unevaluable activity remain unknown, and a failed refresh never shows a false empty success", async () => {
  const value = snapshot(); value.members = [value.members[0]]; const member = value.members[0];
  member.activity.observedActiveDays = 0; member.activity.evaluatedDays = 0; member.activity.sufficientSample = false; member.activity.evaluatedDates = [];
  member.events.present = 0; member.events.absent = 0; member.events.knownSample = 0; member.events.evidence = []; member.events.sufficientSample = false; member.events.unresolved = 2;
  member.assessment = { bucket: "insufficient", priority: null, position: null, confidence: "insufficient", reasons: [], limitations: ["incomplete_event_records"] };
  let reads = 0; const page = harness({ response: () => ++reads === 1 ? value : Promise.reject(new Error("Unavailable")) });
  let tree = await page.render(); assert.match(textContent(tree), /No evaluable activity days/); assert.match(textContent(tree), /No documented attendance/); assert.match(textContent(tree), /2 event records unresolved/);
  action(tree, "Refresh")(); tree = await page.render(); assert.match(textContent(tree), /Comparison could not be loaded/); assert.doesNotMatch(textContent(tree), /No current members found/); assert.equal(articles(tree).length, 0);
  page.unmount(); assert.ok(page.requests.every(request => request.signal.aborted));
});

test("an open comparison expires after two minutes and hides old impact when a fresh read fails", async () => {
  const pending = deferred(); let reads = 0;
  const page = harness({ selection: { memberTag: "a", candidateTag: "c" }, response: () => ++reads === 1 ? snapshot() : pending.promise });
  let tree = await page.render(); assert.match(textContent(tree), /Possible roster snapshot change/);
  page.clock.advance(119999); tree = await page.render(); assert.equal(page.requests.length, 1);
  page.clock.advance(1); tree = await page.render(); assert.equal(page.requests.length, 2); assert.doesNotMatch(textContent(tree), /Possible roster snapshot change/); assert.match(textContent(tree), /Loading comparison/);
  pending.reject(new Error("Unavailable")); tree = await page.render(); assert.match(textContent(tree), /Comparison could not be loaded/); assert.doesNotMatch(textContent(tree), /Possible roster snapshot change/);
  assert.equal(page.clock.timerCount, 0); page.unmount(); assert.equal(page.clock.timerCount, 0);
});

test("UTC midnight refreshes the completed-day period and hidden views wait until visible", async () => {
  const clock = testClock("2026-09-17T23:59:30Z"); let reads = 0;
  const page = harness({ clock, response: () => { const value = snapshot(); value.generatedAt = new clock.Date().toISOString(); if (++reads > 1) { value.period.start = "2026-09-11T00:00:00Z"; value.period.end = "2026-09-18T00:00:00Z"; } return value; } });
  let tree = await page.render(); assert.match(textContent(tree), /2026-09-10T00:00:00/);
  page.document.visibilityState = "hidden"; clock.advance(30000); tree = await page.render(); assert.equal(page.requests.length, 1); assert.equal(articles(tree).length, 0);
  page.document.visibilityState = "visible"; page.document.emit("visibilitychange"); tree = await page.render(); assert.equal(page.requests.length, 2); assert.match(textContent(tree), /2026-09-11T00:00:00/);
  page.setActive(false); await page.render(); assert.equal(clock.timerCount, 0); clock.advance(120000); await page.render(); assert.equal(page.requests.length, 2);
});

test("a queue containing only protected or insufficient evidence gives an attendance next step", async () => {
  const value = snapshot(); value.members = value.members.filter(member => member.assessment.bucket === "protected");
  value.groups = { review: 0, followup: 0, noConcern: 0, protected: 1, insufficient: 0 };
  const page = harness({ response: () => value }); const tree = await page.render();
  assert.match(textContent(tree), /More tracked activity or completed-event attendance is needed before prioritizing members/);
  const link = elements(tree).find(node => node.type === "Link" && textContent(node) === "Record event attendance"); assert.equal(link.props.href, "/club-planning");
  assert.ok(elements(tree).filter(node => node.type === "details").every(node => !node.props.open), "Secondary evidence stays collapsed");
  const actionable = harness(); const normal = await actionable.render();
  assert.doesNotMatch(textContent(normal), /More tracked activity or completed-event attendance is needed before prioritizing members/);
});

test("verified roster evidence is labelled as an observation without inventing an original join date", async () => {
  const value = snapshot(); const member = value.members.find(row => row.tag === "#A");
  member.protection.observedSince = "2026-09-15T08:00:00.000Z"; member.protection.observationSource = "roster_snapshot";
  member.protection.spellStartedAt = null; member.protection.spellSource = "unknown";
  const page = harness({ selection: { memberTag: "a", candidateTag: "c" }, response: () => value });
  const tree = await page.render(), disclosure = elements(tree).find(node => node.type === "details" && textContent(node).startsWith("Evidence for Amine"));
  assert.match(textContent(disclosure), /Observed in this club since: 2026-09-15T08:00:00.000Z/);
  assert.doesNotMatch(textContent(disclosure), /Joined|Join date:/); assert.equal(disclosure.props.open, undefined);
});
