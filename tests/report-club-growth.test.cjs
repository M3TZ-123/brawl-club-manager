const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { readOnlyDatabase } = require("./helpers/read-only-database.cjs");
const { buildClubTrophyChange } = loadTypeScript("src/lib/club-trophy-change.ts");
const { getReportingPeriod } = loadTypeScript("src/lib/reporting-period.ts");
const start = new Date("2026-09-11T00:00:00Z"), end = new Date("2026-09-17T21:28:00Z");
const member = (tag, trophies) => ({ tag, trophies, name: tag, role: "member", owner_user_id: "private-owner" });
const row = (firstAt, firstMembers, lastAt = firstAt, lastMembers = firstMembers) => ({
  club_tag: "#CLUB", snapshot_day: new Date(firstAt).toISOString().slice(0, 10),
  first_observed_at: firstAt, last_observed_at: lastAt, first_members: firstMembers, last_members: lastMembers,
  first_run_id: "private-run", last_run_id: "private-run",
});
const growth = rows => buildClubTrophyChange(rows, start, end);
const plain = value => JSON.parse(JSON.stringify(value));

test("roster change explains progress and member replacements even when member counts stay equal", () => {
  const result = growth([
    row(start.toISOString(), [member("#AA", 100), member("#BB", 300)]),
    row(end.toISOString(), [member("#AA", 150), member("#CC", 200)]),
  ]);
  assert.equal(result.status, "complete_period");
  assert.equal(result.startAt, start.toISOString()); assert.equal(result.endAt, end.toISOString());
  assert.equal(result.totalChange, -50); assert.equal(result.commonProgress, 50);
  assert.equal(result.addedTrophies, 200); assert.equal(result.removedTrophies, 300);
  assert.equal(result.commonMembers, 1); assert.equal(result.addedMembers, 1); assert.equal(result.removedMembers, 1);
  assert.equal(result.totalChange, result.commonProgress + result.addedTrophies - result.removedTrophies);
  assert.equal(result.points[0].members, result.points[1].members);
  assert.doesNotMatch(JSON.stringify(result), /private|owner_user_id|run_id|first_members|#AA/);
});

test("the nearest baseline within36h wins, with its actual timestamp preserved", () => {
  const result = growth([
    row("2026-09-09T13:00:00Z", [member("#AA", 30)]),
    row("2026-09-10T23:59:00Z", [member("#AA", 100)]),
    row("2026-09-11T00:01:00Z", [member("#AA", 102)]),
    row(end.toISOString(), [member("#AA", 110)]),
  ]);
  assert.equal(result.status, "complete_period"); assert.equal(result.totalChange, 10);
  assert.equal(result.startAt, "2026-09-10T23:59:00.000Z");
  assert.equal(result.requestedStart, start.toISOString());
});

test("new history produces a truthful partial comparison, including two observations on one day", () => {
  const result = growth([row("2026-09-17T00:58:00Z", [member("#AA", 3_276_557)], "2026-09-17T21:28:00Z", [member("#AA", 3_279_435)])]);
  assert.equal(result.status, "partial_period"); assert.equal(result.totalChange, 2878);
  assert.equal(result.startAt, "2026-09-17T00:58:00.000Z"); assert.equal(result.endAt, end.toISOString());
  assert.equal(result.points.length, 1); assert.equal(result.points[0].day, "2026-09-17");
  assert.equal(result.points[0].totalTrophies, 3_279_435);
});

test("missing, single, old, future and baseline-only observations never fabricate zero progress", () => {
  const samples = [
    [], [row(end.toISOString(), [member("#AA", 100)])],
    [row("2026-08-01T00:00:00Z", [member("#AA", 100)]), row(end.toISOString(), [member("#AA", 100)])],
    [row("2026-09-18T00:00:00Z", [member("#AA", 100)])],
    [row("2026-09-10T23:00:00Z", [member("#AA", 100)])],
    [row("2026-09-09T11:59:59Z", [member("#AA", 100)]), row(end.toISOString(), [member("#AA", 100)])],
  ];
  for (const rows of samples) {
    const result = growth(rows);
    assert.equal(result.status, "insufficient_history");
    for (const key of ["totalChange", "commonProgress", "addedTrophies", "removedTrophies", "commonMembers", "addedMembers", "removedMembers"]) {
      assert.equal(result[key], null, key);
    }
  }
});

test("old baselines do not prevent a partial comparison and future last samples cannot extend it", () => {
  const result = growth([
    row("2026-09-08T00:00:00Z", [member("#AA", 1)]),
    row("2026-09-12T00:00:00Z", [member("#AA", 100)]),
    row("2026-09-17T10:00:00Z", [member("#AA", 120)], "2026-09-17T23:00:00Z", [member("#AA", 900)]),
  ]);
  assert.equal(result.status, "partial_period"); assert.equal(result.totalChange, 20);
  assert.equal(result.endAt, "2026-09-17T10:00:00.000Z");
});

test("a genuinely empty complete roster and observed zero are valid measurements", () => {
  for (const [before, after, expected] of [
    [[], [], 0], [[], [member("#AA", 100)], 100], [[member("#AA", 100)], [], -100],
    [[member("#AA", 0)], [member("#AA", 0)], 0],
  ]) {
    const result = growth([row(start.toISOString(), before), row(end.toISOString(), after)]);
    assert.equal(result.status, "complete_period"); assert.equal(result.totalChange, expected);
    assert.equal(result.totalChange, result.commonProgress + result.addedTrophies - result.removedTrophies);
  }
});

test("invalid and incomplete snapshot payloads are rejected instead of manufacturing balances", () => {
  const initial = row(start.toISOString(), [member("#AA", 100)]), latest = row(end.toISOString(), [member("#AA", 120)]);
  for (const first_members of [null, {}, [member("#AA", null)], [member("#AA", -1)], [member("#AA", 0.5)],
    [member("#AA", 2_147_483_648)], [member("AA", 100)], [member("#AA", 100), member("#AA", 200)], Array(101).fill(member("#AA", 100))]) {
    assert.throws(() => growth([{ ...initial, first_members }, latest]), /Invalid roster history/);
  }
  for (const rows of [null, {}, Array(94).fill(initial), [initial, initial], [{ ...initial, snapshot_day: "2026-09-12" }],
    [{ ...initial, first_observed_at: "invalid" }], [{ ...initial, last_observed_at: "2026-09-10T23:59:59Z" }]]) {
    assert.throws(() => growth(rows), /Invalid roster history/);
  }
});

test("daily points use UTC dates and the last observed balance, without filling missing days", () => {
  const result = growth([
    row("2026-09-13T10:00:00Z", [member("#AA", 130)]),
    row("2026-09-11T23:20:00-01:00", [member("#AA", 110)], "2026-09-12T20:00:00Z", [member("#AA", 120)]),
    row("2026-09-11T00:00:00Z", [member("#AA", 100)]),
  ]);
  assert.deepEqual(plain(result.points.map(point => [point.day, point.totalTrophies])), [
    ["2026-09-11", 100], ["2026-09-12", 120], ["2026-09-13", 130],
  ]);
});

function queryDatabase(rows, calls, resultOverride) {
  const base = readOnlyDatabase({ club_roster_snapshots: rows });
  return { from(table) {
    calls.push(["from", table]);
    const query = base.from(table);
    for (const name of ["select", "eq", "gte", "lte", "order", "limit"]) {
      const original = query[name];
      query[name] = (...args) => { calls.push([name, ...args]); return original(...args); };
    }
    query.abortSignal = signal => { calls.push(["signal", signal]); return query; };
    if (resultOverride) query.then = resultOverride;
    return query;
  } };
}

test("history reads have one exact club filter, explicit projection, bounded dates and a cancellation signal for all ranges", async () => {
  for (const range of ["24h", "3d", "7d", "30d", "90d"]) {
    const period = getReportingPeriod(range, end), calls = [];
    const rows = [row(period.start.toISOString(), [member("#AA", 100)]), row(end.toISOString(), [member("#AA", 130)])];
    if (range === "24h") rows.splice(0, 2, row(period.start.toISOString(), [member("#AA", 100)], end.toISOString(), [member("#AA", 130)]));
    rows.push({ ...row(end.toISOString(), [member("#ZZ", 999)]), club_tag: "#OTHER" });
    const { fetchReportClubGrowth } = loadTypeScript("src/lib/report-club-growth.ts", { "@/lib/supabase-admin": { supabaseAdmin: queryDatabase(rows, calls) } });
    const result = await fetchReportClubGrowth("#CLUB", period);
    assert.equal(result.status, "complete_period"); assert.equal(result.totalChange, 30);
    assert.deepEqual(calls.filter(call => call[0] === "from"), [["from", "club_roster_snapshots"]]);
    assert.deepEqual(calls.find(call => call[0] === "select"), ["select", "first_observed_at,last_observed_at,first_members,last_members,snapshot_day"]);
    assert.deepEqual(calls.find(call => call[0] === "eq"), ["eq", "club_tag", "#CLUB"]);
    assert.deepEqual(calls.find(call => call[0] === "gte"), ["gte", "snapshot_day", new Date(period.start.getTime() - 2 * 86_400_000).toISOString().slice(0, 10)]);
    assert.deepEqual(calls.find(call => call[0] === "lte"), ["lte", "snapshot_day", end.toISOString().slice(0, 10)]);
    assert.equal(calls.find(call => call[0] === "limit")[1], 93);
    assert.equal(calls.find(call => call[0] === "signal")[1].aborted, false);
  }
});

test("history failures, missing data and malformed rows return only null without exposing database errors", async () => {
  const sensitive = "private-db-error secret-key";
  for (const result of [{ data: null, error: { message: sensitive } }, { data: null, error: null },
    { data: [{ private_field: sensitive }], error: null }]) {
    const calls = [], logs = [];
    const { fetchReportClubGrowth } = loadTypeScript("src/lib/report-club-growth.ts", {
      "@/lib/supabase-admin": { supabaseAdmin: queryDatabase([], calls, resolve => Promise.resolve(result).then(resolve)) },
    }, { console: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) } });
    assert.equal(await fetchReportClubGrowth("#CLUB", { start, end }), null); assert.deepEqual(logs, []);
  }
});

test("optional history times out and aborts its read without waiting for a stuck database request", async () => {
  const calls = [];
  const { fetchReportClubGrowth } = loadTypeScript("src/lib/report-club-growth.ts", {
    "@/lib/supabase-admin": { supabaseAdmin: queryDatabase([], calls, () => new Promise(() => {})) },
  }, { setTimeout: (callback, delay) => { assert.equal(delay, 2000); return setTimeout(callback, 1); } });
  assert.equal(await fetchReportClubGrowth("#CLUB", { start, end }), null);
  assert.equal(calls.find(call => call[0] === "signal")[1].aborted, true);
});

test("weekly report attaches optional growth using its own UTC period and retains the final accepted-club guard", async () => {
  for (const range of ["24h", "3d", "7d", "30d", "90d"]) {
    const calls = [], period = getReportingPeriod(range, end);
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [end])); } }
    const responseValue = { status: "insufficient_history", totalChange: null };
    const { GET } = loadTypeScript("src/app/api/reports/weekly/route.ts", {
      "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
      "@/lib/supabase-admin": { supabaseAdmin: readOnlyDatabase({ member_history: [], members: [], club_events: [] }) },
      "@/lib/accepted-club-roster": { requireAcceptedClubRoster: async () => { calls.push("require"); return "#CLUB"; },
        assertAcceptedClubRoster: async tag => { assert.equal(tag, "#CLUB"); calls.push("assert"); }, ClubRosterUnavailableError: class extends Error {} },
      "@/lib/reporting-data": { fetchDailyStats: async () => [], fetchAccountTrophyTrend: async () => [] },
      "@/lib/member-activity-metrics": { appendMemberActivityMetrics: async () => [] },
      "@/lib/report-club-growth": { fetchReportClubGrowth: async (tag, value) => {
        assert.equal(tag, "#CLUB"); assert.equal(value.start.toISOString(), period.start.toISOString());
        assert.equal(value.end.toISOString(), period.end.toISOString()); calls.push("growth"); return range === "30d" ? null : responseValue;
      } },
    }, { Date: FixedDate });
    const response = await GET(new Request(`https://fixture/api/reports/weekly?range=${range}`));
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.period.start, period.start.toISOString()); assert.equal(body.summary.totalMembers, 0);
    assert.deepEqual(body.trophyChange, range === "30d" ? null : responseValue);
    assert.deepEqual(calls, ["require", "growth", "assert"]);
  }
});
