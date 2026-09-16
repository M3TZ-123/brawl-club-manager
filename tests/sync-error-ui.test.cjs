const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, action, windowMock } = require("./helpers/client-renderer.cjs");

const cases = [
  ["database_timeout", "Sync took too long. Please try again."],
  ["backup_busy", "A backup is in progress. Please try again shortly."],
];
const profile = { player_tag: "#ONE", player_name: "One", trophies: 1000, highest_trophies: 1000, role: "member", activity_status: "active", trio_victories: 1, solo_victories: 1, duo_victories: 1 };

for (const [code, expected] of cases) {
  test(`${code} is routed to user-facing copy in setup, members, member refresh and sidebar`, async () => {
    for (const scope of ["setup", "members", "member", "sidebar"]) {
      const renderer = hookRenderer(), requests = [], alerts = [], syncing = [];
      const store = {
        clubTag: "#CLUB", apiKeyConfigured: true, isSyncing: false, sidebarOpen: true,
        setIsSyncing(value) { syncing.push(value); }, setLastSyncTime() { assert.fail("Failure must not advance sync time"); },
        loadSettingsFromDB: async () => {}, setSidebarOpen() {}, toggleSidebar() {},
      };
      const storeHook = Object.assign(() => store, { getState: () => store });
      const mocks = {
        ...componentMocks,
        react: { ...renderer.react, use: value => value, createContext: () => ({ Provider: "Provider" }), useContext: () => ({ isOpen: true, close() {}, toggle() {} }) },
        "next/dynamic": () => "Dynamic",
        "next/navigation": { usePathname: () => "/members" },
        "@/lib/store": { useAppStore: storeHook },
        "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: true, isLoading: false }) },
        "@/components/sync-health": { DataConfidenceNotice: "DataConfidenceNotice", useSyncHealth() {} },
        "@/components/members-table": { MembersTable: "MembersTable", DEFAULT_MEMBER_COLUMNS: {} },
        "@/components/ui/switch": { Switch: "Switch" },
        "@/lib/client-data-cache": { fetchJsonCached: async () => scope === "members" ? { members: [profile] } : { member: profile }, invalidateJsonCache() { assert.fail("Failed sync must not invalidate successful data"); } },
      };
      const globals = { window: { ...windowMock, matchMedia: () => ({ matches: false }) }, console: { error() {} }, alert: message => alerts.push(message),
        fetch: async (url, options) => {
          requests.push({ url, options });
          return Response.json({ code, error: "The database canceled the sync. Retry with a new request ID." }, { status: 503 });
        },
      };
      let component;
      if (scope === "setup") component = loadTypeScript("src/components/setup-wizard.tsx", mocks, globals).SetupWizard;
      else if (scope === "members") component = loadTypeScript("src/app/members/page.tsx", mocks, globals).default;
      else if (scope === "member") {
        const Page = loadTypeScript("src/app/members/[tag]/page.tsx", mocks, globals).default;
        component = () => Page({ params: { tag: "%23ONE" } });
      } else {
        const loaded = loadTypeScript("src/components/layout-wrapper.tsx", mocks, globals);
        const outer = await renderer.render(() => loaded.LayoutWrapper({ children: null }));
        component = elements(outer).find(node => node.type?.name === "SimpleSidebar").type;
      }
      let tree = await renderer.render(component);
      await action(tree, scope === "setup" ? "Start Using App" : scope === "member" ? "Refresh Stats" : "Sync Now")();
      tree = await renderer.render(component);
      const displayed = scope === "sidebar" ? alerts.join(" ") : textContent(tree);
      assert.ok(displayed.includes(expected), `${scope} must show the mapped ${code} message`);
      assert.doesNotMatch(displayed, /request ID|database canceled/);
      assert.equal(requests.length, 1); assert.equal(requests[0].options.method, "POST");
      assert.equal(requests[0].url, scope === "member" ? "/api/members/%23ONE" : "/api/sync");
      if (scope === "members" || scope === "sidebar") assert.deepEqual(syncing, [true, false]);
      if (scope === "setup") assert.ok(elements(tree).some(node => node.props?.onClick && textContent(node).trim() === "Start Using App"), "Setup remains retryable");
    }
  });
}

test("retryable sync copy is localized and unrelated errors keep their existing fallback", () => {
  const { syncErrorMessage } = loadTypeScript("src/lib/sync-error-message.ts");
  const { translate } = loadTypeScript("src/lib/i18n/messages.ts");
  for (const [code, expected] of cases) {
    assert.equal(syncErrorMessage({ code }), expected);
    const arabic = translate(expected, "ar"); assert.notEqual(arabic, expected); assert.match(arabic, /حاول مجددًا/);
  }
  for (const value of [null, {}, "database_timeout", { code: "sync_busy", error: "Existing message" }]) assert.equal(syncErrorMessage(value), null);
});
