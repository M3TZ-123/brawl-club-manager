const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, elements, textContent } = require('./helpers/client-renderer.cjs');
const { buildClubIntelligence, intelligenceRange } = loadTypeScript('src/lib/club-intelligence.ts');
const { normalizeClubSnapshot } = loadTypeScript('src/lib/club-intelligence-snapshot.ts');
const now = new Date('2026-09-16T12:00:00Z');
const old = '2026-09-09T12:00:00Z';
const member = (tag = '#AA', trophies = 100) => ({ tag, name: tag, role: 'member', trophies, rank: null, updatedAt: now.toISOString(), inventory: 2, unknownPower: 0, power9: 2, power10: 1, power11: 1 });
const snapMember = (tag, trophies) => ({ tag, name: tag, role: 'member', trophies });
const snapshot = (at, values) => ({ firstAt: at, lastAt: at, first: values, last: values });
const raw = (overrides = {}) => ({ clubTag: '#CLUB', profile: { metadata: { name: 'Club', description: '', requiredTrophies: 0 }, observedAt: now.toISOString() },
  members: [member()], daily: [], coverage: [], gaps: [], snapshots: [], events: [], eventsTruncated: false, metadataHistory: [], ...overrides });
const event = (id, tag, type, at, source = 'recorded') => ({ id, tag, name: tag, type, at, source });
const plain = value => JSON.parse(JSON.stringify(value));

test('capture normalizes only complete unique club rosters and explicit public metadata', () => {
  const valid = normalizeClubSnapshot({ tag: '#CLUB', name: 'Club', description: '', type: 'open', badgeId: 0, requiredTrophies: 0, api_key: 'secret',
    members: [{ tag: '#AA', name: 'A', role: 'member', trophies: 0, owner_user_id: 'private' }] }, '#CLUB');
  assert.deepEqual(plain(valid), { metadata: { name: 'Club', description: '', type: 'open', badgeId: 0, requiredTrophies: 0 }, members: [snapMember('#AA', 0)].map(m => ({ ...m, name: 'A' })) });
  assert.equal(normalizeClubSnapshot({ tag: '#OTHER', members: [] }, '#CLUB'), null);
  assert.equal(normalizeClubSnapshot({ members: [{ tag: '#AA', name: 'A', role: 'member', trophies: null }] }, '#CLUB'), null);
  assert.equal(normalizeClubSnapshot({ members: [valid.members[0], valid.members[0]] }, '#CLUB'), null);
  assert.deepEqual(plain(normalizeClubSnapshot({ members: [] }, '#CLUB')), { metadata: {}, members: [] });
});

test('roster sync piggybacks sanitized club observations on its existing single game request', async () => {
  const calls = [], settings = [{ key: 'club_tag', value: '#CLUB' }, { key: 'api_key', value: 'test-only' }];
  const db = { from: () => ({ select() { return this; }, in: async () => ({ data: settings, error: null }) }),
    rpc: async (name, args) => { calls.push({ name, args }); return { data: name === 'acquire_sync_run' ? { acquired: true, run_id: 'run', fence: 1 } : { success: true, scope: 'roster' }, error: null }; } };
  const { executeSync } = loadTypeScript('src/lib/sync-service.ts', { '@/lib/supabase-admin': { supabaseAdmin: db },
    '@/lib/upstream-rate-limit': { getUpstreamCooldownMs: () => 0 }, '@/lib/brawl-api': { getClub: async () => {
      calls.push({ name: 'getClub' }); return { tag: '#CLUB', name: 'Club', description: 'Description', requiredTrophies: 0, owner_user_id: 'private', members: [{ tag: '#AA', name: 'A', role: 'member', trophies: 100 }] };
    } },
  });
  await executeSync({ source: 'cron', scope: 'roster' });
  assert.deepEqual(calls.map(call => call.name), ['acquire_sync_run', 'getClub', 'commit_roster_snapshot']);
  const snapshot = calls.at(-1).args.p_payload.club_snapshot;
  assert.equal(snapshot.metadata.description, 'Description'); assert.equal(snapshot.members[0].trophies, 100);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|owner_user_id/);
});

test('trophy decomposition uses complete endpoint rosters and marks intervening returns', () => {
  const result = buildClubIntelligence(raw({ members: [member('#AA', 150), member('#CC', 200)], snapshots: [
    snapshot(old, [snapMember('#AA', 100), snapMember('#BB', 300)]), snapshot(now.toISOString(), [snapMember('#AA', 150), snapMember('#CC', 200)]),
  ], events: [event('1', '#AA', 'leave', '2026-09-10T00:00:00Z'), event('2', '#AA', 'join', '2026-09-11T00:00:00Z')] }), '7d', now);
  assert.equal(result.growth.status, 'observed');
  assert.equal(result.growth.totalChange, -50); assert.equal(result.growth.commonProgress, 50);
  assert.equal(result.growth.addedTrophies, 200); assert.equal(result.growth.removedTrophies, 300);
  assert.equal(result.growth.totalChange, result.growth.commonProgress + result.growth.addedTrophies - result.growth.removedTrophies);
  assert.equal(result.growth.returningMembers, 1); assert.equal(result.growth.points.length, 2);
});

test('growth never invents a starting balance or treats a months-old observation as a requested baseline', () => {
  for (const snapshots of [[], [snapshot(now.toISOString(), [snapMember('#AA', 100)])], [snapshot('2026-08-01T00:00:00Z', [snapMember('#AA', 50)]), snapshot(now.toISOString(), [snapMember('#AA', 100)])]]) {
    const growth = buildClubIntelligence(raw({ snapshots }), '7d', now).growth;
    assert.equal(growth.status, 'insufficient_history'); assert.equal(growth.totalChange, null); assert.equal(growth.commonProgress, null);
  }
});

test('calendar UTC cells distinguish observed zero, pretracking, partial day, gaps and old limited evidence', () => {
  const result = buildClubIntelligence(raw({ coverage: [{ tag: '#AA', baselineAt: '2026-09-10T12:00:00Z', checkedAt: now.toISOString() }],
    daily: [{ tag: '#AA', day: '2026-09-12', battles: 5, wins: 3 }], gaps: [{ tag: '#AA', start: '2026-09-12T23:00:00Z', end: '2026-09-13T01:00:00Z' }] }), '30d', now);
  const cells = new Map(result.calendar.rows[0].cells.map(cell => [cell.day, cell]));
  assert.equal(result.calendar.days.length, 30); assert.equal(result.calendar.days.at(-1), '2026-09-16');
  assert.equal(cells.get('2026-09-09').coverage, 'before_tracking'); assert.equal(cells.get('2026-09-09').battles, null);
  assert.equal(cells.get('2026-09-10').coverage, 'partial');
  assert.equal(cells.get('2026-09-11').battles, 0); assert.equal(cells.get('2026-09-11').coverage, 'monitored');
  assert.equal(cells.get('2026-09-12').battles, 5); assert.equal(cells.get('2026-09-12').coverage, 'possible_gap');
  assert.equal(cells.get('2026-09-13').coverage, 'possible_gap'); assert.equal(cells.get('2026-09-16').coverage, 'partial');
  assert.equal(result.calendar.observedParticipations, 5); assert.equal(result.calendar.completeHistory, false);
  const link = new URL(cells.get('2026-09-12').href, 'https://app.test'); assert.equal(link.searchParams.get('member'), '#AA'); assert.equal(link.searchParams.get('day'), '2026-09-12');
  const older = buildClubIntelligence(raw({ coverage: [{ tag: '#AA', baselineAt: '2026-01-01T00:00:00Z', checkedAt: now.toISOString() }] }), '90d', now);
  assert.equal(older.calendar.rows[0].cells[0].coverage, 'limited'); assert.equal(older.calendar.rows[0].cells[0].battles, null);
});

test('retention separates rejoining spells, excludes first-observed and reconstructed joins, and waits for maturity', () => {
  const result = buildClubIntelligence(raw({ members: [member('#AA'), member('#BB'), member('#CC'), member('#DD')], snapshots: [snapshot(now.toISOString(), [snapMember('#AA', 100)])], events: [
    event('1', '#AA', 'join', '2026-08-01T00:00:00Z'), event('2', '#AA', 'leave', '2026-08-03T00:00:00Z'), event('3', '#AA', 'join', '2026-08-04T00:00:00Z'),
    event('4', '#BB', 'initial_seen', '2026-08-01T00:00:00Z'), event('5', '#CC', 'join', '2026-08-01T00:00:00Z', 'reconstructed'), event('6', '#DD', 'join', '2026-09-15T00:00:00Z'),
  ] }), '7d', now);
  for (const cohort of result.retention.cohorts) {
    assert.equal(cohort.eligible, 2); assert.equal(cohort.retained, 1); assert.equal(cohort.departed, 1); assert.equal(cohort.pending, 1); assert.equal(cohort.excluded, 2); assert.equal(cohort.rate, 50);
  }
  const spells = result.retention.spells.filter(spell => spell.playerTag === '#AA'); assert.equal(spells.length, 2); assert.equal(spells[0].returning, true); assert.equal(spells[1].returning, false);
  assert.equal(buildClubIntelligence(raw({ eventsTruncated: true }), '7d', now).retention.cohorts[0].rate, null);
});

test('nullable legacy daily counts stay unknown even on a monitored day', () => {
  const result = buildClubIntelligence(raw({ coverage: [{ tag: '#AA', baselineAt: '2026-08-01T00:00:00Z', checkedAt: now.toISOString() }],
    daily: [{ tag: '#AA', day: '2026-09-12', battles: null, wins: null }],
  }), '7d', now);
  const cell = result.calendar.rows[0].cells.find(cell => cell.day === '2026-09-12');
  assert.equal(cell.coverage, 'monitored'); assert.equal(cell.battles, null); assert.equal(cell.wins, null);
  assert.equal(result.calendar.observedParticipations, 0);
});

test('strength uses all members, truthful median and nullable ranks, without leaking source fields', () => {
  const result = buildClubIntelligence(raw({ members: [member('#AA', 100), member('#BB', 200), member('#CC', 500), member('#DD', 1000)],
    profile: { metadata: { name: 'Club', api_key: 'secret', notes: 'private' }, observedAt: now.toISOString() },
    metadataHistory: [{ id: '1', at: now.toISOString(), before: { name: 'Before', owner_user_id: 'private' }, after: { name: 'Club', secret: 'hidden' }, fields: ['name', 'secret'] }],
  }), '7d', now);
  assert.equal(result.strength.medianTrophies, 350); assert.equal(result.strength.topCount, 4); assert.equal(result.strength.top10Average, 450);
  assert.equal(result.strength.power[2].brawlers, 4); assert.equal(result.strength.power[2].members, 4);
  assert.equal(result.club.rosterTrophies, 1800); assert.equal(result.club.openSeats, 26); assert.equal(result.strength.ranks[0].rank, null);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|owner_user_id/);
});

test('range validation and API errors cannot start upstream work or return raw database diagnostics', async () => {
  assert.equal(intelligenceRange(null), '7d'); assert.throws(() => intelligenceRange('all'));
  const calls = [];
  const route = loadTypeScript('src/app/api/club-intelligence/route.ts', { 'next/server': { NextResponse: { json: Response.json } },
    '@/lib/club-intelligence-service': { readClubIntelligence: async range => { calls.push(range); throw Error('secret database error'); } },
  });
  assert.equal((await route.GET(new Request('https://app.test/api/club-intelligence?range=all'))).status, 400); assert.equal(calls.length, 0);
  const response = await route.GET(new Request('https://app.test/api/club-intelligence?range=90d'));
  assert.equal(response.status, 503); assert.doesNotMatch(JSON.stringify(await response.json()), /secret/); assert.deepEqual(calls, ['90d']);
});

test('calendar renders member-day links, visible uncertainty and its own bounded period control', async () => {
  const result = buildClubIntelligence(raw(), '7d', now), renderer = hookRenderer(), ranges = [];
  const { ClubActivityCalendar } = loadTypeScript('src/components/club-activity-calendar.tsx', { ...componentMocks, react: renderer.react,
    '@/components/club-intelligence-panel': { ClubIntelligencePanel: 'Panel', useClubIntelligence: range => { ranges.push(range); return { data: result }; } },
  });
  let tree = await renderer.render(() => ClubActivityCalendar({}));
  const link = elements(tree).find(node => node.props?.href?.includes('day=')); assert.ok(link.props['aria-label'].includes('Unknown'));
  assert.match(textContent(tree), /not proof of no play/);
  const select = elements(tree).find(node => node.type === 'select'); select.props.onChange({ target: { value: '90d' } });
  tree = await renderer.render(() => ClubActivityCalendar({})); assert.equal(ranges.at(-1), '90d');
  assert.equal(elements(tree).filter(node => node.type === 'option').length, 3);
});

test('growth UI does not display invented deltas before a baseline and new Arabic copy is available', async () => {
  const result = buildClubIntelligence(raw(), '7d', now), renderer = hookRenderer();
  const { ClubGrowth } = loadTypeScript('src/components/club-growth.tsx', { ...componentMocks, react: renderer.react,
    '@/components/club-intelligence-panel': { ClubIntelligencePanel: 'Panel', useClubIntelligence: () => ({ data: result }) },
  });
  const tree = await renderer.render(() => ClubGrowth({})); assert.match(textContent(tree), /starting roster has not been recorded/); assert.doesNotMatch(textContent(tree), /Present only at the end/);
  const { arClubIntelligence } = loadTypeScript('src/lib/i18n/ar-club-intelligence.ts');
  for (const key of ['Member activity calendar', 'What changed the club trophies?', 'Observed member retention', 'Before monitoring baseline', 'Roster strength']) assert.match(arClubIntelligence[key], /[\u0600-\u06ff]/);
});

test('club metadata history localizes admission values and hides numeric badge identifiers', async () => {
  const result = buildClubIntelligence(raw({ metadataHistory: [{ id: '1', at: now.toISOString(), before: { badgeId: 80000123, type: 'open' },
    after: { badgeId: 80000456, type: 'closed' }, fields: ['badgeId', 'type'] }] }), '7d', now);
  const renderer = hookRenderer(), translated = [];
  const { ClubIdentity } = loadTypeScript('src/components/club-identity.tsx', { ...componentMocks, react: renderer.react,
    '@/components/locale-provider': { useI18n: () => ({ t: key => { translated.push(key); return key; }, number: String, dateTime: String }) },
    '@/components/club-intelligence-panel': { ClubIntelligencePanel: 'Panel', useClubIntelligence: () => ({ data: result }) },
  });
  const tree = await renderer.render(() => ClubIdentity({ showHistory: true }));
  assert.match(textContent(tree), /Club badge changed/); assert.doesNotMatch(textContent(tree), /80000123|80000456/);
  assert.ok(translated.includes('open')); assert.ok(translated.includes('closed'));
});
