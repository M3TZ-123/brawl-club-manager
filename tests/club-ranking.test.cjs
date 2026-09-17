const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { componentMocks, elements, textContent, i18n, hookRenderer } = require("./helpers/client-renderer.cjs");

const NOW = "2026-09-18T12:00:00.000Z";
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return Date.parse(NOW); }
}
const observation = (at, rank, extra = {}) => ({ tag: "#PYLQ", region: "TN", at, rank, trophies: 100000, ...extra });
const logic = () => loadTypeScript("src/lib/club-ranking.ts", {}, { Date: FixedDate });
const summarize = rows => logic().summarizeClubRanking("#PYLQ", "TN", rows);
const serialized = value => JSON.parse(JSON.stringify(value));

function render(rows, props = {}, locale = "en") {
  const { arClubRanking } = loadTypeScript("src/lib/i18n/ar-club-ranking.ts");
  const local = { ...i18n, t: (key, values = {}) => (locale === "ar" ? arClubRanking[key] || key : key)
    .replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`)) };
  const { ClubRankingSummary } = loadTypeScript("src/components/club-ranking-summary.tsx", {
    ...componentMocks, react: { useState: initial => [initial(), () => {}], useEffect() {} },
    "@/components/locale-provider": { useI18n: () => local },
  }, { Date: FixedDate });
  return ClubRankingSummary({ tag: "#PYLQ", region: "TN", observations: rows, rankingAt: NOW, rankingStale: false, ...props });
}

test("ranking uses the latest observation for each actual UTC day, normalizes tags and leaves its input unchanged", () => {
  const rows = Object.freeze([
    observation("2026-09-18T05:00:00Z", 5),
    observation("2026-09-16T08:00:00Z", 10),
    observation("2026-09-17T23:30:00-02:00", 7),
    observation("2026-09-17T23:50:00Z", 9, { tag: " %23pylq " }),
    observation("2026-09-16T16:00:00Z", 8),
  ].map(Object.freeze));
  const before = JSON.stringify(rows), result = summarize(rows);
  assert.deepEqual(serialized(result.history.map(row => [row.day, row.rank])), [["2026-09-16", 8], ["2026-09-17", 9], ["2026-09-18", 5]]);
  assert.equal(result.latest.at, "2026-09-18T05:00:00.000Z");
  assert.equal(result.previous.rank, 9);
  assert.equal(result.placesGained, 4);
  assert.equal(result.hasChart, true);
  assert.equal(JSON.stringify(rows), before);
});

test("wrong clubs and regions, malformed ranks or timestamps, and future data do not establish a ranking", () => {
  const rows = [
    observation("2026-09-17T12:00:00Z", 50),
    ...[0, 51, -1, 2.5, NaN, Infinity, "2", undefined].map(rank => observation("2026-09-18T10:00:00Z", rank)),
    observation("2026-09-18T12:00:00.001Z", 1),
    observation("bad timestamp", 1),
    observation("2026-09-18T10:00:00Z", 1, { tag: "#QGRJ" }),
    observation("2026-09-18T10:00:00Z", 1, { region: "global" }),
    observation("2026-09-18T10:00:00Z", 1, { tag: "not-a-tag" }),
  ];
  const result = summarize(rows);
  assert.equal(result.latest.rank, 50);
  assert.equal(result.history.length, 1);
  assert.equal(result.placesGained, null);
  assert.equal(result.hasChart, false);
  assert.equal(logic().summarizeClubRanking("invalid", "TN", rows).latest, null);
  assert.equal(summarize([observation(NOW, 1)]).latest.rank, 1, "The exact current timestamp is valid");
});

test("numeric changes compare only the immediately previous recorded day without skipping unknown ranks", () => {
  for (const [latest, previous, expected] of [[5, 8, 3], [8, 5, -3], [5, 5, 0], [null, 5, null], [5, null, null], [null, null, null]]) {
    const result = summarize([
      observation("2026-09-10T12:00:00Z", 20),
      observation("2026-09-14T12:00:00Z", previous),
      observation("2026-09-18T10:00:00Z", latest),
    ]);
    assert.equal(result.placesGained, expected);
    assert.equal(result.previous.day, "2026-09-14");
    assert.equal(result.latest.state, latest === null ? "outside_top50" : "ranked");
  }
  assert.equal(summarize([observation("2026-09-18T09:00:00Z", 10), observation("2026-09-18T10:00:00Z", 5)]).placesGained, null, "Two updates on the same day are not a daily comparison");
});

test("duplicate timestamps are deterministic and conflicting ranks do not imply absence from the top 50", () => {
  const rows = [observation("2026-09-17T12:00:00Z", 8), observation("2026-09-18T10:00:00Z", 5), observation("2026-09-18T10:00:00Z", null)];
  const forward = summarize(rows), reverse = summarize([...rows].reverse());
  assert.deepEqual(serialized(forward), serialized(reverse));
  assert.equal(forward.latest.state, "conflicting");
  assert.equal(forward.placesGained, null);
  const duplicate = summarize([observation(NOW, 4), observation(NOW, 4)]);
  assert.equal(duplicate.latest.state, "ranked");
  assert.equal(duplicate.history.length, 1);
});

test("display distinguishes no observed ranking, explicit missing top50 entry, and a real rank with its own timestamp", () => {
  const empty = render([]);
  assert.match(textContent(empty), /Your club's ranking/);
  assert.match(textContent(empty), /No ranking recorded for this club in this region yet/);
  assert.match(textContent(empty), /Ranking list last checked/);
  assert.doesNotMatch(textContent(empty), /Not listed in the recorded top 50|Latest recorded rank/);
  const outside = render([observation("2026-09-17T09:00:00Z", null)]);
  assert.match(textContent(outside), /Not listed in the recorded top 50/);
  assert.doesNotMatch(textContent(outside), /No ranking recorded|#0|Up|Down/);
  const ranked = render([observation("2026-09-17T09:00:00Z", 7)]);
  assert.match(textContent(ranked), /Latest recorded rank: #7/);
  const times = elements(ranked).filter(node => node.type === "time");
  assert.equal(times.length, 1);
  assert.equal(times[0].props.dateTime, "2026-09-17T09:00:00.000Z", "Use actual club observation, not newer cache timestamp");
  assert.ok(elements(ranked).some(node => node.type === "section" && node.props["aria-label"] === "Your club's ranking"));
});

test("movement language reports direction and the previous recorded date rather than inventing yesterday", () => {
  for (const [latest, expected] of [[3, "Up 5 places"], [12, "Down 4 places"], [7, "Up 1 place"], [9, "Down 1 place"], [8, "Rank unchanged"]]) {
    const tree = render([observation("2026-09-14T12:00:00Z", 8), observation("2026-09-18T09:00:00Z", latest)]);
    assert.ok(textContent(tree).includes(expected));
    assert.match(textContent(tree), /Compared with the previous recorded observation/);
    assert.ok(elements(tree).some(node => node.type === "time" && node.props.dateTime === "2026-09-14T12:00:00.000Z"));
    assert.doesNotMatch(textContent(tree), /yesterday|since yesterday|in 24 hours/i);
  }
  const missing = render([observation("2026-09-14T12:00:00Z", 20), observation("2026-09-17T09:00:00Z", null), observation("2026-09-18T09:00:00Z", 5)]);
  assert.match(textContent(missing), /previous recorded observation has no exact rank to compare/);
  assert.doesNotMatch(textContent(missing), /Up 15 places|Down/);
});

test("history is collapsed, needs two known distinct days, and charts show isolated known points without bridging explicit nulls", () => {
  for (const rows of [[], [observation(NOW, 1)], [observation("2026-09-18T09:00:00Z", 10), observation("2026-09-18T10:00:00Z", 5)], [observation("2026-09-17T09:00:00Z", null), observation(NOW, 1)]]) {
    assert.equal(elements(render(rows)).some(node => node.type === "svg"), false);
  }
  const tree = render([observation("2026-09-14T12:00:00Z", 20), observation("2026-09-17T09:00:00Z", null), observation("2026-09-18T09:00:00Z", 5)]);
  const details = elements(tree).filter(node => node.type === "details");
  assert.equal(details.length, 1);
  assert.ok(!details[0].props.open);
  assert.equal(elements(tree).filter(node => node.type === "circle").length, 2);
  const segments = elements(tree).filter(node => node.type === "polyline");
  assert.equal(segments.length, 2);
  assert.ok(segments.every(node => !node.props.points.includes(" ")), "Unknown observation breaks the connecting line");
  assert.equal(elements(tree).some(node => node.type === "ul" || node.type === "table"), false);
});

test("stale sources and conflicting observations stay explicit, future source timestamps are hidden, and Arabic summary is translated", () => {
  const stale = render([], { rankingStale: true, rankingAt: "2999-01-01T00:00:00Z" });
  assert.match(textContent(stale), /Ranking data may be out of date/);
  assert.doesNotMatch(textContent(stale), /2999|Ranking list last checked/);
  assert.ok(elements(stale).some(node => node.props?.role === "status"));
  const conflicting = render([observation(NOW, 5), observation(NOW, null)]);
  assert.match(textContent(conflicting), /An exact rank could not be established/);
  assert.doesNotMatch(textContent(conflicting), /Not listed in the recorded top 50/);
  const arabic = render([observation("2026-09-14T12:00:00Z", 8), observation("2026-09-18T09:00:00Z", 3)], { title: "Recorded rank", rankingStale: true }, "ar");
  for (const phrase of ["الترتيب المسجل", "آخر ترتيب مسجل", "تحسّن الترتيب بمقدار 5", "مقارنة بالرصد السابق المسجل", "قد تكون بيانات الترتيب قديمة", "سجل الترتيب"]) assert.ok(textContent(arabic).includes(phrase), phrase);
  assert.doesNotMatch(textContent(arabic), /Recorded rank|Up 5 places|Compared with|Ranking data may/);
  for (const [rank, phrase] of [[7, "تقدّم مركزًا واحدًا"], [9, "تراجع مركزًا واحدًا"]]) {
    const single = render([observation("2026-09-14T12:00:00Z", 8), observation("2026-09-18T09:00:00Z", rank)], {}, "ar");
    assert.ok(textContent(single).includes(phrase));
  }
});

test("a mounted summary checks the current clock when later observations arrive instead of keeping the mount-time cutoff", async () => {
  let current = "2026-09-17T12:00:00Z";
  class ClockDate extends Date { static now() { return Date.parse(current); } }
  const hooks = hookRenderer(), timers = new Map(); let nextTimer = 1;
  const { ClubRankingSummary } = loadTypeScript("src/components/club-ranking-summary.tsx", {
    ...componentMocks, react: hooks.react,
  }, { Date: ClockDate, setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  let observations = [observation("2026-09-17T11:00:00Z", 8)];
  const component = () => ClubRankingSummary({ tag: "#PYLQ", region: "TN", observations, rankingAt: current, rankingStale: false });
  const flushTimers = () => { for (const [id, callback] of timers) { timers.delete(id); callback(); } };
  let tree = await hooks.render(component); flushTimers(); tree = await hooks.render(component);
  assert.match(textContent(tree), /Latest recorded rank: #8/);
  current = NOW;
  observations = [...observations, observation("2026-09-18T11:00:00Z", 3)];
  await hooks.render(component); flushTimers(); tree = await hooks.render(component);
  assert.match(textContent(tree), /Latest recorded rank: #3/);
  assert.match(textContent(tree), /Up 5 places/);
});
