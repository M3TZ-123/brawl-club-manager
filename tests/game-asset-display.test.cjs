const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, windowMock } = require("./helpers/client-renderer.cjs");

test("shared layout includes one concise fan-content footer with the official policy link", async () => {
  const renderer = hookRenderer();
  const state = { sidebarOpen: false, toggleSidebar() {}, setSidebarOpen() {} };
  const { LayoutWrapper } = loadTypeScript("src/components/layout-wrapper.tsx", {
    ...componentMocks, react: { ...renderer.react, createContext: () => ({ Provider: "Provider" }) },
    "next/navigation": { usePathname: () => "/game" },
    "@/lib/store": { useAppStore: () => state },
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: false, isLoading: false }) },
    "@/components/sync-health": { useSyncHealth: () => ({}) },
  }, { window: { ...windowMock, matchMedia: () => ({ matches: false }) } });
  const tree = await renderer.render(() => LayoutWrapper({ children: "Page content" }));
  const footers = elements(tree).filter(node => node.type === "footer");
  assert.equal(footers.length, 1);
  assert.match(textContent(footers[0]), /Unofficial fan content; not endorsed by Supercell/);
  assert.match(footers[0].props.className, /flex-wrap/);
  const link = elements(footers[0]).find(node => node.type === "a");
  assert.equal(link.props.href, "https://supercell.com/en/fan-content-policy/");
  assert.equal(link.props.rel, "noopener noreferrer");
  assert.equal(textContent(link), "Fan Content Policy");
});

test("club badge images use only recorded IDs and preserve before/after history and user text", async () => {
  const renderer = hookRenderer();
  const data = { club: { tag: "#CLUB", metadata: { name: "Club ✨", badgeId: 80000123 }, memberCount: 30, openSeats: 0, leaders: [], observedAt: null },
    metadataHistory: [{ id: "one", observedAt: null, before: { badgeId: 80000456 }, after: { badgeId: 80000123 }, changedFields: ["badgeId"] }] };
  const original = JSON.stringify(data);
  const { ClubIdentity } = loadTypeScript("src/components/club-identity.tsx", { ...componentMocks, react: renderer.react,
    "@/components/brawl-image": { BrawlImage: "BrawlImage" },
    "@/components/club-intelligence-panel": { ClubIntelligencePanel: "Panel", useClubIntelligence: () => ({ data }) },
  });
  let tree = await renderer.render(() => ClubIdentity({ showHistory: true }));
  const images = elements(tree).filter(node => node.type === "BrawlImage");
  assert.deepEqual(images.map(node => node.props.src), [
    "https://cdn.brawlify.com/club-badges/regular/80000123.png",
    "https://cdn.brawlify.com/club-badges/regular/80000456.png",
    "https://cdn.brawlify.com/club-badges/regular/80000123.png",
  ]);
  assert.deepEqual(images.map(node => node.props.alt), ["Club badge", "Previous club badge", "Recorded club badge"]);
  assert.ok(images.every(node => node.props.fallback.type === "Shield"));
  assert.match(textContent(tree), /Club ✨/);
  assert.equal(JSON.stringify(data), original);
  for (const value of [undefined, 0, -1, 1.5, NaN]) {
    data.club.metadata.badgeId = value;
    tree = await renderer.render(() => ClubIdentity({}));
    assert.equal(elements(tree).some(node => node.type === "BrawlImage"), false, String(value));
  }
});
