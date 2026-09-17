const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { readOnlyDatabase } = require('./helpers/read-only-database.cjs');

const at = '2026-09-17T12:00:00.000Z';
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return Date.parse(at); } }
const settings = (club = '#CLUB', marker = at, key = 'last_roster_sync_time') => [{ key: 'club_tag', value: club }, { key, value: marker }];
const endpoints = ['analysis', 'readiness', 'reports/weekly', 'leaderboard', 'dashboard', 'insights', 'members', 'battles/feed'];
const statistics = { observations: 0, wins: 0, losses: 0, draws: 0, unknownResults: 0, winRate: null,
  durationObservations: 0, recordedDurationSeconds: 0, averageDurationSeconds: null };
function emptyRpc(name) {
  if (name === 'club_analysis_read') return {
    summary: statistics, modes: [], maps: [], brawlers: [], pairs: [], hourly: [],
    facets: { contexts: [], modes: [], maps: [], brawlers: [] },
    coverage: { status: 'unknown', currentPlayers: 0, monitoredPlayers: 0, affectedPlayers: 0, possibleGapCount: 0,
      retainedGapWindowDays: 28, fullPeriodMonitoredPlayers: 0, stalePlayers: 0, teamObservations: 0, pairEligibleObservations: 0 },
    limits: { observationLimit: 100000, groupLimit: 200, facetLimit: 2000,
      groupCounts: { modes: 0, maps: 0, brawlers: 0, pairs: 0 }, facetCounts: { modes: 0, maps: 0, brawlers: 0 } },
  };
  if (name === 'club_readiness_read') return { members: [], brawlers: [], rows: [], total: 0 };
  if (name === 'report_dashboard_read' || name === 'report_leaderboard_read') return {
    members: [], changeCounts: { joins: 0, leaves: 0, nameChanges: 0, roleChanges: 0 }, recentEvents: [], lastSyncTime: at,
  };
  if (name === 'report_account_trophy_trend') return [];
  if (name === 'battle_feed_page') return [];
  if (name === 'battle_feed_facets') return { total: 0, modes: [], contexts: [], observationCount: 0 };
  throw Error(`Unexpected RPC ${name}`);
}
function harness(endpoint, initialSettings, duringRead, settingsFailure = false) {
  const tables = { settings: initialSettings, member_history: [], members: [], club_events: [], notifications: [], daily_stats: [], battle_history: [] };
  let reads = 0, configurationReads = 0;
  const dataRead = () => { reads++; if (reads === 1 && duringRead) tables.settings = duringRead; };
  const database = {
    from(table) {
      if (table !== 'settings') { dataRead(); return readOnlyDatabase(tables).from(table); }
      configurationReads++;
      return { select(columns) {
        assert.equal(columns, 'key,value');
        return { async in(column, keys) {
          assert.equal(column, 'key');
          assert.deepEqual(Array.from(keys).sort(), ['club_tag', 'last_roster_sync_time', 'last_sync_time']);
          return settingsFailure ? { data: null, error: { message: 'SECRET DATABASE', code: 'XX000' } } : { data: tables.settings, error: null };
        } };
      } };
    },
    async rpc(name) { dataRead(); return { data: emptyRpc(name), error: null }; },
  };
  const route = loadTypeScript(`src/app/api/${endpoint}/route.ts`, {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/supabase-admin': { supabaseAdmin: database },
  }, { Date: FixedDate, process: { env: {} }, console: { error() {} } });
  return { read: () => route.GET(Object.assign(new Request(`https://fixture/api/${endpoint}?range=7d`), { nextUrl: new URL('https://fixture/api?range=7d') })),
    counts: () => ({ reads, configurationReads }) };
}

test('current-club aggregates reject retained rows before the newly configured club has an accepted roster', async () => {
  for (const endpoint of endpoints) {
    for (const rows of [settings('#NEWCLUB', ''), settings('#NEWCLUB', 'invalid'), settings('#NEWCLUB', '2099-01-01T00:00:00Z'), settings('', at)]) {
      const source = harness(endpoint, rows), response = await source.read();
      assert.equal(response.status, 409, endpoint);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'The club roster is awaiting a successful sync.' });
      assert.equal(source.counts().reads, 0, 'Old members/battles must never be read before acceptance');
    }
  }
});

test('a valid roster-only or legacy full-sync marker allows a truly empty current roster', async () => {
  for (const endpoint of endpoints) {
    for (const key of ['last_roster_sync_time', 'last_sync_time']) {
      const source = harness(endpoint, settings('%23club', at, key)), response = await source.read();
      assert.equal(response.status, 200, endpoint);
      assert.equal(source.counts().configurationReads, 2, 'Read acceptance before and after assembling the response');
      assert.ok(source.counts().reads > 0);
    }
  }
});

test('a club switch during an aggregate read rejects even an already accepted replacement club', async () => {
  for (const endpoint of endpoints) {
    for (const changed of [settings('#OTHER', at), settings('#OTHER', '')]) {
      const source = harness(endpoint, settings(), changed), response = await source.read();
      assert.equal(response.status, 409, endpoint);
      assert.equal(Object.keys(await response.json()).join(','), 'error');
      assert.equal(source.counts().configurationReads, 2);
    }
  }
});

test('normal same-club refreshes and normalized tag spelling do not reject accepted reads', async () => {
  for (const endpoint of endpoints) {
    const source = harness(endpoint, settings('club', '2026-09-17T11:50:00Z'), settings('%23CLUB', at));
    assert.equal((await source.read()).status, 200, endpoint);
  }
});

test('configuration read failures remain errors and reveal no database diagnostics', async () => {
  for (const endpoint of endpoints) {
    const source = harness(endpoint, settings(), null, true), response = await source.read();
    assert.equal(response.status, 500, endpoint);
    assert.doesNotMatch(JSON.stringify(await response.json()), /SECRET|XX000/);
    assert.equal(source.counts().reads, 0);
  }
});
