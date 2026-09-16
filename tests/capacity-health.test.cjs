const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

const now = Date.parse("2026-09-17T00:00:00Z");
const sample = (used = 100000000, level = "normal", time = now - 60000) => ({
  database_bytes: String(used), budget_bytes: "500000000", level, sampled_at: new Date(time).toISOString(),
});

function fixture(result = { data: sample(), error: null }) {
  const queries = [], logs = [];
  const query = {
    select: (value) => { queries.push(["select", value]); return query; },
    order: (...args) => { queries.push(["order", ...args]); return query; },
    limit: (value) => { queries.push(["limit", value]); return query; },
    maybeSingle: async () => { if (result instanceof Error) throw result; return result; },
  };
  const api = loadTypeScript("src/lib/capacity-health.ts", {
    "@/lib/supabase-admin": { supabaseAdmin: { from: (value) => { queries.push(["from", value]); return query; } } },
  }, { console: { error: (...args) => logs.push(args), log: (...args) => logs.push(args), warn: (...args) => logs.push(args) } });
  return { api, queries, logs };
}

test("capacity health reads the newest private measurement using explicit fields", async () => {
  const { api, queries } = fixture();
  assert.deepEqual(JSON.parse(JSON.stringify(await api.readCapacityHealth(now))), {
    usedBytes: 100000000, budgetBytes: 500000000, percent: 20, level: "ok", sampledAt: "2026-09-16T23:59:00.000Z", stale: false,
  });
  assert.equal(queries[0][1], "capacity_samples");
  assert.equal(queries[1][1], "sampled_at,database_bytes,budget_bytes,level");
  assert.equal(queries[2][1], "sampled_at"); assert.equal(queries[2][2].ascending, false);
  assert.deepEqual(queries[3], ["limit", 1]);
});

test("capacity thresholds include exactly70 and90 percent and allow over-budget measurements", async () => {
  for (const [used, stored, displayed, percent] of [
    [349999999, "normal", "ok", 70], [350000000, "warning", "warning", 70],
    [449999999, "warning", "warning", 90], [450000000, "critical", "critical", 90],
    [600000000, "critical", "critical", 120], [0, "normal", "ok", 0],
  ]) {
    const { api } = fixture({ data: sample(used, stored), error: null });
    const result = await api.readCapacityHealth(now);
    assert.equal(result.level, displayed); assert.equal(result.percent, percent);
  }
});

test("two-hour-old measurements remain identifiable but stale after the strict cutoff", async () => {
  const atBoundary = fixture({ data: sample(350000000, "warning", now - 7200000), error: null });
  const older = fixture({ data: sample(350000000, "warning", now - 7200001), error: null });
  assert.equal((await atBoundary.api.readCapacityHealth(now)).stale, false);
  const result = await older.api.readCapacityHealth(now);
  assert.equal(result.stale, true); assert.equal(result.level, "warning"); assert.equal(result.usedBytes, 350000000);
});

test("missing, future, invalid or inconsistent measurements fail closed without private errors", async () => {
  const invalid = [
    null, { ...sample(), sampled_at: "bad" }, sample(100000000, "normal", now + 1),
    { ...sample(), database_bytes: -1 }, { ...sample(), database_bytes: "123oops" },
    { ...sample(), database_bytes: "9007199254740992" }, { ...sample(), budget_bytes: 0 },
    { ...sample(), budget_bytes: null }, { ...sample(), level: "critical" },
  ];
  for (const data of invalid) {
    const { api } = fixture({ data, error: null }); const result = await api.readCapacityHealth(now);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { usedBytes: null, budgetBytes: null, percent: null, level: "unknown", sampledAt: null, stale: true });
  }
  for (const result of [{ data: sample(), error: { message: "PRIVATE_DATABASE_ERROR" } }, new Error("PRIVATE_DATABASE_ERROR")]) {
    const { api, logs } = fixture(result); const health = await api.readCapacityHealth(now);
    assert.equal(health.level, "unknown"); assert.ok(!JSON.stringify(health).includes("PRIVATE")); assert.deepEqual(logs, []);
  }
});
