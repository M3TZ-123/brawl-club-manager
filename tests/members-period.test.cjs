const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

function hookRenderer() {
  const slots = [], effects = [];
  let cursor = 0, dirty = false;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory, dependencies) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { value: factory(), dependencies };
    return slots[index].value;
  };
  const react = {
    memo: component => component,
    useMemo: memo,
    useCallback: (callback, dependencies) => memo(() => callback, dependencies),
    useRef: value => memo(() => ({ current: value }), []),
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, update => {
        const value = typeof update === "function" ? update(slots[index].value) : update;
        if (!Object.is(value, slots[index].value)) dirty = true;
        slots[index].value = value;
      }];
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        slots[index]?.cleanup?.();
        slots[index] = { dependencies };
        effects.push(() => { slots[index].cleanup = callback(); });
      }
    },
  };
  return { react, async render(component) {
    for (let pass = 0; pass < 30; pass++) {
      cursor = 0;
      dirty = false;
      const tree = component();
      while (effects.length) effects.shift()();
      await new Promise(resolve => setImmediate(resolve));
      if (!dirty) return tree;
    }
    throw new Error("Client component did not settle");
  } };
}

const i18n = {
  t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`)),
  direction: "ltr", number: value => String(value),
  delta: value => value == null ? "—" : value > 0 ? `+${value}` : String(value),
  relative: value => value || "Unknown", dateTime: value => value || "Unknown",
};
const components = {
  "@/components/locale-provider": { T: "T", LocalDate: "LocalDate", useI18n: () => i18n },
  "@/components/sync-health": { DataConfidenceNotice: "DataConfidenceNotice" },
  "@/components/member-review": { MemberReviewButton: "MemberReviewButton" },
  "@/components/layout-wrapper": { LayoutWrapper: "LayoutWrapper" },
  "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
  "@/components/ui/input": { Input: "Input" },
  "@/components/ui/button": { Button: "Button" },
  "@/components/ui/badge": { Badge: "Badge" },
  "@/components/ui/switch": { Switch: "Switch" },
  "@/components/ui/card": Object.fromEntries(["Card", "CardContent", "CardHeader", "CardTitle"].map(name => [name, name])),
  "@/components/ui/sheet": Object.fromEntries(["Sheet", "SheetContent", "SheetHeader", "SheetTitle", "SheetDescription"].map(name => [name, name])),
  "@/components/ui/table": Object.fromEntries(["Table", "TableBody", "TableCell", "TableHead", "TableHeader", "TableRow"].map(name => [name, name])),
  "next/link": "Link", "next/image": "Image",
  "lucide-react": new Proxy({}, { get: (_, name) => name }),
};
function elements(tree) {
  if (tree == null || typeof tree !== "object") return [];
  return Array.isArray(tree) ? tree.flatMap(elements) : [tree, ...elements(tree.props?.children)];
}
function textContent(tree) {
  if (tree == null) return "";
  if (Array.isArray(tree)) return tree.map(textContent).join("");
  if (tree?.type === "T") return i18n.t(tree.props.text || "", tree.props.values);
  return typeof tree === "object" ? textContent(tree.props?.children) : String(tree);
}
function find(tree, type) {
  const element = elements(tree).find(element => element.type === type);
  assert.ok(element, `Missing ${type}`);
  return element;
}
function action(tree, label) {
  const element = elements(tree).find(element => element.props?.onClick && textContent(element).replace(/\s+/g, " ").trim() === label);
  assert.ok(element, `Missing action ${label}`);
  return element.props.onClick;
}
function quickFilter(tree, label) {
  const element = elements(tree).find(element => element.type === "button" && elements(element).some(child => child.type === "T" && child.props.text === label));
  assert.ok(element, `Missing quick filter ${label}`);
  return element.props.onClick;
}
function summary(tree, title) {
  const card = elements(tree).find(element => element.type?.name === "SummaryCard" && element.props.title === title);
  assert.ok(card, `Missing summary ${title}`);
  return card.props;
}
const member = (name, metrics) => ({
  player_tag: `#${name}`, player_name: name, role: "member", trophies: 10000,
  highest_trophies: 11000, rank_current: null, rank_highest: null, win_rate: null,
  brawlers_count: 20, trio_victories: 100, icon_id: null,
  activity_status: "active", last_updated: "2026-09-16T00:00:00Z", last_battle_at: "2026-09-15T23:00:00Z", ...metrics,
});
const fixtures = [
  member("Alpha", { trophies_24h: 100, trophies_3d: 0, trophies_7d: 20, trophies_30d: -10, trophies_90d: null }),
  member("Bravo", { trophies_24h: 1, trophies_3d: 9, trophies_7d: 0, trophies_30d: 40, trophies_90d: 30 }),
  member("Charlie", { trophies_24h: 0, trophies_3d: 15, trophies_7d: -5, trophies_30d: null, trophies_90d: 0 }),
  member("Delta", { trophies_24h: null, trophies_3d: null, trophies_7d: null, trophies_30d: null, trophies_90d: null }),
];

function pageHarness({ isAdmin = false, members = fixtures } = {}) {
  const renderer = hookRenderer(), downloads = [], blobs = [];
  const tableModule = loadTypeScript("src/components/members-table.tsx", { ...components, react: renderer.react });
  const { default: MembersPage } = loadTypeScript("src/app/members/page.tsx", {
    ...components, react: renderer.react,
    "@/components/members-table": { ...tableModule, MembersTable: "MembersTable" },
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin, isLoading: false }) },
    "@/lib/store": { useAppStore: () => ({ clubTag: "#CLUB", apiKeyConfigured: true, isSyncing: false, setIsSyncing() {}, setLastSyncTime() {} }) },
    "@/lib/client-data-cache": { fetchJsonCached: async url => { assert.equal(url, "/api/members"); return { members }; }, invalidateJsonCache() {} },
  }, {
    window: { addEventListener() {}, removeEventListener() {}, clearTimeout() {} },
    Blob: class { constructor(parts) { this.text = parts.join(""); } },
    URL: { createObjectURL(blob) { blobs.push(blob.text); return "blob:test"; }, revokeObjectURL() {} },
    document: { createElement(tag) { assert.equal(tag, "a"); return { click() { downloads.push(this.download); } }; } },
  });
  return { render: () => renderer.render(MembersPage), downloads, blobs };
}
const names = tree => Array.from(find(tree, "MembersTable").props.members, member => member.player_name);

test("members default to seven-day progress, with one progress column and period-aware summaries", async () => {
  const page = pageHarness();
  const tree = await page.render(), table = find(tree, "MembersTable");
  assert.equal(find(tree, "TimeRangePicker").props.value, "7d");
  assert.equal(table.props.timeRange, "7d");
  assert.equal(table.props.sortState.key, "progress");
  assert.deepEqual(names(tree), ["Alpha", "Bravo", "Charlie", "Delta"]);
  assert.equal(table.props.columnVisibility.progress, true);
  for (const metric of ["trophies_24h", "trophies_3d", "trophies_7d", "trophies_30d", "trophies_90d"]) assert.equal(table.props.columnVisibility[metric], false);
  assert.equal(summary(tree, "Progress · 7 days").value, "+15");
  assert.equal(summary(tree, "Progress · 7 days").description, "3 of 4 members have period data");
  assert.equal(summary(tree, "Gained trophies").value, "1");
});

test("changing the selected period updates gain filters, sort order, and null placement", async () => {
  const page = pageHarness();
  let tree = await page.render();
  quickFilter(tree, "Gained trophies")(); tree = await page.render();
  assert.deepEqual(names(tree), ["Alpha"]);
  find(tree, "TimeRangePicker").props.onChange("30d"); tree = await page.render();
  assert.deepEqual(names(tree), ["Bravo"]);
  assert.equal(summary(tree, "Progress · 1 month").value, "+40");
  quickFilter(tree, "All")(); tree = await page.render();
  assert.deepEqual(names(tree), ["Bravo", "Alpha", "Charlie", "Delta"]);
  find(tree, "MembersTable").props.onSort("progress"); tree = await page.render();
  assert.deepEqual(names(tree), ["Alpha", "Bravo", "Charlie", "Delta"], "Missing baselines remain last in ascending order");
  find(tree, "TimeRangePicker").props.onChange("24h"); tree = await page.render();
  assert.deepEqual(names(tree), ["Charlie", "Bravo", "Alpha", "Delta"]);
  find(tree, "TimeRangePicker").props.onChange("3d"); tree = await page.render();
  assert.deepEqual(names(tree), ["Alpha", "Bravo", "Charlie", "Delta"]);
});

test("zero progress and missing history remain distinct across long periods and advanced filters", async () => {
  const page = pageHarness();
  let tree = await page.render();
  quickFilter(tree, "No Progress")(); tree = await page.render();
  assert.deepEqual(names(tree), ["Bravo"]);
  find(tree, "TimeRangePicker").props.onChange("90d"); tree = await page.render();
  assert.deepEqual(names(tree), ["Charlie"]);
  assert.equal(summary(tree, "Progress · 3 months").value, "0");
  find(tree, "TimeRangePicker").props.onChange("30d"); tree = await page.render();
  assert.deepEqual(names(tree), []);
  assert.equal(summary(tree, "Progress · 1 month").value, "Not enough history");
  quickFilter(tree, "All")(); action(tree, "Advanced Filters")(); tree = await page.render();
  const movement = elements(tree).find(element => element.type === "select" && elements(element).some(option => option.type === "option" && option.props.value === "positive"));
  movement.props.onChange({ target: { value: "unknown" } }); tree = await page.render();
  assert.deepEqual(names(tree), ["Charlie", "Delta"]);
  assert.equal(summary(tree, "Progress · 1 month").value, "Not enough history");
  find(tree, "TimeRangePicker").props.onChange("90d"); tree = await page.render();
  assert.deepEqual(names(tree), ["Alpha", "Delta"]);
});

test("member detail and CSV use the selected period and only explicitly enabled comparisons", async () => {
  const page = pageHarness({ members: [fixtures[0], { ...fixtures[2], player_name: "=Formula fixture" }] });
  let tree = await page.render();
  find(tree, "TimeRangePicker").props.onChange("30d"); tree = await page.render();
  find(tree, "MembersTable").props.onMemberSelect(fixtures[0]); tree = await page.render();
  const sheet = find(tree, "SheetContent");
  assert.match(textContent(sheet), /Trophy progress · Last 30 days-10/);
  assert.doesNotMatch(textContent(sheet), /\+100/);
  action(tree, "Columns")(); tree = await page.render();
  elements(tree).find(element => element.type === "Switch" && element.props["aria-label"] === "Toggle 24h column").props.onCheckedChange(true);
  elements(tree).find(element => element.type === "Switch" && element.props["aria-label"] === "Toggle 1 month column").props.onCheckedChange(true);
  tree = await page.render();
  action(tree, "Export")();
  assert.match(page.downloads[0], /^club-members-30d-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = page.blobs[0].split("\n");
  assert.equal(lines[0].split("Trophy progress · Last 30 days").length - 1, 1, "Selected period must not be exported twice");
  assert.match(lines[0], /Trophy progress · Last 30 days,Trophy progress · Last 24 hours/);
  assert.doesNotMatch(lines[0], /Last 3 days|Last 7 days/);
  assert.equal(lines[1].split(",")[5], "'-10");
  assert.equal(lines[1].split(",")[6], "100");
  assert.equal(lines[2].split(",")[5], "", "Unknown period progress must remain empty in CSV");
  assert.equal(lines[2].split(",")[1], "'=Formula fixture", "CSV formula protection must survive new export fields");
});

test("visitor member details expose the notes entry point while sync controls stay admin-only", async () => {
  const publicPage = pageHarness();
  let tree = await publicPage.render();
  find(tree, "MembersTable").props.onMemberSelect(fixtures[0]); tree = await publicPage.render();
  assert.equal(elements(tree).some(element => element.type === "MemberReviewButton"), true);
  assert.doesNotMatch(textContent(tree), /Sync Now/);
  assert.equal(elements(tree).some(element => element.type === "Link" && element.props.href === "/reviews"), false);
  const adminPage = pageHarness({ isAdmin: true });
  tree = await adminPage.render();
  find(tree, "TimeRangePicker").props.onChange("30d"); tree = await adminPage.render();
  find(tree, "MembersTable").props.onMemberSelect(fixtures[0]); tree = await adminPage.render();
  assert.equal(find(tree, "MemberReviewButton").props.initialRange, "30d");
  assert.match(textContent(tree), /Sync Now/);
  assert.match(textContent(tree), /Member notes/);
  assert.doesNotMatch(textContent(tree), /Member reviews/);
});

function reviewHarness({ initialRange, failure, failedSaves = 0, sync = {}, reviewMember = fixtures[0], memberHistory = { first_seen: "2025-01-01", times_joined: 1, times_left: 0 } } = {}) {
  const renderer = hookRenderer(), requests = [];
  const { MemberReviewSheet } = loadTypeScript("src/components/member-review.tsx", {
    ...components, react: renderer.react,
    "@/lib/client-data-cache": { invalidateJsonCache() {} },
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: true }) },
  }, {
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      if (options.method === "PATCH") return failedSaves-- > 0 ? Response.json({ error: "Unavailable" }, { status: 503 }) : Response.json({ success: true });
      const endpoint = url.startsWith("/api/member-reviews?") ? "review" : url.startsWith("/api/members/") ? "member" : url === "/api/sync/status" ? "sync" : null;
      assert.ok(endpoint, `Unexpected request ${url}`);
      if (endpoint === failure) return Response.json({ error: "Unavailable" }, { status: 503 });
      if (endpoint === "review") return Response.json({ review: { status: "pending", notes: "Saved note", follow_up_at: null } });
      if (endpoint === "member") return Response.json({ member: reviewMember, memberHistory });
      return Response.json({ freshness: "fresh", fullFreshness: "fresh", battleFreshness: "fresh", ...sync });
    },
    window: { dispatchEvent() {} }, CustomEvent: class { constructor(type) { this.type = type; } },
  });
  return { requests, render: () => renderer.render(() => MemberReviewSheet({ member: reviewMember, initialRange, open: true, onOpenChange() {} })) };
}

test("review analysis uses the chosen period without reloading or losing the private draft", async () => {
  const review = reviewHarness({ initialRange: "30d" });
  let tree = await review.render();
  assert.equal(find(tree, "TimeRangePicker").props.value, "30d");
  assert.match(textContent(tree), /Trophy progress · Last 30 days: -10/);
  assert.match(textContent(tree), /No trophy progress in the selected period/);
  assert.doesNotMatch(textContent(tree), /3-day progress/);
  find(tree, "textarea").props.onChange({ target: { value: "Unsaved private draft" } });
  find(tree, "select").props.onChange({ target: { value: "reviewed" } });
  find(tree, "TimeRangePicker").props.onChange("7d"); tree = await review.render();
  assert.match(textContent(tree), /Trophy progress · Last 7 days: \+20/);
  assert.match(textContent(tree), /Review reason: Manual review/);
  assert.equal(find(tree, "textarea").props.value, "Unsaved private draft");
  assert.equal(find(tree, "select").props.value, "reviewed");
  find(tree, "TimeRangePicker").props.onChange("90d"); tree = await review.render();
  assert.match(textContent(tree), /Trophy progress · Last 90 days: Not enough history/);
  assert.equal(review.requests.length, 3, "Period selection must not reload the form or refetch all five available metrics");
  await action(tree, "Save review")();
  const saved = JSON.parse(review.requests.at(-1).body);
  assert.equal(saved.notes, "Unsaved private draft");
  assert.equal(saved.status, "reviewed");
  assert.equal(saved.player_tag, fixtures[0].player_tag);
});

test("a failed private review read keeps the editing form and Save action unavailable", async () => {
  for (const failure of ["review"]) {
    const review = reviewHarness({ failure });
    const tree = await review.render();
    assert.match(textContent(tree), /Review unavailable/, failure);
    assert.equal(elements(tree).some(element => element.type === "textarea"), false, failure);
    assert.equal(elements(tree).some(element => element.props?.onClick && textContent(element) === "Save review"), false, failure);
    assert.equal(review.requests.some(request => request.method === "PATCH"), false);
  }
});

test("unavailable supporting activity never hides an existing private note", async () => {
  for (const failure of ["member", "sync"]) {
    const review = reviewHarness({ failure });
    const tree = await review.render();
    assert.equal(find(tree, "textarea").props.value, "Saved note");
    assert.match(textContent(tree), /Activity details are unavailable/);
    assert.equal(typeof action(tree, "Save review"), "function");
  }
});

test("unknown membership counts stay unknown while an observed zero remains zero", async () => {
  let review = reviewHarness({ memberHistory: { first_seen: null, times_joined: null, times_left: 0 } });
  let tree = await review.render();
  assert.match(textContent(tree), /Observed joins: Unknown · Observed departures: 0/);
  review = reviewHarness({ memberHistory: { first_seen: null, times_joined: 1, times_left: null } });
  tree = await review.render();
  assert.match(textContent(tree), /Observed joins: 1 · Observed departures: Unknown/);
});

test("retrying a failed review save preserves and resubmits the unsaved draft", async () => {
  const review = reviewHarness({ failedSaves: 1 });
  let tree = await review.render();
  find(tree, "textarea").props.onChange({ target: { value: "Keep this private draft" } });
  find(tree, "select").props.onChange({ target: { value: "reviewed" } });
  tree = await review.render();
  await action(tree, "Save review")(); tree = await review.render();
  assert.match(textContent(tree), /Review unavailable/);
  await action(tree, "Retry")(); tree = await review.render();
  assert.equal(find(tree, "textarea").props.value, "Keep this private draft");
  assert.equal(find(tree, "select").props.value, "reviewed");
  assert.equal(review.requests.filter(request => !request.method).length, 3, "A failed save must not reload old persisted notes");
  const saved = review.requests.filter(request => request.method === "PATCH").map(request => JSON.parse(request.body));
  assert.equal(saved.length, 2);
  assert.ok(saved.every(body => body.notes === "Keep this private draft" && body.status === "reviewed"));
  assert.match(textContent(tree), /Review saved/);
});

test("fresh review data still shows possible history gaps and incomplete battle refreshes", async () => {
  const gap = reviewHarness({ sync: { battleCoverage: { status: "possible_gap" } } });
  let tree = await gap.render();
  assert.equal(find(tree, "TimeRangePicker").props.value, "7d");
  assert.match(textContent(tree), /A possible gap remains in the recorded battle history/);
  assert.match(textContent(tree), /A fresh fetch does not recover earlier battles/);
  const partial = reviewHarness({ sync: { latestFullRun: { status: "succeeded", warnings: ["battle_logs_incomplete"] } } });
  tree = await partial.render();
  assert.match(textContent(tree), /Data is stale/);
  const outdated = reviewHarness({ sync: { battleFreshness: "stale" } });
  tree = await outdated.render();
  assert.match(textContent(tree), /Data is stale/);
});

test("reopening a review button initializes analysis from the caller's current selected period", async () => {
  const renderer = hookRenderer();
  const { MemberReviewButton } = loadTypeScript("src/components/member-review.tsx", {
    ...components, react: renderer.react,
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: true }) },
  });
  let initialRange = "7d";
  const render = () => renderer.render(() => MemberReviewButton({ member: fixtures[0], initialRange }));
  let tree = await render();
  assert.equal(elements(tree).some(element => element.type?.name === "MemberReviewSheet"), false);
  initialRange = "30d"; tree = await render();
  action(tree, "Member notes")(); tree = await render();
  let sheet = elements(tree).find(element => element.type?.name === "MemberReviewSheet");
  assert.equal(sheet.props.initialRange, "30d");
  sheet.props.onOpenChange(false); tree = await render();
  assert.equal(elements(tree).some(element => element.type?.name === "MemberReviewSheet"), false);
  initialRange = "90d"; tree = await render();
  action(tree, "Member notes")(); tree = await render();
  sheet = elements(tree).find(element => element.type?.name === "MemberReviewSheet");
  assert.equal(sheet.props.initialRange, "90d");
});

test("desktop and mobile render the same selected metric and never duplicate its optional comparison", async () => {
  const renderer = hookRenderer();
  const { MembersTable, DEFAULT_MEMBER_COLUMNS } = loadTypeScript("src/components/members-table.tsx", { ...components, react: renderer.react });
  let timeRange = "30d", columnVisibility = { ...DEFAULT_MEMBER_COLUMNS, trophies_24h: true, trophies_30d: true };
  const render = () => renderer.render(() => MembersTable({ members: [fixtures[0], fixtures[2]], timeRange, columnVisibility, onSort() {} }));
  let tree = await render();
  const heads = elements(tree).filter(element => element.type?.name === "SortableHead");
  assert.equal(heads.filter(head => head.props.sortKey === "progress").length, 1);
  assert.equal(heads.find(head => head.props.sortKey === "progress").props.label, "Progress · 1 month");
  assert.equal(heads.some(head => head.props.sortKey === "trophies_30d"), false);
  assert.equal(heads.some(head => head.props.sortKey === "trophies_24h"), true);
  const cells = elements(find(tree, "TableBody")).filter(element => element.type === "TableCell");
  assert.equal(cells.filter(cell => textContent(cell) === "Not enough history").length, 1);
  assert.match(textContent(tree), /Progress · 1 month-10/);
  assert.doesNotMatch(textContent(tree), /Progress · 7 days/);
  timeRange = "90d"; columnVisibility = DEFAULT_MEMBER_COLUMNS; tree = await render();
  assert.match(textContent(tree), /Progress · 3 monthsNot enough history/);
  assert.match(textContent(tree), /Progress · 3 months0/);
  timeRange = "30d"; columnVisibility = { ...DEFAULT_MEMBER_COLUMNS, progress: false, trophies_30d: true }; tree = await render();
  assert.doesNotMatch(textContent(tree), /Progress · 1 month/);
  assert.match(textContent(tree), /1 month-10/, "Explicit comparison remains visible after hiding the selected progress column");
  assert.equal(elements(tree).filter(element => element.type?.name === "SortableHead" && element.props.sortKey === "trophies_30d").length, 1);
});

test("desktop and mobile member action names follow the selected language without altering player tags", async () => {
  const { translate } = loadTypeScript("src/lib/i18n/messages.ts");
  for (const locale of ["en", "ar"]) {
    const renderer = hookRenderer();
    const { MembersTable } = loadTypeScript("src/components/members-table.tsx", {
      ...components, react: renderer.react,
      "@/components/locale-provider": { T: "T", useI18n: () => ({ ...i18n, t: (key, values) => translate(key, locale, values) }) },
    });
    const member = { ...fixtures[0], player_name: "لاعب Alpha", player_tag: "#PYLQ" };
    const tree = await renderer.render(() => MembersTable({ members: [member] }));
    const labels = elements(tree).map(element => element.props?.["aria-label"]).filter(Boolean);
    const copyLabel = locale === "ar" ? "نسخ الوسم #PYLQ" : "Copy tag #PYLQ";
    const profileLabel = locale === "ar" ? "فتح ملف لاعب Alpha" : "Open لاعب Alpha profile";
    assert.equal(labels.filter(label => label === copyLabel).length, 2, "Both mobile and desktop copy controls are localized");
    assert.equal(labels.filter(label => label === profileLabel).length, 2, "Both profile links are localized");
    assert.equal(elements(tree).filter(element => element.type === "Link" && element.props.href === "/members/%23PYLQ").length, 2);
  }
});
