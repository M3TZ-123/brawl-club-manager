const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { readOnlyDatabase } = require('./helpers/read-only-database.cjs');
const at = '2026-09-17T12:00:00.000Z';
const next = { NextResponse: { json: (body, init) => Response.json(body, init) } };
const env = { ADMIN_PASSWORD: 'local-fixture', ADMIN_SESSION_SECRET: 'local-session-fixture', NODE_ENV: 'test' };
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return Date.parse(at); } }
const globals = { Date: FixedDate, process: { env } };
const auth = loadTypeScript('src/lib/admin-auth.ts', { 'next/server': next }, globals);
const profile = () => ({ trophies: 1000, trophiesCheckedAt: at, power11: 2, profileCheckedAt: at, rank: 'Diamond I', rankedPoints: 3000, rankedSeasonId: 48, rankedCheckedAt: at });
function snapshot(range = '7d') {
  const days = Number.parseInt(range), end = Date.parse('2026-09-17T00:00:00Z');
  return { clubTag: '#CLUB', generatedAt: at, range, rosterCheckedAt: at, members: [{
    tag: '#PYLQ', name: 'عضو', role: 'member', profile: profile(), lastActivityAt: '2026-09-10T12:00:00Z', lastBattleAt: null,
    spell: { startedAt: '2026-07-01T00:00:00Z', source: 'recorded', kind: 'join', uncertain: false }, graceUntil: null, absence: null,
    coverage: { baselineAt: '2026-07-01T00:00:00Z', checkedAt: at, lastStatus: 'observed', trailing48hGap: false, trailing48hExcused: false },
    days: Array.from({ length: days }, (_, i) => ({ date: new Date(end - (days - i) * 86400000).toISOString().slice(0, 10), battles: 0, possibleGap: false, absenceOverlap: false })),
    events: [], eventsTruncated: false,
  }], candidates: [{ kind: 'candidate', tag: '#PYLR', name: 'Candidate', status: 'shortlisted', profile: { ...profile(), rankedSeasonId: null }, commitment: 'unknown' }] };
}
function harness({ data = snapshot(), rpcError = null, afterRpc, configured = true } = {}) {
  const calls = [], tables = { settings: [{ key: 'club_tag', value: '#CLUB' }, { key: 'last_roster_sync_time', value: at }] };
  const db = { from(table) { calls.push({ table }); assert.equal(table, 'settings'); return readOnlyDatabase(tables).from(table); },
    async rpc(name, args) { calls.push({ name, args }); afterRpc?.(tables); return { data: typeof data === 'function' ? data(args) : data, error: rpcError }; } };
  const route = loadTypeScript('src/app/api/member-comparison/route.ts', { 'next/server': next, '@/lib/supabase-admin': { supabaseAdmin: db } },
    { ...globals, process: { env: configured ? env : {} } });
  const read = (query = '', cookie = `brawlstatz_admin=${auth.createAdminSessionToken()}`) => route.GET(new Request(`https://fixture/api/member-comparison${query ? '?' + query : ''}`, { headers: cookie ? { cookie } : {} }));
  return { read, calls, tables };
}

test('comparison rejects anonymous, malformed or unconfigured admin requests before any database read', async () => {
  for (const cookie of ['', 'brawlstatz_admin=%E0%A4%A', 'brawlstatz_admin=invalid']) {
    const source = harness(), response = await source.read('', cookie);
    assert.equal(response.status, 401); assert.equal(source.calls.length, 0);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('vary'), 'Cookie');
  }
  const source = harness({ configured: false }); assert.equal((await source.read()).status, 503); assert.equal(source.calls.length, 0);
});
test('strict period validation precedes reads and three supported periods use one readonly snapshot RPC', async () => {
  for (const query of ['range=24h', 'range=', 'range=7d&range=30d', 'range=7d&player_tag=%23PYLR', 'refresh=true']) {
    const source = harness(), response = await source.read(query); assert.equal(response.status, 400); assert.equal(source.calls.length, 0);
  }
  for (const range of ['7d', '30d', '90d']) {
    const source = harness({ data: snapshot(range) }), response = await source.read(range === '7d' ? '' : `range=${range}`), body = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('vary'), 'Cookie');
    assert.equal(body.period.key, range); assert.equal(body.period.end, '2026-09-17T00:00:00.000Z'); assert.equal(body.period.completedDaysOnly, true);
    const rpc = source.calls.filter(call => call.name); assert.equal(rpc.length, 1); assert.equal(rpc[0].name, 'member_comparison_read');
    assert.deepEqual(JSON.parse(JSON.stringify(rpc[0].args)), { p_club: '#CLUB', p_days: Number.parseInt(range), p_now: at });
    assert.equal(source.calls.filter(call => call.table === 'settings').length, 2);
  }
});
test('comparison excludes private text and future/invalid metrics without substituting zero', async () => {
  const data = snapshot(); data.notes = 'PRIVATE'; const member = data.members[0];
  member.notes = 'PRIVATE'; member.owner_user_id = 'PRIVATE'; member.profile.secret = 'PRIVATE'; member.coverage.secret = 'PRIVATE';
  member.profile.power11 = '2'; member.profile.rankedPoints = -1; member.profile.profileCheckedAt = '2099-01-01T00:00:00Z';
  member.absence = { startsAt: '2026-09-17T00:00:00Z', endsAt: '2026-09-18T00:00:00Z', reason: 'PRIVATE' };
  data.candidates[0].notes = 'PRIVATE'; data.candidates[0].profile.refresh_token = 'PRIVATE';
  const response = await harness({ data }).read(), body = await response.json();
  assert.equal(response.status, 200); assert.doesNotMatch(JSON.stringify(body), /PRIVATE|secret|owner_user_id|refresh_token/);
  assert.equal(body.members[0].profile.power11, null); assert.equal(body.members[0].profile.rankedPoints, null); assert.equal(body.members[0].profile.profileCheckedAt, null);
  assert.equal(body.members[0].protection.activeAbsence, true); assert.equal(body.candidates[0].commitment, 'unknown');
});
test('roster switches and RPC admission conflict fail closed and never return assembled player data', async () => {
  for (const value of ['#OTHER', '']) {
    const source = harness({ afterRpc: tables => { tables.settings[0].value = value; } }), response = await source.read();
    assert.equal(response.status, 409); assert.deepEqual(Object.keys(await response.json()), ['error']);
  }
  const source = harness({ rpcError: { code: '40001', message: 'PRIVATE ERROR' } }), response = await source.read();
  assert.equal(response.status, 409); assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE/);
});
test('malformed/truncated snapshot bounds and database errors are safe503s', async () => {
  const variants = [
    data => { data.members = Array.from({ length: 31 }, () => data.members[0]); },
    data => { data.candidates = Array.from({ length: 101 }, () => data.candidates[0]); },
    data => { data.members[0].days.pop(); }, data => { data.members[0].days[0].date = '2026-99-99'; },
    data => { data.members[0].days[0].date = '2026-09-17'; }, data => { data.clubTag = '#OTHER'; },
  ];
  for (const change of variants) { const data = snapshot(); change(data); const response = await harness({ data }).read(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'Member comparison is temporarily unavailable. Please try again.' }); }
  const response = await harness({ rpcError: { code: 'XX000', message: 'PRIVATE KEY' } }).read();
  assert.equal(response.status, 503); assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE|XX000/);
});
test('bad event observation times cannot turn unknown records into an absence recommendation', async () => {
  const data = snapshot(); data.members[0].events = Array.from({ length: 3 }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, version: 1,
    title: 'Completed event', kind: 'custom', startsAt: '2026-09-16T00:00:00Z', endsAt: '2026-09-16T01:00:00Z', observedAt: '2026-09-16T02:00:00Z', status: 'completed', attendance: 'absent', absenceOverlap: false }));
  const body = await (await harness({ data }).read()).json();
  assert.equal(body.members[0].events.absent, 0); assert.equal(body.members[0].events.unresolved, 3);
  assert.equal(body.members[0].events.repeatedAbsences, false);
});
test('invalid or future activity timestamps never become evidence of48hour inactivity after normalization', async () => {
  for (const key of ['lastActivityAt', 'lastBattleAt']) for (const value of ['not-a-date', '2099-01-01T00:00:00Z']) {
    const data = snapshot(); data.members[0][key] = value;
    const body = await (await harness({ data }).read()).json();
    assert.equal(body.members[0].activity.noRecentActivity, false);
    assert.equal(body.members[0].assessment.reasons.includes('no_recent_activity'), false);
  }
});
test('verified roster observation unlocks legacy assessment without substituting an invented join or exposing extra fields', async () => {
  const data = snapshot(), member = data.members[0];
  member.spell = { startedAt: '2026-07-01T00:00:00Z', source: 'reconstructed', kind: 'join', uncertain: true };
  member.membershipObservation = { observedSince: '2026-09-01T03:04:05Z', checkedAt: at, source: 'roster_snapshot',
    graceUntil: '2026-09-03T03:04:05Z', reason: 'PRIVATE OBSERVATION', members: ['PRIVATE ROSTER'] };
  const body = await (await harness({ data }).read()).json(), result = body.members[0];
  assert.equal(result.protection.spellSource, 'reconstructed');
  assert.equal(result.protection.spellStartedAt, '2026-07-01T00:00:00.000Z');
  assert.equal(result.protection.observedSince, '2026-09-01T03:04:05.000Z');
  assert.equal(result.protection.observationSource, 'roster_snapshot');
  assert.equal(result.protection.active, false); assert.equal(result.activity.evaluatedDays, 7);
  assert.equal(result.assessment.limitations.includes('observed_membership_only'), true);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|reason.*OBSERVATION/);
});
test('invalid observation grace, times or source never lift uncertain-membership protection during projection', async () => {
  for (const patch of [{ graceUntil: 'invalid' }, { graceUntil: undefined }, { graceUntil: '2026-08-01T00:00:00Z' },
    { observedSince: '2099-01-01T00:00:00Z' }, { checkedAt: '2099-01-01T00:00:00Z' },
    { checkedAt: '2026-09-01T00:00:00Z' }, { source: 'invented' }]) {
    const data = snapshot(), member = data.members[0];
    member.spell = { startedAt: null, source: 'unknown', kind: 'unknown', uncertain: true };
    member.membershipObservation = { observedSince: '2026-09-01T03:04:05Z', checkedAt: at, source: 'roster_snapshot', graceUntil: null, ...patch };
    const body = await (await harness({ data }).read()).json(), result = body.members[0];
    assert.equal(result.protection.active, true); assert.equal(result.protection.observationSource, null);
    assert.equal(result.activity.evaluatedDays, 0); assert.equal(result.activity.noRecentActivity, false);
  }
});
