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
    return Promise.resolve(Response.json(url === "/api/member-reviews" ? { reviews: [{ player_tag: "#OLD", status: "reviewed", notes: "Left for another club" }] }
      : url === "/api/members" ? { members: [{ player_tag: "#CURRENT", player_name: "Current latest", activity_status: "active" }] }
      : { history: [member("#OLD"), member("#CURRENT", { player_name: "Old snapshot", is_current_member: false })] }));
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
  const sheet = elements(tree).find(element => element.type === "MemberReviewSheet");
  assert.equal(sheet.props.member.player_tag, "#OLD"); assert.equal(sheet.key, "#OLD");
  assert.equal(elements(tree).filter(element => element.type === "article").length, 2);
  assert.match(textContent(tree), /Current latest/); assert.doesNotMatch(textContent(tree), /Old snapshot/);
  sheet.props.onOpenChange(false); tree = await page.render();
  elements(tree).find(element => element.type === "select").props.onChange({ target: { value: "former" } }); tree = await page.render();
  const rows = elements(tree).filter(element => element.type === "article");
  assert.equal(rows.length, 1); assert.match(textContent(rows[0]), /#OLD/); assert.doesNotMatch(textContent(rows[0]), /active|Unknown/);
  page.window.dispatchEvent({ type: "member-reviews-updated" }); tree = await page.render();
  assert.equal(elements(tree).some(element => element.type === "MemberReviewSheet"), false, "A refresh does not reopen an intentionally closed linked editor");
  page.setRequested(""); await page.render(); page.setRequested("#OLD"); tree = await page.render();
  assert.equal(elements(tree).find(element => element.type === "MemberReviewSheet").props.member.player_tag, "#OLD");
  page.unmount();
});

test("the private review queue aborts all three reads and rejects late responses across logout", async () => {
  const pending = [];
  const page = queueHarness({ requested: "#OLD", respond: request => new Promise(resolve => pending.push({ ...request, resolve })) });
  await page.render(); assert.equal(pending.length, 3);
  page.session.isAdmin = false; page.window.dispatchEvent({ type: "admin-session-changed" });
  assert.ok(pending.every(request => request.init.signal.aborted));
  for (const request of pending) request.resolve(Response.json(request.url === "/api/member-reviews" ? { reviews: [{ player_tag: "#OLD", notes: "Private late note" }] }
    : request.url === "/api/members" ? { members: [] } : { history: [member("#OLD")] }));
  assert.equal(await page.render(), null); assert.equal(page.requests.length, 3);
  page.unmount();
});

function largeQueueResponse({ url }) {
  const history = Array.from({ length: 95 }, (_, index) => member(`#MEMBER${index}`, { player_name: `Player ${index}`, is_current_member: index < 5 }));
  return Promise.resolve(Response.json(url === "/api/member-reviews" ? { reviews: [
    { player_tag: "#MEMBER94", status: "reviewed", notes: "Known departure reason" },
  ] } : url === "/api/members" ? { members: history.slice(0, 5) } : { history }));
}
const queueCards = tree => elements(tree).filter(element => element.type === "article");
const queueStatus = (tree, value) => elements(tree).find(element => element.type === "Button" && element.key === value);

test("review batches preserve full-data counts and search finds off-page members while filters reset the visible batch", async () => {
  const page = queueHarness({ respond: largeQueueResponse });
  let tree = await page.render();
  assert.equal(queueCards(tree).length, 30);
  assert.match(textContent(tree), /Showing 30 of 94 matching members/);
  assert.equal(textContent(queueStatus(tree, "pending")), "Pending94");
  assert.equal(textContent(queueStatus(tree, "all")), "All reviews95");
  action(tree, "Load More")(); tree = await page.render();
  assert.equal(queueCards(tree).length, 60);
  assert.equal(new Set(queueCards(tree).map(row => row.key)).size, 60);
  assert.equal(page.requests.length, 3, "Client pagination must not fetch or mutate data");
  elements(tree).find(element => element.type === "Input").props.onChange({ target: { value: "#MEMBER88" } });
  tree = await page.render();
  assert.equal(queueCards(tree).length, 1);
  assert.match(textContent(queueCards(tree)[0]), /Player 88/);
  assert.equal(textContent(queueStatus(tree, "pending")), "Pending94", "Search must not truncate status counts");
  elements(tree).find(element => element.type === "Input").props.onChange({ target: { value: "" } });
  tree = await page.render();
  assert.equal(queueCards(tree).length, 30);
  action(tree, "Load More")(); tree = await page.render();
  queueStatus(tree, "all").props.onClick(); tree = await page.render();
  assert.equal(queueCards(tree).length, 30, "Review status change resets the batch");
  action(tree, "Load More")(); tree = await page.render();
  elements(tree).find(element => element.type === "select").props.onChange({ target: { value: "former" } });
  tree = await page.render();
  assert.equal(queueCards(tree).length, 30, "Membership change resets the batch");
  assert.equal(textContent(queueStatus(tree, "all")), "All reviews90");
  action(tree, "Load More")(); tree = await page.render();
  action(tree, "Load More")(); tree = await page.render();
  assert.equal(queueCards(tree).length, 90);
  assert.equal(elements(tree).some(element => element.type === "Button" && textContent(element) === "Load More"), false);
  assert.equal(page.requests.length, 3);
  page.unmount();
});

test("an off-page former-member deep link opens after sign-in without expanding all cards or reopening after dismissal", async () => {
  const page = queueHarness({ admin: false, requested: "#MEMBER94", respond: largeQueueResponse });
  assert.equal(await page.render(), null);
  assert.equal(page.requests.length, 0);
  page.session.isAdmin = true;
  let tree = await page.render();
  assert.equal(queueCards(tree).length, 30);
  assert.equal(queueCards(tree).some(row => row.key === "#MEMBER94"), false);
  const sheet = elements(tree).find(element => element.type === "MemberReviewSheet");
  assert.equal(sheet.props.member.player_tag, "#MEMBER94");
  assert.equal(sheet.props.member.is_current_member, false);
  assert.equal(textContent(queueStatus(tree, "all")), "All reviews95");
  sheet.props.onOpenChange(false); tree = await page.render();
  action(tree, "Load More")(); tree = await page.render();
  page.window.dispatchEvent({ type: "member-reviews-updated" }); tree = await page.render();
  assert.equal(queueCards(tree).length, 60, "A background refresh preserves the current batch");
  assert.equal(elements(tree).some(element => element.type === "MemberReviewSheet"), false);
  page.unmount();
});

test("review filters and badges use readable labels while filtering by unchanged status values", async () => {
  const rows = [member("#PENDING", { is_current_member: true, activity_status: "minimal" }), member("#FOLLOW", { is_current_member: true, activity_status: "active" }), member("#DONE", { is_current_member: true, activity_status: "inactive" })];
  const page = queueHarness({ respond: ({ url }) => Promise.resolve(Response.json(url === "/api/member-reviews" ? { reviews: [
    { player_tag: "#FOLLOW", status: "follow_up" }, { player_tag: "#DONE", status: "reviewed" },
  ] } : url === "/api/members" ? { members: rows } : { history: rows })) });
  let tree = await page.render();
  assert.equal(textContent(queueStatus(tree, "pending")), "Pending1");
  assert.equal(textContent(queueStatus(tree, "follow_up")), "Follow up1");
  assert.equal(textContent(queueStatus(tree, "reviewed")), "Reviewed1");
  assert.match(textContent(queueCards(tree)[0]), /Low activityPending/);
  assert.doesNotMatch(textContent(tree), /follow_up|minimal|\bpending\b|\breviewed\b/);
  queueStatus(tree, "follow_up").props.onClick(); tree = await page.render();
  assert.equal(queueCards(tree).length, 1); assert.match(textContent(queueCards(tree)[0]), /#FOLLOW/);
  assert.match(textContent(queueCards(tree)[0]), /ActiveFollow up/);
  assert.equal(page.requests.length, 3, "Changing a display label must not add writes or reads");
  page.unmount();
});
