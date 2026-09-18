const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, action, windowMock, i18n } = require("./helpers/client-renderer.cjs");

// Native details keep descendants mounted, but only the summary is visible when closed.
function visible(tree) {
  if (Array.isArray(tree)) return tree.flatMap(visible);
  if (tree == null || typeof tree !== "object") return [];
  const children = tree.type === "details" && !tree.props.open
    ? elements(tree.props.children).filter(node => node.type === "summary").slice(0, 1)
    : tree.props?.children;
  return [tree, ...visible(children)];
}
const field = (tree, id) => elements(tree).find(node => node.props?.id === id);
const hasVisible = (tree, target) => visible(tree).includes(target);

test("configured settings prioritize activity while credential drafts stay mounted and save errors remain outside disclosures", async () => {
  const renderer = hookRenderer(), writes = [];
  const store = { clubTag: "#PYLQ", apiKeyConfigured: true, discordWebhookConfigured: true, theme: "dark",
    inactivityThreshold: 48, notificationsEnabled: true, hasLoadedSettings: true, isLoadingSettings: false,
    loadSettingsFromDB: async () => {}, setTheme() {},
    saveSettingsToDB: async changes => { writes.push(changes); throw new Error("Save unavailable"); },
  };
  const Page = loadTypeScript("src/app/settings/page.tsx", { ...componentMocks, react: renderer.react,
    "@/lib/store": { useAppStore: () => store },
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: true, isLoading: false }) },
    "@/lib/client-fetch": { fetchJsonWithTimeout: async () => ({ clubTag: "#PYLQ", clubName: "Club", requiredTrophies: 1000 }) },
    "@/components/ui/tabs": Object.fromEntries(["Tabs", "TabsContent", "TabsList", "TabsTrigger"].map(name => [name, name])),
    "@/components/ui/switch": { Switch: "Switch" },
  }, { Error, window: windowMock }).default;
  let tree = await renderer.render(Page);
  assert.equal(elements(tree).find(node => node.type === "Tabs").props.defaultValue, "activity");
  const apiKey = field(tree, "settings-api-key");
  assert.equal(hasVisible(tree, apiKey), false);
  assert.equal(hasVisible(tree, field(tree, "settings-discord-webhook")), false);
  assert.equal(apiKey.props.value, "");
  assert.equal(apiKey.props.type, "password");
  apiKey.props.onChange({ target: { value: "draft-key" } });
  tree = await renderer.render(Page);
  const general = elements(tree).find(node => node.type === "TabsContent" && node.props.value === "general");
  assert.equal(writes.length, 0, "Revealing or editing advanced settings must not save them");
  await elements(general).find(node => node.type === "Button").props.onClick();
  tree = await renderer.render(Page);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].apiKey, "draft-key");
  assert.equal(field(tree, "settings-api-key").props.value, "draft-key");
  assert.ok(visible(tree).some(node => node.props?.role === "alert" && textContent(node).includes("Save unavailable")));
  assert.equal(store.apiKeyConfigured, true);
});

test("notes and conflict controls stay visible while supporting context is collapsed, without changing the exact saved revision", async () => {
  const renderer = hookRenderer(), writes = [];
  const initial = { player_tag: "#PYLQ", notes: "Stored note", status: "pending", follow_up_at: null, updated_at: "2026-09-16T12:00:00.123456+00:00" };
  const { MemberReviewSheet } = loadTypeScript("src/components/member-review.tsx", { ...componentMocks, react: renderer.react,
    "@/components/member-administration": { MemberAdministrationPanel: "MemberAdministrationPanel" },
    "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
    "@/lib/client-fetch": { fetchJsonWithTimeout: async (url, options = {}) => {
      if (options.method === "PATCH") { writes.push(JSON.parse(options.body)); throw new Error("Review changed. Reload before saving."); }
      if (url.startsWith("/api/member-reviews")) return { review: initial };
      if (url === "/api/sync/status") return { fullFreshness: "stale", battleFreshness: "stale", battleCoverage: { status: "possible_gap" } };
      return { member: { player_tag: "#PYLQ", activity_status: "inactive", trophies_7d: null } };
    } }, "@/lib/client-data-cache": { invalidateJsonCache() {} },
  }, { Error, window: windowMock });
  const render = () => renderer.render(() => MemberReviewSheet({ member: { player_tag: "#PYLQ", player_name: "Member" }, open: true, onOpenChange() {} }));
  let tree = await render();
  const editor = elements(tree).find(node => node.type === "textarea");
  assert.equal(hasVisible(tree, editor), true);
  assert.ok(visible(tree).some(node => node.type === "Button" && textContent(node) === "Save note and follow-up"));
  assert.equal(visible(tree).some(node => node.type === "TimeRangePicker"), false);
  assert.equal(visible(tree).some(node => node.props?.role === "status" && textContent(node).includes("possible gap")), false);
  const activityDetails = elements(tree).find(node => node.type === "details" && textContent(node).includes("Activity and membership details"));
  assert.ok(elements(activityDetails).some(node => node.props?.role === "status" && textContent(node).includes("possible gap")), "Uncertainty stays next to the activity it qualifies");
  assert.doesNotMatch(textContent(tree), /Review reason|No recently recorded activity/);
  editor.props.onChange({ target: { value: "Unsaved departure reason" } });
  tree = await render();
  await action(tree, "Save note and follow-up")();
  tree = await render();
  assert.equal(writes[0].expected_updated_at, initial.updated_at);
  assert.equal(elements(tree).find(node => node.type === "textarea").props.value, "Unsaved departure reason");
  assert.ok(visible(tree).some(node => node.props?.role === "alert"));
  assert.ok(visible(tree).some(node => node.type === "Button" && textContent(node) === "Keep my draft"));
  await action(tree, "Save note and follow-up")();
  assert.equal(writes.length, 1, "Collapsing supporting detail must not bypass conflict resolution");
});

test("profile recent-battle expansion is local, preserves unknown points, and resets with a new selected period", async () => {
  const renderer = hookRenderer(), reads = [];
  const recentMatches = Array.from({ length: 8 }, (_, index) => ({ battle_time: `2026-09-16T12:0${index}:00Z`, mode: "gemGrab", map: `Map ${index}`,
    result: "victory", trophy_change: 50, pointData: { change: index === 7 ? null : index, unit: "unknown" }, brawler_name: "Brawler" }));
  const Page = loadTypeScript("src/app/members/[tag]/page.tsx", { ...componentMocks, react: { ...renderer.react, use: value => value },
    "@/components/locale-provider": { ...componentMocks["@/components/locale-provider"], useI18n: () => ({ ...i18n, delta: value => value == null ? "—" : String(value) }) },
    "next/dynamic": () => "Dynamic", "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
    "@/components/player-progress": { PlayerProgress: "PlayerProgress" }, "@/components/membership-timeline": { MembershipTimeline: "MembershipTimeline" },
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: true }) },
    "@/lib/client-data-cache": { fetchJsonCached: async url => { reads.push(url); return { member: { player_tag: "#PYLQ", player_name: "Member", role: "member", trophies: 1000, highest_trophies: 1200,
      activity_status: "active", trio_victories: 2, solo_victories: 1, duo_victories: 0 }, recentMatches }; } },
  }, { window: windowMock }).default;
  const render = () => renderer.render(() => Page({ params: { tag: "%23PYLQ" } }));
  let tree = await render();
  const pointRows = () => elements(tree).filter(node => node.props?.title === "Reported change");
  assert.equal(pointRows().length, 5);
  assert.ok(elements(tree).some(node => node.type === "Badge" && textContent(node) === "5 of 8"));
  assert.equal(reads.length, 1);
  action(tree, "Show all recent battles")();
  tree = await render();
  assert.equal(pointRows().length, 8);
  assert.ok(elements(tree).some(node => node.type === "Badge" && textContent(node) === "8 of 8"));
  assert.match(textContent(pointRows().at(-1)), /—/);
  assert.equal(reads.length, 1);
  action(tree, "Show fewer battles")();
  tree = await render();
  assert.equal(pointRows().length, 5);
  action(tree, "Show all recent battles")();
  tree = await render();
  elements(tree).find(node => node.type === "TimeRangePicker").props.onChange("30d");
  tree = await render();
  assert.equal(reads.length, 2);
  assert.match(reads[1], /range=30d/);
  assert.equal(pointRows().length, 5);
  assert.ok(visible(tree).some(node => node.type === "MemberReviewButton" && node.props.prominent));
  assert.equal(visible(tree).some(node => node.type === "MembershipTimeline"), false);
});

test("healthy diagnostics collapse but sync failures, missing coverage and invalid or critical capacity remain visible", () => {
  const healthyCapacity = { level: "ok", stale: false, sampledAt: "2026-09-17T12:00:00Z", usedBytes: 50000000, budgetBytes: 500000000, percent: 10 };
  let health = { fullFreshness: "fresh", rosterFreshness: "fresh", battleFreshness: "fresh", rankedFreshness: "fresh", expectedIntervalMinutes: 10,
    latestFullRun: { status: "succeeded", scope: "full", warnings: [] }, battleCoverage: { status: "observed" }, capacity: healthyCapacity };
  const { SyncHealthCard } = loadTypeScript("src/components/sync-health.tsx", { ...componentMocks,
    react: { useSyncExternalStore: (_subscribe, get) => get() },
    "@/lib/client-sync-status": { subscribeSyncHealth() {}, getServerSyncHealth: () => null, getSyncHealth: () => health },
  });
  let tree = SyncHealthCard();
  assert.equal(visible(tree).some(node => node.type?.name === "CapacitySection"), false);
  assert.equal(visible(tree).some(node => node.type?.name === "BattleCoverageSection"), false);
  assert.ok(visible(tree).some(node => node.type?.name === "FreshnessRow" && node.props.label === "Battle log fetch"));
  health = { ...health, latestFullRun: { status: "failed", scope: "full", warnings: ["battle_logs_incomplete"] }, battleCoverage: { status: "possible_gap" } };
  for (const capacity of [{ ...healthyCapacity, level: "critical", percent: 90 }, { ...healthyCapacity, stale: true }, { ...healthyCapacity, sampledAt: null }, { ...healthyCapacity, usedBytes: NaN }]) {
    health = { ...health, capacity }; tree = SyncHealthCard();
    assert.ok(visible(tree).some(node => node.type?.name === "CapacitySection"));
    assert.ok(visible(tree).some(node => node.type?.name === "BattleCoverageSection"));
    assert.ok(visible(tree).some(node => node.props?.role === "status" && textContent(node).includes("did not complete")));
    assert.ok(visible(tree).some(node => node.props?.role === "status" && textContent(node).includes("Some battle logs")));
  }
});
