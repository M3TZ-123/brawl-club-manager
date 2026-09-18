const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, action } = require("./helpers/client-renderer.cjs");

const { expandHistory } = require("./helpers/history-renderer.cjs");
const tables = Object.fromEntries(["Table", "TableBody", "TableCell", "TableHead", "TableHeader", "TableRow"].map(name => [name, name]));
const initialRevision = "2026-09-16T12:00:00.123456+00:00";
const member = (tag, values = {}) => ({ player_tag: tag, player_name: `Player ${tag}`, notes: `Private ${tag}`, review_updated_at: initialRevision,
  first_seen: null, last_left_at: "2026-09-15T12:00:00Z", times_joined: 1, times_left: 1,
  role_at_leave: "member", trophies_at_leave: 1000, is_current_member: false, ...values });
const quietConsole = { ...console, error() {} };
function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) { for (const listener of [...listeners.get(event.type) || []]) listener(event); },
  };
}
function lifecycleRenderer() {
  const renderer = hookRenderer(), cleanups = new Set();
  return { ...renderer, react: { ...renderer.react, Suspense: "Suspense", useEffect(callback, dependencies) {
    renderer.react.useEffect(() => {
      const cleanup = callback(); if (typeof cleanup !== "function") return;
      cleanups.add(cleanup); return () => { cleanups.delete(cleanup); cleanup(); };
    }, dependencies);
  } }, unmount() { for (const cleanup of [...cleanups]) cleanup(); cleanups.clear(); } };
}
function historyHarness({ admin = true, respond } = {}) {
  const renderer = lifecycleRenderer(), window = eventTarget(), requests = [], invalidations = [];
  const session = { isAdmin: admin, isLoading: false };
  let rows = [member("#FORMER")];
  const page = loadTypeScript("src/app/history/page.tsx", {
    ...componentMocks, react: renderer.react,
    "@/components/ui/table": tables,
    "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
    "@/components/history-member-card": { HistoryMemberCard: "HistoryMemberCard" },
    "@/hooks/use-admin-session": { useAdminSession: () => session },
    "@/lib/client-data-cache": { invalidateJsonCache: value => invalidations.push(value) },
  }, { window, console: quietConsole, CustomEvent: class { constructor(type) { this.type = type; } }, fetch: (url, init) => {
    const request = { url, init }; requests.push(request);
    return respond ? respond(request) : Promise.resolve(Response.json({ history: session.isAdmin ? rows : rows.map(row => ({ ...row, notes: undefined, review_updated_at: undefined })) }));
  } }).default;
  return { requests, session, window, invalidations, unmount: renderer.unmount, setRows(next) { rows = next; }, render: () => renderer.render(() => expandHistory(page())) };
}
test("history offers visible member notes for former members and safe sign-in links to visitors", async () => {
  const admin = historyHarness(); let tree = await admin.render();
  assert.match(textContent(tree), /why someone left or was removed/);
  action(tree, "Member notes")(); tree = await admin.render();
  assert.equal(elements(tree).find(element => element.type === "MemberReviewSheet").props.member.player_tag, "#FORMER");
  admin.unmount();
  const visitor = historyHarness({ admin: false }); tree = await visitor.render();
  assert.ok(elements(tree).some(element => element.type === "Link" && element.props.href === "/reviews?member=%23FORMER"));
  assert.doesNotMatch(textContent(tree), /Private #FORMER/);
  assert.equal(elements(tree).some(element => element.type === "MemberReviewSheet"), false);
  visitor.unmount();
});

test("history refreshes note previews without reopening a closed review sheet", async () => {
  const page = historyHarness(); let tree = await page.render();
  action(tree, "Member notes")(); tree = await page.render();
  elements(tree).find(element => element.type === "MemberReviewSheet").props.onOpenChange(false);
  page.setRows([member("#FORMER", { notes: "Updated private reason" })]);
  page.window.dispatchEvent({ type: "member-reviews-updated" }); tree = await page.render();
  assert.match(textContent(tree), /Updated private reason/);
  assert.equal(elements(tree).some(element => element.type === "MemberReviewSheet"), false);
  assert.equal(elements(tree).some(element => element.type === "Input" && element.props.placeholder === "Add a note..."), false);
  assert.equal(elements(tree).some(element => element.props?.['aria-label'] === "Delete note"), false);
  assert.ok(page.requests.every(request => request.init.method !== "PATCH"));
  page.unmount();
});

test("an authentication boundary closes member notes and blocks late private history responses", async () => {
  let resolvePrivate, reads = 0;
  const page = historyHarness({ respond: () => {
    if (++reads === 2) return new Promise(resolve => { resolvePrivate = resolve; });
    return Promise.resolve(Response.json({ history: [member("#FORMER", reads > 2 ? { notes: undefined, review_updated_at: undefined } : {})] }));
  } });
  let tree = await page.render(); action(tree, "Member notes")(); tree = await page.render();
  assert.ok(elements(tree).some(element => element.type === "MemberReviewSheet"));
  page.window.dispatchEvent({ type: "member-reviews-updated" }); await page.render();
  const oldRead = page.requests.at(-1);
  page.session.isAdmin = false; page.window.dispatchEvent({ type: "admin-session-changed" });
  assert.equal(oldRead.init.signal.aborted, true);
  resolvePrivate(Response.json({ history: [member("#FORMER", { notes: "Late private result" })] }));
  tree = await page.render();
  assert.equal(elements(tree).some(element => element.type === "MemberReviewSheet"), false);
  assert.doesNotMatch(textContent(tree), /Late private result|Private #FORMER/);
  page.unmount();
});

test("history unmount cancels the active read and ignores its late private result", async () => {
  let resolve;
  const page = historyHarness({ respond: () => new Promise(done => { resolve = done; }) });
  await page.render(); const request = page.requests[0];
  page.unmount(); assert.equal(request.init.signal.aborted, true);
  resolve(Response.json({ history: [member("#FORMER")] }));
  await new Promise(done => setImmediate(done));
  assert.equal(page.requests.length, 1);
});

test("accepted roster updates refresh open details while a club change closes both member sheets", async () => {
  const page = historyHarness(); let tree = await page.render();
  elements(tree).find(element => element.props?.['aria-label'] === 'Details for Player #FORMER').props.onClick();
  action(tree, "Member notes")(); tree = await page.render();
  assert.ok(elements(tree).some(element => element.type === 'Sheet'));
  assert.ok(elements(tree).some(element => element.type === 'MemberReviewSheet'));
  page.setRows([member('#FORMER', { is_current_member: true, latest_membership_event: { type: 'join', at: '2026-09-18T12:00:00Z', source: 'recorded' } })]);
  page.window.dispatchEvent({ type: 'club-data-updated' }); tree = await page.render();
  const details = elements(tree).find(element => element.type === 'Sheet');
  assert.match(textContent(details), /Current/);
  assert.match(textContent(details), /Joined club/);
  page.window.dispatchEvent({ type: 'club-data-updated', detail: { clubChanged: true } }); tree = await page.render();
  assert.equal(elements(tree).some(element => element.type === 'Sheet' || element.type === 'MemberReviewSheet'), false);
  page.unmount();
});

const directoryReviewUrl = "/api/member-reviews?include_history=1";
const queueCards = tree => elements(tree).filter(element => element.type === "article");
const queueStatus = (tree, value) => elements(tree).find(element => element.type === "Button" && element.key === value);
const queueControl = (tree, name) => {
  const control = elements(tree).find(element => element.props?.["aria-label"] === name);
  assert.ok(control, name); return control;
};
const queueSheet = tree => elements(tree).find(element => element.type === "MemberReviewSheet");
const queuePayload = (url, { history = [], members = [], reviews = [], historySummaries = [] } = {}) => url === directoryReviewUrl ? { reviews, historySummaries }
  : url === "/api/members" ? { members } : { history };

function queueHarness({ admin = true, requested = "", respond } = {}) {
  const renderer = lifecycleRenderer(), window = eventTarget(), requests = [];
  const session = { isAdmin: admin, isLoading: false };
  let query = requested;
  const component = loadTypeScript("src/app/reviews/page.tsx", {
    ...componentMocks, react: renderer.react,
    "next/navigation": { useSearchParams: () => new URLSearchParams(query ? `member=${encodeURIComponent(query)}` : "") },
    "@/hooks/use-admin-session": { useAdminSession: () => session },
  }, { window, console: quietConsole, fetch: (url, init) => {
    requests.push({ url, init });
    if (respond) return respond({ url, init });
    return Promise.resolve(Response.json(queuePayload(url, {
      reviews: [{ player_tag: "#OLD", status: "reviewed", notes: "Left for another club", updated_at: initialRevision }],
      members: [{ player_tag: "#CURRENT", player_name: "Current latest", activity_status: "active" }],
      history: [member("#OLD"), member("#CURRENT", { player_name: "Old snapshot", is_current_member: false })],
    })));
  } }).default;
  const shell = component(); assert.equal(shell.props.children.type, "AdminGate");
  const queue = elements(shell).find(element => element.type?.name === "ReviewQueue").type;
  return { requests, session, window, unmount: renderer.unmount, setRequested(value) { query = value; }, render: () => renderer.render(queue) };
}

test("a former-member deep link survives sign-in, deduplicates the roster and respects membership filters", async () => {
  const page = queueHarness({ admin: false, requested: "#OLD" });
  assert.equal(await page.render(), null); assert.equal(page.requests.length, 0);
  page.session.isAdmin = true; let tree = await page.render();
  assert.ok(page.requests.some(request => request.url === "/api/history?range=all"));
  assert.ok(page.requests.some(request => request.url === directoryReviewUrl));
  const sheet = queueSheet(tree);
  assert.equal(sheet.props.member.player_tag, "#OLD"); assert.equal(sheet.key, "#OLD");
  assert.equal(queueCards(tree).length, 2);
  assert.equal(queueStatus(tree, "all").props["aria-pressed"], true);
  assert.equal(queueControl(tree, "Membership status").props.value, "all");
  assert.match(textContent(tree), /Current latest/); assert.doesNotMatch(textContent(tree), /Old snapshot/);
  sheet.props.onOpenChange(false); tree = await page.render();
  queueControl(tree, "Membership status").props.onChange({ target: { value: "former" } }); tree = await page.render();
  const rows = queueCards(tree);
  assert.equal(rows.length, 1); assert.match(textContent(rows[0]), /#OLD/); assert.doesNotMatch(textContent(rows[0]), /Inactive|Low activity|Unknown/);
  page.window.dispatchEvent({ type: "member-reviews-updated" }); tree = await page.render();
  assert.equal(queueSheet(tree), undefined, "A refresh does not reopen an intentionally closed linked editor");
  page.setRequested(""); await page.render(); page.setRequested("#OLD"); tree = await page.render();
  assert.equal(queueSheet(tree).props.member.player_tag, "#OLD");
  assert.equal(queueControl(tree, "Membership status").props.value, "all", "A new deep link is not hidden by previous filters");
  assert.ok(page.requests.every(request => request.init.cache === "no-store" && !request.init.method));
  page.unmount();
});

test("the private notes directory aborts all three reads and rejects late notes or history summaries across logout", async () => {
  const pending = [];
  const page = queueHarness({ requested: "#OLD", respond: request => new Promise(resolve => pending.push({ ...request, resolve })) });
  await page.render(); assert.equal(pending.length, 3);
  page.session.isAdmin = false; page.window.dispatchEvent({ type: "admin-session-changed" });
  assert.ok(pending.every(request => request.init.signal.aborted));
  for (const request of pending) request.resolve(Response.json(queuePayload(request.url, {
    reviews: [{ player_tag: "#OLD", notes: "Private late note" }],
    historySummaries: [{ player_tag: "#OLD", entry_count: 27, latest_at: initialRevision }],
    history: [member("#OLD")],
  })));
  assert.equal(await page.render(), null); assert.equal(page.requests.length, 3);
  page.unmount();
});

function largeQueueFixture() {
  const history = Array.from({ length: 95 }, (_, index) => member(`#MEMBER${index}`, { player_name: `Player ${index}`, is_current_member: index < 5 }));
  return { history, members: history.slice(0, 5), reviews: [
    { player_tag: "#MEMBER94", status: "reviewed", notes: "Known departure reason", updated_at: initialRevision },
    { player_tag: "#MEMBER93", status: "reviewed", notes: " \n ", updated_at: initialRevision },
    { player_tag: "#MEMBER92", status: "follow_up", notes: null, follow_up_at: "2026-09-20T12:00:00Z", updated_at: initialRevision },
    { player_tag: "#MEMBER91", status: "pending", notes: null, updated_at: initialRevision },
  ], historySummaries: [{ player_tag: "#MEMBER90", entry_count: 3, latest_at: "2026-09-15T12:00:00Z" }] };
}
const largeQueueResponse = ({ url }) => Promise.resolve(Response.json(queuePayload(url, largeQueueFixture())));

test("all members is the honest default and missing or blank reviews do not create pending work or saved notes", async () => {
  const page = queueHarness({ respond: largeQueueResponse }); let tree = await page.render();
  assert.equal(queueStatus(tree, "all").props["aria-pressed"], true);
  assert.equal(queueControl(tree, "Membership status").props.value, "all");
  assert.equal(textContent(queueStatus(tree, "all")), "All members95");
  assert.equal(textContent(queueStatus(tree, "saved")), "Saved notes2");
  assert.equal(textContent(queueStatus(tree, "follow_up")), "Follow-ups1");
  assert.equal(queueStatus(tree, "pending"), undefined);
  assert.equal(queueStatus(tree, "reviewed"), undefined);
  assert.equal(queueCards(tree).length, 12);
  const noReview = queueCards(tree).find(row => row.key === "#MEMBER0");
  assert.ok(noReview); assert.match(textContent(noReview), /No saved notes/); assert.doesNotMatch(textContent(noReview), /Pending/);
  assert.equal(elements(tree).some(element => element.type === "DataConfidenceNotice"), false);
  queueStatus(tree, "saved").props.onClick(); tree = await page.render();
  assert.deepEqual(queueCards(tree).map(row => row.key).sort(), ["#MEMBER90", "#MEMBER94"]);
  const historical = queueCards(tree).find(row => row.key === "#MEMBER90");
  assert.match(textContent(historical), /Dated history: 3 entries/);
  assert.doesNotMatch(textContent(historical), /No saved notes/);
  assert.ok(elements(historical).some(element => element.type === "LocalDate" && element.props.value === "2026-09-15T12:00:00.000Z"));
  assert.equal(textContent(queueStatus(tree, "all")), "All members95", "Counts are computed before the active content tab");
  assert.equal(page.requests.length, 3, "Dated-history counts come in one directory request, not one request per member");
  page.unmount();
});

test("12-row pagination never expands the full directory and full-data search updates scoped counts and resets the page", async () => {
  const page = queueHarness({ respond: largeQueueResponse }); let tree = await page.render();
  assert.equal(queueCards(tree).length, 12); assert.match(textContent(tree), /Page 1 of 8/);
  const firstTags = queueCards(tree).map(row => row.key);
  action(tree, "Next")(); tree = await page.render();
  assert.equal(queueCards(tree).length, 12); assert.match(textContent(tree), /Page 2 of 8/);
  assert.ok(queueCards(tree).every(row => !firstTags.includes(row.key)));
  assert.equal(page.requests.length, 3);
  queueControl(tree, "Search members...").props.onChange({ target: { value: "#MEMBER88" } }); tree = await page.render();
  assert.equal(queueCards(tree).length, 1); assert.match(textContent(queueCards(tree)[0]), /Player 88/);
  assert.equal(textContent(queueStatus(tree, "all")), "All members1");
  assert.equal(textContent(queueStatus(tree, "saved")), "Saved notes0");
  assert.equal(textContent(queueStatus(tree, "follow_up")), "Follow-ups0");
  queueControl(tree, "Search members...").props.onChange({ target: { value: "" } }); tree = await page.render();
  assert.match(textContent(tree), /Page 1 of 8/);
  action(tree, "Next")(); tree = await page.render();
  queueControl(tree, "Membership status").props.onChange({ target: { value: "former" } }); tree = await page.render();
  assert.match(textContent(tree), /Page 1 of 8/); assert.equal(textContent(queueStatus(tree, "all")), "All members90");
  assert.ok(queueCards(tree).every(row => textContent(row).includes("Former")));
  for (let index = 1; index < 8; index++) { action(tree, "Next")(); tree = await page.render(); }
  assert.equal(queueCards(tree).length, 6); assert.match(textContent(tree), /Page 8 of 8/);
  const lastNext = elements(tree).find(element => element.type === "Button" && textContent(element) === "Next");
  assert.equal(lastNext.props.disabled, true);
  action(tree, "Previous")(); tree = await page.render(); assert.match(textContent(tree), /Page 7 of 8/);
  queueStatus(tree, "saved").props.onClick(); tree = await page.render(); assert.equal(queueCards(tree).length, 2);
  queueStatus(tree, "all").props.onClick(); tree = await page.render(); assert.match(textContent(tree), /Page 1 of 8/);
  assert.equal(elements(tree).some(element => element.type === "Button" && textContent(element) === "Load More"), false);
  assert.equal(page.requests.length, 3, "Searching, filtering and pagination do not read or mutate live records");
  page.unmount();
});

test("editable note searches find former members and counts respect both search and membership", async () => {
  const page = queueHarness({ respond: largeQueueResponse }); let tree = await page.render();
  queueControl(tree, "Search members...").props.onChange({ target: { value: "  DEPARTURE REASON " } }); tree = await page.render();
  assert.deepEqual(queueCards(tree).map(row => row.key), ["#MEMBER94"]);
  assert.match(textContent(queueCards(tree)[0]), /Known departure reason/);
  assert.equal(textContent(queueStatus(tree, "all")), "All members1");
  assert.equal(textContent(queueStatus(tree, "saved")), "Saved notes1");
  queueControl(tree, "Membership status").props.onChange({ target: { value: "current" } }); tree = await page.render();
  assert.equal(queueCards(tree).length, 0); assert.equal(textContent(queueStatus(tree, "all")), "All members0");
  queueControl(tree, "Search members...").props.onChange({ target: { value: "" } }); tree = await page.render();
  assert.equal(queueCards(tree).length, 5); assert.equal(textContent(queueStatus(tree, "saved")), "Saved notes0");
  assert.equal(textContent(queueStatus(tree, "follow_up")), "Follow-ups0");
  page.unmount();
});

test("an off-page former-member deep link opens without expanding all rows and stays closed after dismissal", async () => {
  const page = queueHarness({ admin: false, requested: "#MEMBER88", respond: largeQueueResponse });
  assert.equal(await page.render(), null); assert.equal(page.requests.length, 0);
  page.session.isAdmin = true; let tree = await page.render();
  assert.equal(queueCards(tree).length, 12); assert.equal(queueCards(tree).some(row => row.key === "#MEMBER88"), false);
  const sheet = queueSheet(tree); assert.equal(sheet.props.member.player_tag, "#MEMBER88"); assert.equal(sheet.props.member.is_current_member, false);
  sheet.props.onOpenChange(false); tree = await page.render();
  action(tree, "Next")(); tree = await page.render();
  const secondPage = queueCards(tree).map(row => row.key);
  page.window.dispatchEvent({ type: "member-reviews-updated" }); tree = await page.render();
  assert.match(textContent(tree), /Page 2 of 8/); assert.deepEqual(queueCards(tree).map(row => row.key), secondPage);
  assert.equal(queueSheet(tree), undefined);
  page.unmount();
});

test("follow-ups show only explicitly scheduled reviews, preserve missing dates and do not turn dated history into unresolved tasks", async () => {
  const history = ["EARLY", "LATE", "MISSING", "BAD", "LOG", "EMPTY"].map(tag => member(`#${tag}`, { is_current_member: tag !== "LOG", activity_status: "inactive" }));
  const reviews = [
    { player_tag: "#LATE", status: "follow_up", follow_up_at: "2026-10-20T12:00:00Z", notes: null },
    { player_tag: "#EARLY", status: "follow_up", follow_up_at: "2026-09-20T12:00:00Z", notes: null },
    { player_tag: "#MISSING", status: "follow_up", follow_up_at: null, notes: null },
    { player_tag: "#BAD", status: "follow_up", follow_up_at: "not-a-date", notes: null },
  ];
  const page = queueHarness({ respond: ({ url }) => Promise.resolve(Response.json(queuePayload(url, { history, members: history.filter(row => row.is_current_member), reviews,
    historySummaries: [{ player_tag: "#LOG", entry_count: 2, latest_at: initialRevision }] }))) });
  let tree = await page.render(); assert.equal(textContent(queueStatus(tree, "follow_up")), "Follow-ups4");
  queueStatus(tree, "follow_up").props.onClick(); tree = await page.render();
  const cards = queueCards(tree), keys = cards.map(row => row.key);
  assert.equal(cards.length, 4); assert.ok(keys.indexOf("#EARLY") < keys.indexOf("#LATE"));
  assert.ok(!keys.includes("#LOG") && !keys.includes("#EMPTY"));
  for (const tag of ["#MISSING", "#BAD"]) assert.match(textContent(cards.find(row => row.key === tag)), /Date missing/);
  assert.doesNotMatch(cards.map(textContent).join(""), /Inactive|Low activity|Pending/);
  assert.equal(page.requests.length, 3);
  page.unmount();
});

test("an open editor survives ordinary refreshes and dated-history updates refresh directory counts", async () => {
  const fixture = largeQueueFixture(); let hold = false; const pending = [];
  const page = queueHarness({ respond: request => hold ? new Promise(resolve => pending.push({ ...request, resolve }))
    : Promise.resolve(Response.json(queuePayload(request.url, fixture))) });
  let tree = await page.render();
  const row = queueCards(tree)[0]; elements(row).find(element => element.type === "Button").props.onClick(); tree = await page.render();
  const original = queueSheet(tree); assert.ok(original);
  hold = true; page.window.dispatchEvent({ type: "member-reviews-updated" }); tree = await page.render();
  assert.equal(queueSheet(tree).key, original.key, "A loading directory must not unmount the editor and discard a draft");
  assert.equal(pending.length, 3);
  for (const request of pending) request.resolve(Response.json(queuePayload(request.url, fixture)));
  tree = await page.render(); assert.equal(queueSheet(tree).key, original.key);
  hold = false; fixture.historySummaries.push({ player_tag: "#MEMBER89", entry_count: 1, latest_at: "2026-09-18T10:00:00Z" });
  page.window.dispatchEvent({ type: "club-administration-updated" }); tree = await page.render();
  assert.equal(textContent(queueStatus(tree, "saved")), "Saved notes3");
  assert.equal(queueSheet(tree).key, original.key);
  page.unmount();
});

test("a configured club change closes the old editor and removes old private summaries while the next directory is loading", async () => {
  let hold = false; const pending = [];
  const page = queueHarness({ requested: "#OLD", respond: request => hold ? new Promise(resolve => pending.push({ ...request, resolve }))
    : Promise.resolve(Response.json(queuePayload(request.url, { history: [member("#OLD")], reviews: [{ player_tag: "#OLD", status: "reviewed", notes: "Old club private note" }],
      historySummaries: [{ player_tag: "#OLD", entry_count: 9, latest_at: initialRevision }] }))) });
  let tree = await page.render(); assert.ok(queueSheet(tree));
  hold = true; page.window.dispatchEvent({ type: "club-data-updated", detail: { clubChanged: true } }); tree = await page.render();
  assert.equal(queueSheet(tree), undefined); assert.doesNotMatch(textContent(tree), /Old club private note|Dated history: 9/);
  assert.equal(pending.length, 3);
  for (const request of pending) request.resolve(Response.json(queuePayload(request.url)));
  tree = await page.render(); assert.equal(queueSheet(tree), undefined); assert.equal(queueCards(tree).length, 0);
  page.unmount();
});

test("directory failures do not claim zero saved notes, and unmount cancels unresolved private reads", async () => {
  const failed = queueHarness({ respond: ({ url }) => Promise.resolve(url === directoryReviewUrl ? Response.json({ error: "Unavailable" }, { status: 503 }) : Response.json(queuePayload(url))) });
  const tree = await failed.render();
  assert.ok(elements(tree).some(element => element.props?.role === "alert"));
  assert.equal(elements(queueStatus(tree, "saved")).some(element => element.type === "span"), false, "Unavailable private history is not zero notes");
  assert.equal(queueCards(tree).length, 0); failed.unmount();
  const pending = [], page = queueHarness({ respond: request => new Promise(resolve => pending.push({ ...request, resolve })) });
  await page.render(); assert.equal(pending.length, 3); page.unmount();
  assert.ok(pending.every(request => request.init.signal.aborted));
  for (const request of pending) request.resolve(Response.json(queuePayload(request.url, { history: [member("#OLD")] })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(page.requests.length, 3);
});
