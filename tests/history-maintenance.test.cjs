const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { readOnlyDatabase } = require("./helpers/read-only-database.cjs");

const now = new Date("2026-09-15T22:00:00.000Z");
const old = "2026-01-01T00:00:00.000Z";
const recent = "2026-09-15T21:00:00.000Z";
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
  static now() { return now.getTime(); }
}

function historyMember(player_tag, overrides = {}) {
  return {
    player_tag,
    player_name: player_tag,
    first_seen: old,
    last_seen: recent,
    last_left_at: old,
    is_current_member: true,
    ...overrides,
  };
}

function loadHistory(tables) {
  return loadTypeScript("src/app/api/history/route.ts", {
    "@/lib/supabase-admin": { supabaseAdmin: readOnlyDatabase(tables) },
    "@/lib/admin-auth": { rejectUnauthorizedAdminMutation: () => null },
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
  }, { Date: FixedDate });
}

test("history includes recent returns and real departures without treating routine syncs as joins", async () => {
  const tables = {
    member_history: [
      historyMember("#RETURNED", { times_joined: 2 }),
      historyMember("#UNCHANGED"),
      historyMember("#ROLEONLY"),
      historyMember("#OLDRETURN"),
      historyMember("#NEW", { first_seen: recent }),
      historyMember("#LEFT", { is_current_member: false, last_left_at: recent }),
      historyMember("#LEGACYLEFT", { is_current_member: false, last_left_at: null }),
    ],
    club_events: [
      { id: 1, player_tag: "#RETURNED", event_type: "join", event_time: recent },
      { id: 2, player_tag: "#ROLEONLY", event_type: "promotion", event_time: recent },
      { id: 3, player_tag: "#OLDRETURN", event_type: "join", event_time: old },
    ],
  };
  const response = await loadHistory(tables).GET(new Request("http://localhost/api/history?days=7"));
  assert.equal(response.status, 200);
  const { history } = await response.json();
  assert.deepEqual(history.map(row => row.player_tag).sort(), ["#LEFT", "#LEGACYLEFT", "#NEW", "#RETURNED"]);
  assert.equal(history.find(row => row.player_tag === "#RETURNED").first_seen, old);
  assert.equal(tables.member_history[0].last_left_at, old);
});

test("history pagination does not lose a return beyond the first 1000 events or records", async () => {
  const tables = {
    member_history: Array.from({ length: 1000 }, (_, id) => historyMember(`#P${String(id).padStart(4, "0")}`)),
    club_events: Array.from({ length: 1000 }, (_, id) => ({
      id: id + 2, player_tag: "#NOHISTORY", event_type: "join", event_time: recent,
    })),
  };
  tables.member_history.push(historyMember("#ZRETURN"));
  tables.club_events.push({ id: 1, player_tag: "#ZRETURN", event_type: "join", event_time: recent });
  const response = await loadHistory(tables).GET(new Request("http://localhost/api/history?days=7"));
  const { history } = await response.json();
  assert.deepEqual(history.map(row => row.player_tag), ["#ZRETURN"]);
});

test("all-time history needs no events and preserves the stored records", async () => {
  const tables = { member_history: [historyMember("#OLD", { last_seen: old })] };
  const response = await loadHistory(tables).GET(new Request("http://localhost/api/history?days=all"));
  assert.equal(response.status, 200);
  const { history } = await response.json();
  assert.deepEqual(history, tables.member_history);
});

function backfillFixture({ apply = false, serviceKey = "test-service-role", outcomes = ["updated"], settingsError = null } = {}) {
  const summaries = [];
  const calls = { credentials: [], updates: [], requests: [] };
  const rows = outcomes.map((_, index) => ({
    id: index + 1,
    player_tag: "#PLAYER",
    battle_time: `2026-09-15T21:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const client = {
    from(table) {
      let mutation = null;
      let id;
      let selected;
      const query = {
        select(columns) { selected = columns; return query; },
        update(values) { mutation = values; return query; },
        eq(key, value) { if (key === "id") id = value; return query; },
        is() { return query; },
        gte() { return query; },
        order() { return query; },
        limit() { return query; },
        then(resolve, reject) {
          if (mutation) {
            calls.updates.push({ id, selected, values: mutation });
            const outcome = outcomes[id - 1];
            return Promise.resolve({
              data: outcome === "updated" ? [{ id }] : [],
              error: outcome === "error" ? new Error("Mock database failure") : null,
            }).then(resolve, reject);
          }
          if (table === "settings") {
            return Promise.resolve({ data: [{ key: "api_key", value: "test-saved-api-key" }], error: settingsError }).then(resolve, reject);
          }
          assert.equal(table, "battle_history");
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const { main } = loadTypeScript("scripts/backfill-solo-teams-json.cjs", {
    fs: { existsSync: () => false },
    "@supabase/supabase-js": {
      createClient(...args) { calls.credentials.push(args); return client; },
    },
    axios: {
      async get(url, options) {
        calls.requests.push({ url, options });
        return { data: { items: rows.map((row, index) => ({
          battleTime: `20260915T21${String(index).padStart(2, "0")}00.000Z`,
          event: { mode: "soloShowdown" },
          battle: { players: [{ tag: row.player_tag, name: "Player", brawler: { name: "SHELLY", power: 11 } }] },
        })) } };
      },
    },
  }, {
    Date: FixedDate,
    process: {
      argv: ["node", "backfill.cjs", ...(apply ? ["--apply"] : [])],
      cwd: () => "C:/mock-workspace",
      env: {
        NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
        ...(serviceKey ? { SUPABASE_SERVICE_ROLE_KEY: serviceKey } : {}),
      },
    },
    console: { log: value => summaries.push(JSON.parse(value)) },
  });
  return { main, summaries, calls };
}

test("backfill requires a service-role credential even when an anon key is present", async () => {
  const fixture = backfillFixture({ serviceKey: null });
  await assert.rejects(fixture.main(), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(fixture.calls.credentials.length, 0);
  assert.equal(fixture.calls.requests.length, 0);
});

test("backfill defaults to dry-run and reads the saved API key with the service role", async () => {
  const fixture = backfillFixture();
  await fixture.main();
  assert.equal(fixture.calls.credentials[0][1], "test-service-role");
  assert.equal(fixture.calls.credentials[0][2].auth.persistSession, false);
  assert.equal(fixture.calls.requests[0].options.headers.Authorization, "Bearer test-saved-api-key");
  assert.equal(fixture.calls.updates.length, 0);
  assert.equal(fixture.summaries[0].matched, 1);
  assert.equal(fixture.summaries[0].updated, 0);
});

test("backfill counts returned row IDs and skips rows concurrently filled or removed", async () => {
  const fixture = backfillFixture({ apply: true, outcomes: ["updated", "skipped"] });
  await fixture.main();
  assert.deepEqual(fixture.calls.updates.map(update => update.selected), ["id", "id"]);
  assert.equal(fixture.summaries[0].updated, 1);
  assert.equal(fixture.summaries[0].skipped, 1);
  assert.equal(fixture.summaries[0].errors, 0);
});

test("backfill reports partial progress and fails apply mode when a database update fails", async () => {
  const fixture = backfillFixture({ apply: true, outcomes: ["updated", "error", "skipped"] });
  await assert.rejects(fixture.main(), /failed to update 1 battle row/);
  assert.equal(fixture.summaries[0].updated, 1);
  assert.equal(fixture.summaries[0].skipped, 1);
  assert.equal(fixture.summaries[0].errors, 1);
});

test("backfill stops on settings permission errors before calling the Brawl API", async () => {
  const fixture = backfillFixture({ settingsError: new Error("Mock settings permission denied") });
  await assert.rejects(fixture.main(), /settings permission denied/);
  assert.equal(fixture.calls.requests.length, 0);
  assert.equal(fixture.calls.updates.length, 0);
});
