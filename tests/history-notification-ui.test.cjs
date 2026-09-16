const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, i18n, windowMock, elements, textContent, action } = require("./helpers/client-renderer.cjs");
const tables = Object.fromEntries(["Table", "TableBody", "TableCell", "TableHead", "TableHeader", "TableRow"].map(name => [name, name]));
const historyMember = (tag, notes) => ({ player_tag: tag, player_name: tag, notes, first_seen: null, last_left_at: null,
  times_joined: null, times_left: null, role_at_leave: null, trophies_at_leave: null, is_current_member: true });
const ariaAction = (tree, label) => {
  const element = elements(tree).find(element => element.props?.onClick && element.props["aria-label"] === label);
  assert.ok(element, `Missing action ${label}`); return element.props.onClick;
};
const editor = tree => elements(tree).find(element => element.type === "Input" && element.props.placeholder === "Add a note...");
const editNote = (tree, note) => {
  const element = elements(tree).find(element => element.props?.title === "Click to edit note" && textContent(element).includes(note));
  assert.ok(element, `Missing note ${note}`); element.props.onClick();
};

test("mobile history preserves unknown versus zero membership counters in English and Arabic", async () => {
  const { translate } = loadTypeScript("src/lib/i18n/messages.ts");
  for (const locale of ["en", "ar"]) {
    const renderer = hookRenderer(); const t = key => translate(key, locale);
    const { HistoryMemberCard } = loadTypeScript("src/components/history-member-card.tsx", {
      ...componentMocks, react: renderer.react,
      "@/components/membership-timeline": { MembershipTimeline: "MembershipTimeline" },
      "@/components/locale-provider": { LocalDate: "LocalDate", useI18n: () => ({ ...i18n, t, number: value => new Intl.NumberFormat(locale === "ar" ? "ar-TN" : "en-GB").format(value) }) },
    });
    let member = { ...historyMember("#A", null), times_left: 0 };
    const render = () => renderer.render(() => HistoryMemberCard({ member, isAdmin: false, onReview() {} }));
    let tree = await render(); tree.props.onToggle({ currentTarget: { open: true } }); tree = await render();
    assert.equal(textContent(elements(tree).filter(element => element.type === "dd")[2]), t("Unknown"));
    assert.equal(textContent(elements(tree).filter(element => element.type === "dd")[3]), "0");
    member = { ...member, times_joined: 0, times_left: null }; tree = await render();
    assert.equal(textContent(elements(tree).filter(element => element.type === "dd")[2]), "0");
    assert.equal(textContent(elements(tree).filter(element => element.type === "dd")[3]), t("Unknown"));
  }
});

function historyHarness() {
  const renderer = hookRenderer(), requests = [];
  const Page = loadTypeScript("src/app/history/page.tsx", {
    ...componentMocks, react: renderer.react,
    "@/components/ui/table": tables,
    "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
    "@/components/history-member-card": { HistoryMemberCard: "HistoryMemberCard" },
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: true }) },
    "@/lib/client-data-cache": { invalidateJsonCache() {}, fetchJsonCached: async () => ({ history: [historyMember("#A", "Saved A"), historyMember("#B", "Saved B")] }) },
  }, { window: windowMock, fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })) }).default;
  return { requests, render: () => renderer.render(Page) };
}

test("a delayed note save neither erases another member's draft nor submits duplicate pending saves", async () => {
  const page = historyHarness(); let tree = await page.render();
  editNote(tree, "Saved A"); tree = await page.render(); editor(tree).props.onChange({ target: { value: "Submitted A" } }); tree = await page.render();
  const save = ariaAction(tree, "Save note"); const pending = save(); await save();
  assert.equal(page.requests.length, 1, "Repeated Enter/click actions share the pending save");
  tree = await page.render(); ariaAction(tree, "Cancel")(); tree = await page.render();
  editNote(tree, "Saved B"); tree = await page.render(); editor(tree).props.onChange({ target: { value: "Unsaved B" } }); tree = await page.render();
  page.requests[0].resolve(Response.json({ success: true })); await pending; tree = await page.render();
  assert.equal(editor(tree).props.value, "Unsaved B"); assert.match(textContent(tree), /Submitted A/);
  const saveB = ariaAction(tree, "Save note")();
  assert.deepEqual(JSON.parse(page.requests[1].options.body), { player_tag: "#B", notes: "Unsaved B" });
  page.requests[1].resolve(Response.json({ success: true })); await saveB; tree = await page.render();
  assert.equal(editor(tree), undefined); assert.match(textContent(tree), /Unsaved B/);
});

test("typing more in the same note while its earlier version saves keeps the newer draft", async () => {
  const page = historyHarness(); let tree = await page.render();
  editNote(tree, "Saved A"); tree = await page.render(); editor(tree).props.onChange({ target: { value: "First version" } }); tree = await page.render();
  const pending = ariaAction(tree, "Save note")(); tree = await page.render();
  // Resolve before another render too: the updater must use the latest draft,
  // rather than a ref that is only refreshed during rendering.
  editor(tree).props.onChange({ target: { value: "Further unsaved typing" } });
  page.requests[0].resolve(Response.json({ success: true })); await pending; tree = await page.render();
  assert.equal(editor(tree).props.value, "Further unsaved typing");
});

const notification = id => ({ id, type: "join", title: `Notice ${id}`, message: `Recorded notice ${id}`, is_read: false, created_at: "2026-09-16T12:00:00Z" });
function notificationsHarness(respond) {
  const renderer = hookRenderer(), requests = [];
  const Page = loadTypeScript("src/app/notifications/page.tsx", {
    ...componentMocks, react: renderer.react,
    "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: false }) },
    "@/lib/client-data-cache": { fetchJsonCached: (url, options) => {
      const request = { params: new URL(url, "http://fixture").searchParams, options }; requests.push(request); return respond(request);
    } },
  }, { window: windowMock, console: { ...console, error() {} } }).default;
  return { requests, render: () => renderer.render(Page) };
}
const notificationCards = tree => elements(tree).filter(element => element.type === "Card" && element.key != null);

test("unread Load More uses a stable boundary when earlier notifications were read elsewhere", async () => {
  const rows = Array.from({ length: 104 }, (_, index) => notification(104 - index));
  const cursor = "opaque+/boundary=5";
  const page = notificationsHarness(({ params }) => {
    const visible = rows.filter(row => params.get("unreadOnly") !== "true" || !row.is_read);
    if (params.has("cursor")) {
      assert.equal(params.get("cursor"), cursor); assert.equal(params.has("offset"), false);
      return { notifications: visible.filter(row => row.id < 5).map(row => ({ ...row })), unreadCount: visible.length, nextCursor: null, nextOffset: null };
    }
    return { notifications: visible.slice(0, 100).map(row => ({ ...row })), unreadCount: visible.length, nextCursor: cursor, nextOffset: 100 };
  });
  let tree = await page.render(); action(tree, "Unread (104)")(); tree = await page.render();
  rows.slice(0, 5).forEach(row => { row.is_read = true; });
  await action(tree, "Load More")(); tree = await page.render();
  assert.equal(notificationCards(tree).length, 104);
  assert.ok(notificationCards(tree).some(card => card.key === "1"), "The oldest remaining unread entries must not be skipped");
  assert.equal(elements(tree).some(element => element.props?.onClick && textContent(element).trim() === "Load More"), false);
});

test("a failed cursor page retries its exact boundary and a period change ignores the old page response", async () => {
  let fail = true, resolveOld;
  const page = notificationsHarness(({ params }) => {
    if (!params.has("cursor")) return { notifications: [notification(params.get("range") === "30d" ? 300 : 100)], unreadCount: 3, nextCursor: params.get("range") === "30d" ? null : "after100", nextOffset: 100 };
    if (fail) return Promise.reject(new Error("Offline"));
    return new Promise(resolve => { resolveOld = resolve; });
  });
  let tree = await page.render(); await action(tree, "Load More")(); tree = await page.render();
  assert.match(textContent(tree), /Could not load notifications/); fail = false;
  const old = action(tree, "Retry")();
  assert.equal(page.requests.at(-1).params.get("cursor"), "after100"); assert.equal(page.requests.at(-1).options.force, true);
  elements(tree).find(element => element.type === "TimeRangePicker").props.onChange("30d"); tree = await page.render();
  assert.equal(page.requests.at(-1).params.get("range"), "30d"); assert.equal(page.requests.at(-1).params.has("cursor"), false);
  resolveOld({ notifications: [notification(99)], unreadCount: 2, nextCursor: "after99", nextOffset: null }); await old; tree = await page.render();
  assert.deepEqual(notificationCards(tree).map(card => card.key), ["300"]);
  assert.equal(elements(tree).some(element => element.props?.onClick && textContent(element).trim() === "Load More"), false,
    "An explicit null cursor ends pagination even if a legacy nextOffset is present");
});
