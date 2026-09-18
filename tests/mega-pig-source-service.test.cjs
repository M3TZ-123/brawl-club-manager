const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { readOnlyDatabase } = require('./helpers/read-only-database.cjs');
const next = { NextResponse: { json: Response.json } };
const globals = { process: { env: { ADMIN_PASSWORD: 'test-password', ADMIN_SESSION_SECRET: 'test-secret', NODE_ENV: 'test' } }, Error };
const { createAdminSessionToken } = loadTypeScript('src/lib/admin-auth.ts', { 'next/server': next }, globals);
function request(query = '', admin = true) {
  return new Request(`https://club.test/api/mega-pig-source${query}`, { headers: admin ? { cookie: `brawlstatz_admin=${createAdminSessionToken()}` } : {} });
}
function fixture() {
  const now = new Date().toISOString();
  const tables = {
    settings: [{ key: 'club_tag', value: '#CLUB' }, { key: 'last_roster_sync_time', value: now }],
    member_history: [{ player_tag: '#AAA', player_name: 'Current A', is_current_member: true, notes: 'PRIVATE NOTE' },
      { player_tag: '#BBB', player_name: 'Current B', is_current_member: true },
      { player_tag: '#OLD', player_name: 'Departed', is_current_member: false }],
  };
  const state = { calls: [], changeClub: false, failure: null, cache: {
    payload: { clubTag: '#CLUB', totalWins: 4, reportedPlayersPlayed: 1, members: [
      { playerTag: '#AAA', playerName: 'Source A', reportedWins: 0, reportedTicketsRemaining: 6, online: 'PRIVATE ONLINE' },
      { playerTag: '#OLD', playerName: 'Departed source', reportedWins: 4, reportedTicketsRemaining: 1 },
    ], sourceUpdatedAt: now, cycleVerified: true, privateKey: 'PRIVATE KEY' },
    previousPayload: { private: 'PRIVATE HISTORY' }, fetchedAt: now, changedAt: now, lastAttemptAt: now,
    nextCheckAt: new Date(Date.now() + 20 * 60000).toISOString(), errorCode: null, stale: false, refreshing: false,
  } };
  const route = loadTypeScript('src/app/api/mega-pig-source/route.ts', {
    'next/server': next, '@/lib/supabase-admin': { supabaseAdmin: readOnlyDatabase(tables) },
    '@/lib/mega-pig-source-cache': { refreshMegaPigSource: async tag => {
      state.calls.push(tag); if (state.failure) throw state.failure;
      if (state.changeClub) tables.settings[0].value = '#OTHER'; return state.cache;
    } },
  }, globals);
  return { route, tables, state };
}
test('source endpoint requires admin before cache and rejects query budget bypasses', async () => {
  const { route, state } = fixture();
  const denied = await route.GET(request('', false));
  assert.equal(denied.status, 401); assert.equal(denied.headers.get('cache-control'), 'no-store');
  assert.equal(denied.headers.get('vary'), 'Cookie'); assert.equal(state.calls.length, 0);
  for (const query of ['?force=1', '?club=%23OTHER', '?refresh=1', '?event=anything']) {
    assert.equal((await route.GET(request(query))).status, 400);
  }
  assert.equal(state.calls.length, 0);
});
test('source projects current roster with exact tag matches, real zeros and unknown missing members', async () => {
  const { route, state } = fixture();
  const response = await route.GET(request()); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('vary'), 'Cookie');
  const value = await response.json();
  assert.deepEqual(state.calls, ['#CLUB']); assert.equal(value.totalWins, 4); assert.equal(value.reportedPlayersPlayed, 1);
  assert.equal(value.matchedMembers, 1); assert.equal(value.sourceMembers, 2); assert.equal(value.rosterMembers, 2);
  assert.deepEqual(value.members, [
    { playerTag: '#AAA', playerName: 'Current A', reportedWins: 0, reportedTicketsRemaining: 6 },
    { playerTag: '#BBB', playerName: 'Current B', reportedWins: null, reportedTicketsRemaining: null },
  ]);
  assert.equal(value.source.official, false); assert.equal(value.source.cycleVerified, false); assert.equal(value.source.updatedAt, null);
  assert.equal(value.source.url, 'https://brawlace.com/clubs/%23CLUB');
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|Departed|online|previousPayload|privateKey/);
});
test('cached errors preserve explicitly stale numbers without inventing source freshness', async () => {
  const { route, state } = fixture(); state.cache.errorCode = 'rate_limited'; state.cache.stale = true;
  const value = await (await route.GET(request())).json();
  assert.equal(value.status, 'stale'); assert.equal(value.totalWins, 4); assert.equal(value.source.updatedAt, null);
  assert.doesNotMatch(JSON.stringify(value), /rate_limited|consecutiveFailures/);
});

test('provider provenance survives projection and battle totals are never reported as player counts', async () => {
  const { route, state } = fixture();
  Object.assign(state.cache.payload, { source: 'BrawlTools', reportedPlayersPlayed: null, reportedBattlesPlayed: 128 });
  const response = await route.GET(request()); assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.source.name, 'BrawlTools'); assert.equal(value.source.url, 'https://brawltools.net');
  assert.equal(value.reportedPlayersPlayed, null); assert.equal(value.reportedBattlesPlayed, 128);
  assert.equal(value.source.updatedAt, null); assert.equal(value.source.cycleVerified, false);
  assert.equal(value.members[0].reportedWins, 0); assert.equal(value.members[1].reportedWins, null);
  assert.doesNotMatch(JSON.stringify(value), /sourceUpdatedAt|privateKey/);
});

test('a stale legacy reading retains BrawlAce credit while the automatic provider changes', async () => {
  const { route, state } = fixture(); state.cache.stale = true;
  const value = await (await route.GET(request())).json();
  assert.equal(value.source.name, 'BrawlAce'); assert.equal(value.reportedPlayersPlayed, 1);
  assert.equal(value.reportedBattlesPlayed, null); assert.equal(value.status, 'stale');
});

test('matched source members with missing counters remain unknown without allocating aggregate wins', async () => {
  const { route, state } = fixture();
  state.cache.payload.members[0].reportedWins = null;
  state.cache.payload.members[0].reportedTicketsRemaining = null;
  state.cache.payload.totalWins = 8;
  const response = await route.GET(request()); assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.matchedMembers, 1); assert.equal(value.totalWins, 8);
  assert.equal(value.members[0].reportedWins, null); assert.equal(value.members[0].reportedTicketsRemaining, null);
  state.cache.payload.totalWins = 3;
  assert.equal((await route.GET(request())).status, 503, 'Known wins cannot exceed reported total even with unknown rows');
});
test('no snapshot is unavailable or pending, never a zero-win event', async () => {
  for (const refreshing of [false, true]) {
    const { route, state } = fixture(); Object.assign(state.cache, { payload: null, fetchedAt: null, changedAt: null, refreshing });
    const value = await (await route.GET(request())).json();
    assert.equal(value.status, refreshing ? 'pending' : 'unavailable'); assert.equal(value.totalWins, null);
    assert.equal(value.reportedPlayersPlayed, null); assert.equal(value.matchedMembers, 0);
    assert.ok(value.members.every(member => member.reportedWins === null && member.reportedTicketsRemaining === null));
  }
});
test('changed or unaccepted club cannot disclose a cached snapshot', async () => {
  let { route, state, tables } = fixture(); tables.settings.splice(1);
  assert.equal((await route.GET(request())).status, 409); assert.equal(state.calls.length, 0);
  ({ route, state } = fixture()); state.changeClub = true;
  const response = await route.GET(request()); assert.equal(response.status, 409);
  assert.doesNotMatch(JSON.stringify(await response.json()), /Current A|Source A|totalWins/);
});
test('malformed saved source payloads fail closed instead of hiding schema changes', async () => {
  for (const change of [
    state => { state.cache.payload.clubTag = '#OTHER'; },
    state => { state.cache.payload.members[0].reportedWins = undefined; },
    state => { state.cache.payload.members[0].reportedTicketsRemaining = -1; },
    state => { state.cache.payload.totalWins = 99; },
    state => { state.cache.payload.members[1].playerTag = '#AAA'; },
    state => { state.cache.payload.reportedPlayersPlayed = 3; },
    state => { state.cache.payload.source = 'Untrusted'; },
    state => { state.cache.payload.source = 'BrawlTools'; },
    state => { state.cache.payload.reportedBattlesPlayed = 128; },
    state => { Object.assign(state.cache.payload, { source: 'BrawlTools', reportedPlayersPlayed: null, reportedBattlesPlayed: 3 }); },
    state => { state.cache.fetchedAt = new Date(Date.now() + 60000).toISOString(); },
    state => { state.cache.fetchedAt = null; },
  ]) {
    const { route, state } = fixture(); change(state);
    const response = await route.GET(request()); assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'Mega Pig source is temporarily unavailable. Please try again.');
  }
});
test('storage or provider diagnostics never leak through the route', async () => {
  const { route, state } = fixture(); state.failure = new Error('PRIVATE PROVIDER KEY');
  const response = await route.GET(request()); assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE|KEY/);
});
