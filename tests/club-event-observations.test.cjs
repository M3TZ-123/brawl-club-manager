const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { readOnlyDatabase } = require('./helpers/read-only-database.cjs');
const at = '2026-09-17T12:00:00.000Z', id = '00000000-0000-4000-8000-000000000037';
const next = { NextResponse: { json: (body, init) => Response.json(body, init) } };
const env = { ADMIN_PASSWORD: 'local-fixture', ADMIN_SESSION_SECRET: 'local-session-fixture', NODE_ENV: 'test' };
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return Date.parse(at); } }
const globals = { Date: FixedDate, process: { env } };
const auth = loadTypeScript('src/lib/admin-auth.ts', { 'next/server': next }, globals);
function snapshot() {
  return { clubTag: '#CLUB', eventId: id, eventVersion: 2, status: 'planned', startsAt: '2026-09-15T00:00:00Z', endsAt: '2026-09-18T00:00:00Z',
    generatedAt: at, observedUntil: at, hasStarted: true, historyLimited: true, classification: 'explicit_battle_type_only',
    sync: { lastFullSyncAt: at, lastBattleSyncAt: at, stale: false }, members: [
      { playerTag: '#PYLQ', playerName: 'عضو', observedBattles: 3, lastObservedBattleAt: '2026-09-17T11:59:00Z', explicitMegaPigBattles: 1,
        lastExplicitMegaPigBattleAt: '2026-09-16T09:00:00Z', authoritativeWins: null, ticketsRemaining: null,
        coverage: { baselineAt: '2026-09-16T00:00:00Z', checkedAt: at, status: 'observed', possibleGap: false } },
      { playerTag: '#PYLR', playerName: 'No observation', observedBattles: 0, lastObservedBattleAt: null, explicitMegaPigBattles: 0,
        lastExplicitMegaPigBattleAt: null, authoritativeWins: null, ticketsRemaining: null,
        coverage: { baselineAt: null, checkedAt: null, status: 'unknown', possibleGap: false } },
    ] };
}
function harness({ data = snapshot(), rpcError = null, afterRpc, configured = true } = {}) {
  const calls = [], tables = { settings: [{ key: 'club_tag', value: '#CLUB' }, { key: 'last_roster_sync_time', value: at }] };
  const db = {
    from(table) { calls.push({ table }); assert.equal(table, 'settings'); return readOnlyDatabase(tables).from(table); },
    rpc(name, args) { calls.push({ name, args }); return { async abortSignal(signal) {
      assert.ok(signal instanceof AbortSignal); afterRpc?.(tables); return { data, error: rpcError };
    } }; },
  };
  const route = loadTypeScript('src/app/api/club-event-observations/route.ts', { 'next/server': next, '@/lib/supabase-admin': { supabaseAdmin: db } },
    { ...globals, process: { env: configured ? env : {} } });
  const read = (query = `event=${id}&version=2`, cookie = `brawlstatz_admin=${auth.createAdminSessionToken()}`) => route.GET(new Request(`https://fixture/api/club-event-observations?${query}`, { headers: cookie ? { cookie } : {} }));
  return { read, calls, tables };
}

test('event observations authenticate before any reads and never expose a cacheable private response', async () => {
  for (const cookie of ['', 'brawlstatz_admin=invalid', 'brawlstatz_admin=%E0%A4%A']) {
    const source = harness(), response = await source.read(undefined, cookie);
    assert.equal(response.status, 401); assert.equal(source.calls.length, 0);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('vary'), 'Cookie');
  }
  const source = harness({ configured: false }); assert.equal((await source.read()).status, 503); assert.equal(source.calls.length, 0);
});

test('only one saved event/version query is accepted and performs one bounded read RPC between club guards', async () => {
  for (const query of ['', `event=${id}`, 'event=bad&version=2', `event=${id}&version=0`, `event=${id}&version=1.5`,
    `event=${id}&version=2147483648`, `event=${id}&version=2&version=3`, `event=${id}&event=${id}&version=2`, `event=${id}&version=2&refresh=true`]) {
    const source = harness(); assert.equal((await source.read(query)).status, 400); assert.equal(source.calls.length, 0);
  }
  const source = harness(), response = await source.read(), body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(source.calls.map(call => call.name || call.table), ['settings', 'club_event_observations_read', 'settings']);
  assert.deepEqual(JSON.parse(JSON.stringify(source.calls[1].args)), { p_club: '#CLUB', p_event: id, p_now: at });
  assert.equal(body.members[0].explicitMegaPigBattles, 1); assert.equal(body.members[1].observedBattles, 0);
  assert.equal(body.members[1].authoritativeWins, null); assert.equal(body.members[1].ticketsRemaining, null);
});

test('whitelisted observation DTO never promotes saved counts into official results or exposes private fields', async () => {
  const data = snapshot(); data.notes = 'PRIVATE'; data.revisions = [{ secret: 'PRIVATE' }]; data.historyLimited = false;
  data.members[0].attendance = 'absent'; data.members[0].notes = 'PRIVATE'; data.members[0].owner_user_id = 'PRIVATE';
  data.members[0].authoritativeWins = 200; data.members[0].ticketsRemaining = 15; data.members[0].coverage.reason = 'PRIVATE';
  const body = await (await harness({ data }).read()).json();
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|attendance|revisions|owner_user_id/);
  assert.equal(body.historyLimited, true); assert.equal(body.classification, 'explicit_battle_type_only');
  assert.equal(body.members[0].authoritativeWins, null); assert.equal(body.members[0].ticketsRemaining, null);
});

test('saved version mismatch, wrong club and missing event fail closed without revealing observations', async () => {
  const changed = snapshot(); changed.eventVersion = 3;
  assert.equal((await harness({ data: changed }).read()).status, 409);
  for (const value of ['#OTHER', '']) {
    const response = await harness({ afterRpc: tables => { tables.settings[0].value = value; } }).read();
    assert.equal(response.status, 409); assert.deepEqual(Object.keys(await response.json()), ['error']);
  }
  for (const [code, status] of [['P0002', 404], ['40001', 409], ['XX000', 503]]) {
    const response = await harness({ rpcError: { code, message: 'PRIVATE KEY' } }).read();
    assert.equal(response.status, status); assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE|XX000/);
  }
});

test('future or unknown coverage remains unknown and a roster refresh cannot make battle history fresh', async () => {
  const data = snapshot(); data.sync.lastBattleSyncAt = null; data.sync.stale = false;
  data.members[0].coverage.checkedAt = '2099-01-01T00:00:00Z'; data.members[1].coverage.status = 'future_status';
  let body = await (await harness({ data }).read()).json();
  assert.equal(body.sync.stale, true); assert.equal(body.sync.lastFullSyncAt, at);
  assert.equal(body.members[0].coverage.status, 'unknown'); assert.equal(body.members[0].coverage.checkedAt, null);
  assert.equal(body.members[1].coverage.status, 'unknown');
  data.sync.lastBattleSyncAt = '2026-09-17T11:24:59Z'; body = await (await harness({ data }).read()).json(); assert.equal(body.sync.stale, true);
  data.sync.lastBattleSyncAt = '2026-09-17T11:25:00Z'; body = await (await harness({ data }).read()).json(); assert.equal(body.sync.stale, false);
});

test('malformed counts, timestamps, identity and response bounds never become plausible event evidence', async () => {
  const changes = [
    data => { data.members[0].observedBattles = '3'; }, data => { data.members[0].observedBattles = -1; },
    data => { data.members[0].explicitMegaPigBattles = 4; }, data => { data.members[0].lastObservedBattleAt = at; },
    data => { data.members[0].lastExplicitMegaPigBattleAt = '2026-09-14T23:00:00Z'; },
    data => { data.members[1].lastObservedBattleAt = '2026-09-16T10:00:00Z'; },
    data => { data.members[0].coverage.possibleGap = 'false'; }, data => { data.members.push(data.members[0]); },
    data => { data.members = Array(31).fill(data.members[0]); }, data => { data.clubTag = '#OTHER'; },
    data => { data.eventId = '00000000-0000-4000-8000-000000000038'; }, data => { data.endsAt = '2026-11-01T00:00:00Z'; },
  ];
  for (const change of changes) {
    const data = snapshot(); change(data); const response = await harness({ data }).read();
    assert.equal(response.status, 503, String(change)); assert.deepEqual(await response.json(), { error: 'Event observations are temporarily unavailable. Please try again.' });
  }
});

test('upcoming and cancelled event snapshots retain their status without inventing attendance', async () => {
  const data = snapshot(); data.startsAt = '2026-09-18T00:00:00Z'; data.endsAt = '2026-09-19T00:00:00Z'; data.members = [data.members[1]];
  let response = await harness({ data }).read(), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.hasStarted, false); assert.equal(body.observedUntil, at);
  data.status = 'cancelled'; response = await harness({ data }).read(); body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.status, 'cancelled'); assert.equal(body.members[0].authoritativeWins, null);
});
