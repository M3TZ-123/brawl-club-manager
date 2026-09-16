const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, windowMock, elements, textContent } = require("./helpers/client-renderer.cjs");

async function renderProfile(memberHistory) {
  const renderer = hookRenderer();
  const member = { player_tag: "#PLAYER", player_name: "Stored player", role: "member", trophies: 1200,
    highest_trophies: 1500, activity_status: "inactive", trio_victories: 5, solo_victories: 2, duo_victories: 3,
    trophies_7d: null, trophies_90d: 40 };
  const Page = loadTypeScript("src/app/members/[tag]/page.tsx", {
    ...componentMocks, react: { ...renderer.react, use: value => value },
    "next/dynamic": () => "Dynamic",
    "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
    "@/components/membership-timeline": { MembershipTimeline: "MembershipTimeline" },
    "@/components/player-progress": { PlayerProgress: "PlayerProgress" },
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: false }) },
    "@/lib/client-data-cache": { fetchJsonCached: async () => ({ member, memberHistory }) },
  }, { window: windowMock, console: { ...console, error() {} } }).default;
  return renderer.render(() => Page({ params: { tag: "%23PLAYER" } }));
}

const badgeTexts = tree => elements(tree).filter(element => element.type === "Badge").map(textContent);

test("a former member with previous returns is labeled Former and receives a truthful stored-profile heading", async () => {
  const history = { player_tag: "#PLAYER", player_name: "Earlier name", is_current_member: false,
    times_joined: 2, times_left: 2, first_seen: "2026-09-01T10:00:00Z", last_seen: "2026-09-15T10:00:00Z",
    last_left_at: "2026-09-15T10:00:00Z", role_at_leave: "senior", trophies_at_leave: 1150 };
  const tree = await renderProfile(history);
  assert.ok(badgeTexts(tree).includes("Former"));
  assert.equal(badgeTexts(tree).includes("Returned"), false);
  assert.equal(badgeTexts(tree).includes("No recorded departures"), false);
  assert.match(textContent(tree), /Stored account snapshot/);
  assert.match(textContent(tree), /This former member's account details come from the latest stored profile\./);
  assert.match(textContent(tree), /Lifetime victories and stored brawlers/);
  assert.doesNotMatch(textContent(tree), /Current account|Lifetime victories and current brawlers/);
  const review = elements(tree).find(element => element.type === "MemberReviewButton");
  for (const field of ["is_current_member", "first_seen", "last_seen", "last_left_at", "times_joined", "times_left", "role_at_leave", "trophies_at_leave"]) {
    assert.equal(review.props.member[field], history[field], field);
  }
  assert.equal(review.props.member.player_name, "Stored player");
  assert.equal(review.props.member.trophies, 1200);
  assert.equal(review.props.member.trophies_90d, 40);
  assert.equal(review.props.initialRange, "7d");
});

test("Returned requires current membership and recorded departure evidence", async () => {
  for (const evidence of [{ times_left: 1, last_left_at: null }, { times_left: null, last_left_at: "2026-09-14T12:00:00Z" }]) {
    const tree = await renderProfile({ is_current_member: true, times_joined: null, ...evidence });
    assert.ok(badgeTexts(tree).includes("Returned"));
    assert.equal(badgeTexts(tree).includes("Former"), false);
    assert.match(textContent(tree), /Current account/);
    assert.doesNotMatch(textContent(tree), /Stored account snapshot/);
  }
  const noDeparture = await renderProfile({ is_current_member: true, times_joined: 2, times_left: null, last_left_at: null });
  assert.equal(badgeTexts(noDeparture).includes("Returned"), false);
});

test("missing membership state is not inferred from counters, and first-current members retain their no-departures badge", async () => {
  for (const history of [null, { is_current_member: null, times_joined: 2, times_left: 1 }]) {
    const tree = await renderProfile(history);
    assert.equal(badgeTexts(tree).includes("Returned"), false);
    assert.equal(badgeTexts(tree).includes("Former"), false);
  }
  const tree = await renderProfile({ is_current_member: true, times_joined: 1, times_left: 0 });
  assert.ok(badgeTexts(tree).includes("No recorded departures"));
});
