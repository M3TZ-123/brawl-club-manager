const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

function hookRenderer() {
  const slots = [];
  const effects = [];
  let cursor = 0;
  let dirty = false;
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  function memo(factory, dependencies) {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { value: factory(), dependencies };
    return slots[index].value;
  }
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, update => {
        const value = typeof update === "function" ? update(slots[index].value) : update;
        if (!Object.is(value, slots[index].value)) dirty = true;
        slots[index].value = value;
      }];
    },
    useMemo: memo,
    useCallback: (callback, dependencies) => memo(() => callback, dependencies),
    useRef: value => memo(() => ({ current: value }), []),
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

const i18n = { t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`)), locale: "en", direction: "ltr", number: value => Number(value).toLocaleString("en-GB"), delta: value => String(value), date: value => value || "Unknown", dateTime: value => value || "Unknown", reportDate: value => value, relative: value => value || "Unknown" };
const componentMocks = {
  "@/components/locale-provider": { T: "T", LocalDate: "LocalDate", LanguageSelector: "LanguageSelector", useI18n: () => i18n },
  "@/components/sync-health": { SyncHealthCard: "SyncHealthCard", DataConfidenceNotice: "DataConfidenceNotice" },
  "@/components/member-review": { MemberReviewButton: "MemberReviewButton", MemberReviewSheet: "MemberReviewSheet" },
  "@/components/ui/sheet": Object.fromEntries(["Sheet", "SheetContent", "SheetHeader", "SheetTitle", "SheetDescription"].map(name => [name, name])),
  "@/components/admin-gate": { AdminGate: "AdminGate" },
  "@/components/layout-wrapper": { LayoutWrapper: "LayoutWrapper" },
  "@/components/stats-cards": { StatsCards: "StatsCards" },
  "@/components/activity-timeline": { ActivityTimeline: "ActivityTimeline" },
  "@/components/ui/button": { Button: "Button" },
  "@/components/ui/input": { Input: "Input" },
  "@/components/ui/badge": { Badge: "Badge" },
  "@/components/ui/card": Object.fromEntries(["Card", "CardContent", "CardHeader", "CardTitle", "CardDescription"].map(name => [name, name])),
  "next/link": "Link",
  "next/image": "Image",
  "lucide-react": new Proxy({}, { get: (_, name) => name }),
};
const windowMock = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
function elements(tree) {
  if (tree == null || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return [tree, ...elements(tree.props?.children)];
}
function textContent(tree) {
  if (tree == null) return "";
  if (Array.isArray(tree)) return tree.map(textContent).join("");
  if (tree?.type === "T") return i18n.t(String(tree.props.text || ""), tree.props.values);
  return typeof tree === "object" ? textContent(tree.props?.children) : String(tree);
}
function action(tree, text) {
  const match = elements(tree).find(element => element.props?.onClick && textContent(element).replace(/\s+/g, " ").trim() === text);
  assert.ok(match, `Missing action: ${text}`);
  return match.props.onClick;
}



test("Arabic preference updates document direction and formatter output without translating IDs", async () => {
  const renderer = hookRenderer();
  const state = { locale: "ar", setLocale(value) { state.locale = value; } };
  const document = { documentElement: { lang: "en", dir: "ltr" } };
  const localeModule = loadTypeScript("src/components/locale-provider.tsx", {
    react: { ...renderer.react, createContext: () => ({ Provider: "Provider" }), useContext: () => state.locale, useMemo: factory => factory() },
    "@/lib/store": { useAppStore: selector => selector(state) },
  }, { document });
  await renderer.render(() => localeModule.LocaleProvider({ children: null }));
  assert.equal(document.documentElement.lang, "ar");
  assert.equal(document.documentElement.dir, "rtl");
  const selector = await renderer.render(() => localeModule.LanguageSelector());
  selector.props.onChange({ target: { value: "en" } });
  assert.equal(state.locale, "en");
  const messages = loadTypeScript("src/lib/i18n/messages.ts");
  assert.equal(messages.translate("First observed", "ar"), "أول رصد");
  assert.match(messages.translate("Every {minutes} minutes", "ar", { minutes: 30 }), /30|٣٠/);
  assert.equal(messages.translate("#9PV9CY9UG", "ar"), "#9PV9CY9UG");
  const formatters = await renderer.render(() => localeModule.useI18n());
  assert.equal(formatters.reportDate("2026-03-01T00:00:00Z"), new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(new Date("2026-03-01T00:00:00Z")));
});

const reviewMember = { player_tag: "#ABC", player_name: "Review fixture", activity_status: "inactive", last_battle_at: "2026-01-01T00:00:00Z", trophies_3d: -15 };
function reviewMocks(renderer) {
  const mocks = { ...componentMocks, react: renderer.react, "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: true }) }, "@/lib/client-data-cache": { invalidateJsonCache() {} } };
  delete mocks["@/components/member-review"];
  return mocks;
}
test("review loads private context and requires a follow-up date before saving", async () => {
  const renderer = hookRenderer(), requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (options.method === "PATCH") return Response.json({ success: true });
    if (url.startsWith("/api/member-reviews?")) return Response.json({ review: { status: "pending", notes: "Private fixture", follow_up_at: null } });
    if (url.startsWith("/api/members/")) return Response.json({ member: reviewMember, memberHistory: { first_seen: "2025-01-01T00:00:00Z", times_joined: 2, times_left: 1 } });
    if (url === "/api/sync/status") return Response.json({ freshness: "stale" });
    throw Error(url);
  };
  const { MemberReviewSheet } = loadTypeScript("src/components/member-review.tsx", reviewMocks(renderer), { fetch, window: windowMock, CustomEvent: class { constructor(type) { this.type = type; } } });
  const render = () => renderer.render(() => MemberReviewSheet({ member: reviewMember, open: true, onOpenChange() {} }));
  let tree = await render();
  assert.match(textContent(tree), /No recently recorded activity/);
  assert.match(textContent(tree), /Data is stale/);
  assert.equal(elements(tree).find(e => e.type === "textarea").props.value, "Private fixture");
  assert.ok(requests.every(request => request.cache === "no-store"));
  const initialLoads = requests.length;
  const previousTranslate = i18n.t;
  i18n.t = (text, values) => previousTranslate(text, values);
  tree = await render();
  assert.equal(requests.length, initialLoads, "Changing language must not reload or discard a review draft");
  i18n.t = previousTranslate;
  elements(tree).find(e => e.type === "select").props.onChange({ target: { value: "follow_up" } });
  tree = await render();
  await action(tree, "Save review")();
  tree = await render();
  assert.match(textContent(tree), /Follow-up date is required/);
  assert.equal(requests.filter(r => r.method === "PATCH").length, 0);
  elements(tree).find(e => e.type === "input" && e.props.type === "datetime-local").props.onChange({ target: { value: "2026-10-01T12:00" } });
  tree = await render();
  await action(tree, "Save review")();
  const saved = JSON.parse(requests.at(-1).body);
  assert.equal(saved.player_tag, "#ABC");
  assert.equal(saved.status, "follow_up");
  assert.equal(saved.notes, "Private fixture");
  assert.equal(saved.follow_up_at, new Date("2026-10-01T12:00").toISOString());
});

test("an unavailable private review cannot expose a blank form that overwrites existing notes", async () => {
  const renderer = hookRenderer();
  const { MemberReviewSheet } = loadTypeScript("src/components/member-review.tsx", reviewMocks(renderer), { fetch: async () => Response.json({ error: "Unavailable" }, { status: 503 }) });
  const tree = await renderer.render(() => MemberReviewSheet({ member: reviewMember, open: true, onOpenChange() {} }));
  assert.match(textContent(tree), /Review unavailable/);
  assert.equal(elements(tree).some(e => e.type === "textarea"), false);
  assert.equal(elements(tree).some(e => e.props?.onClick && textContent(e) === "Save review"), false);
});

test("mobile history expands dates and departure snapshots while keeping private notes admin-only", async () => {
  const renderer = hookRenderer();
  const { HistoryMemberCard } = loadTypeScript("src/components/history-member-card.tsx", { ...componentMocks, react: renderer.react, "@/components/membership-timeline": { MembershipTimeline: "MembershipTimeline" } });
  const member = { ...reviewMember, first_seen: "2025-01-01", last_left_at: null, times_joined: 2, times_left: 1, role_at_leave: "senior", trophies_at_leave: 12345, notes: "Private fixture", is_current_member: true };
  let admin = false;
  const render = () => renderer.render(() => HistoryMemberCard({ member, isAdmin: admin, onReview() {} }));
  let tree = await render();
  assert.equal(elements(tree).some(e => e.type === "MembershipTimeline"), false);
  tree.props.onToggle({ currentTarget: { open: true } });
  tree = await render();
  assert.match(textContent(tree), /First observed/);
  assert.match(textContent(tree), /12,345/);
  assert.doesNotMatch(textContent(tree), /Private fixture/);
  assert.equal(elements(tree).filter(e => e.type === "LocalDate").find(e => e.props.time).props.value, null);
  admin = true; tree = await render();
  assert.match(textContent(tree), /Private fixture/);
  assert.equal(elements(tree).some(e => e.type === "MembershipTimeline"), true);
});

test("timeline preserves provenance, missing snapshots and opaque pagination cursor", async () => {
  const renderer = hookRenderer(), urls = [];
  const { MembershipTimeline } = loadTypeScript("src/components/membership-timeline.tsx", { ...componentMocks, react: renderer.react }, { fetch: async url => {
    urls.push(url);
    return Response.json(urls.length === 1 ? { events: [{ id: "old", eventType: "initial_seen", occurredAt: "2025-01-01T00:00:00Z", source: "reconstructed", before: null, after: null }], nextCursor: "opaque+/=" } : { events: [{ id: "new", eventType: "role_change", occurredAt: "2026-01-01T00:00:00Z", source: "recorded", before: { role: "member" }, after: { role: "senior" } }], nextCursor: null });
  } });
  const render = () => renderer.render(() => MembershipTimeline({ playerTag: "#ABC" }));
  let tree = await render();
  assert.match(textContent(tree), /First observed/);
  assert.match(textContent(tree), /Reconstructed/);
  assert.match(textContent(tree), /No snapshot/);
  await action(tree, "Load More")(); tree = await render();
  assert.equal(new URL(urls[1], "http://fixture").searchParams.get("cursor"), "opaque+/=");
  assert.match(textContent(tree), /Recorded/);
  assert.match(textContent(tree), /senior/);
});

test("sync health displays backend attempt and outcome rather than inferring a next scheduled time", async () => {
  const renderer = hookRenderer();
  const { SyncHealthCard } = loadTypeScript("src/components/sync-health.tsx", { ...componentMocks, react: { ...renderer.react, useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() }, "@/lib/client-sync-status": { subscribeSyncHealth() {}, getServerSyncHealth: () => null, getSyncHealth: () => ({ freshness: "stale", running: false, lastSuccessAt: "2026-01-01T00:00:00Z", lastAttemptAt: "2026-01-01T01:00:00Z", lastOutcome: "failed", expectedIntervalMinutes: 45 }) } });
  const tree = await renderer.render(() => SyncHealthCard());
  assert.match(textContent(tree), /Stale/);
  assert.match(textContent(tree), /failed/);
  assert.match(textContent(tree), /Every 45 minutes/);
  assert.doesNotMatch(textContent(tree), /Next auto sync|cron-job/);
  const rows = elements(tree).filter(e => e.type?.name === "FreshnessRow");
  assert.equal(rows.length, 4);
  assert.equal(rows.find(e => e.props.label === "Full profiles").props.timestamp, "2026-01-01T00:00:00Z");
  assert.equal(rows.find(e => e.props.label === "Complete battle logs").props.timestamp, undefined);
});


test("activity confidence ignores roster freshness and requires full profiles plus complete battle data",async()=>{
 let health={freshness:"stale",fullFreshness:"stale",rosterFreshness:"fresh",battleFreshness:"never"};
 const {DataConfidenceNotice}=loadTypeScript("src/components/sync-health.tsx",{...componentMocks,react:{useSyncExternalStore:(_subscribe,getSnapshot)=>getSnapshot()},"@/lib/client-sync-status":{subscribeSyncHealth(){},getServerSyncHealth:()=>null,getSyncHealth:()=>health}});
 assert.match(textContent(DataConfidenceNotice()),/incomplete or stale/);
 health={...health,freshness:"fresh",fullFreshness:"fresh",battleFreshness:"fresh",rankedFreshness:"stale"};
 assert.equal(DataConfidenceNotice(),null);
 health={...health,latestRun:{scope:"full",status:"succeeded",warnings:["battle_logs_incomplete"]}};
 assert.match(textContent(DataConfidenceNotice()),/recent roster check does not confirm/);
});

test("a successful roster check preserves full warnings and reduced confidence until a complete full result",async()=>{
 const renderer=hookRenderer();
 let health={freshness:"fresh",fullFreshness:"fresh",rosterFreshness:"fresh",battleFreshness:"fresh",rankedFreshness:"fresh",running:false,expectedIntervalMinutes:10,
  lastAttemptAt:"2026-09-16T12:00:00Z",lastOutcome:"succeeded",latestRun:{scope:"roster",status:"succeeded",warnings:[]},
  latestFullRun:{scope:"full",status:"succeeded",finishedAt:"2026-09-16T11:50:00Z",warnings:["battle_logs_incomplete","ranked_rate_limited"]}};
 const {SyncHealthCard,DataConfidenceNotice}=loadTypeScript("src/components/sync-health.tsx",{...componentMocks,react:{...renderer.react,useSyncExternalStore:(_subscribe,getSnapshot)=>getSnapshot()},"@/lib/client-sync-status":{subscribeSyncHealth(){},getServerSyncHealth:()=>null,getSyncHealth:()=>health}});
 let tree=await renderer.render(()=>SyncHealthCard());
 assert.match(textContent(tree),/Some battle logs could not be refreshed/);assert.match(textContent(tree),/ranked provider limited requests/);
 assert.match(textContent(tree),/Last completed full attempt/);assert.match(textContent(tree),/Partial update/);
 assert.match(textContent(DataConfidenceNotice()),/incomplete or stale/);
 assert.ok(elements(tree).some(e=>e.type==="LocalDate"&&e.props.value==="2026-09-16T11:50:00Z"));
 health={...health,latestFullRun:{...health.latestFullRun,status:"failed",warnings:[]}};
 tree=await renderer.render(()=>SyncHealthCard());assert.match(textContent(tree),/latest full sync did not complete/);assert.match(textContent(DataConfidenceNotice()),/incomplete or stale/);
 health={...health,latestFullRun:{...health.latestFullRun,status:"succeeded",warnings:[]}};
 tree=await renderer.render(()=>SyncHealthCard());assert.doesNotMatch(textContent(tree),/Partial update|latest full sync did not complete/);assert.equal(DataConfidenceNotice(),null);
});
