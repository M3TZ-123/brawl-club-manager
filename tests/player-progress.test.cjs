const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const json = value => JSON.parse(JSON.stringify(value));
const progress = loadTypeScript('src/lib/player-progress.ts');
const now = new Date('2026-09-16T12:00:00.000Z');
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now.getTime(); } }

test('optional profile data preserves zero and drops malformed/private values', () => {
  assert.deepEqual(json(progress.normalizeProfileProgress({ expPoints: 0, fame: 100, totalPrestigeLevel: 0, fameTierName: ' Global I ', secret: 'hidden' })), { exp_points: 0, fame: 100, total_prestige_level: 0, fame_tier_name: 'Global I' });
  for (const bad of [null, '12', -1, Infinity, NaN, 1.2, 2147483648, {}, []]) assert.deepEqual(json(progress.normalizeProfileProgress({ expPoints: bad, fame: bad, totalPrestigeLevel: bad })), {});
  assert.deepEqual(json(progress.normalizeProfileProgress({ fameTierName: ' '.repeat(10) })), {});
});
test('reported equipment distinguishes missing from empty, canonicalizes IDs and strips unrelated data', () => {
  const item = { highestTrophies: 0, prestigeLevel: 2, currentWinStreak: 0, maxWinStreak: 50,
    skin: { id: 4, name: 'Skin', secret: 'hidden' }, gadgets: [], starPowers: null,
    gears: [{ id: 3, name: ' Gear ', level: 1 }, { id: 1, name: 'Other' }],
    hyperCharges: [{ id: 5, name: 'Reported', ownership: true }], buffies: { gadget: false, starPower: true, hyperCharge: 'false', secret: true } };
  assert.deepEqual(json(progress.normalizeBrawlerProgress(item)), { highest_trophies: 0, prestige_level: 2, current_win_streak: 0, max_win_streak: 50,
    skin: { id: 4, name: 'Skin' }, gadgets: [], gears: [{ id: 1, name: 'Other' }, { id: 3, name: 'Gear', level: 1 }], hyper_charges: [{ id: 5, name: 'Reported' }], buffies: { gadget: false, starPower: true } });
  for (const value of [null, {}, [{ id: '1' }], [{ id: 1 }, { id: 1 }], [{ id: 1, level: -1 }], Array.from({ length: 201 }, (_, id) => ({ id }))]) assert.equal(progress.normalizeReportedEquipment(value), undefined);
});
test('battle duration retains explicit zero but never invents a duration from malformed or missing input', () => {
  const api = loadTypeScript('src/lib/brawl-api.ts', { axios: { create: () => ({}) } });
  const values = [0, 120, undefined, null, -1, 2.5, '60', 2147483648];
  const rows = api.processBattleLog('#AA', { items: values.map(duration => ({ battleTime: '20260916T110000.000Z', event: { mode: 'brawlBall', map: 'Map' }, battle: { duration, result: 'victory' } })) });
  assert.deepEqual(json(rows.map(row => row.duration_seconds)), [0, 120, null, null, null, null, null, null]);
});

function database(tables, options = {}) {
  const calls = [];
  return { calls, from(table) {
    const call = { table, filters: [], columns: null, limit: null }; calls.push(call);
    const filters = [], order = []; let single = false, head = false;
    const query = {
      select(columns, opts = {}) { call.columns = columns; head = opts.head; return query; },
      eq(key, value) { call.filters.push([key, value]); filters.push(row => row[key] === value); return query; },
      gt(key, value) { filters.push(row => row[key] > value); return query; },
      gte(key, value) { filters.push(row => row[key] >= value); return query; },
      lt(key, value) { filters.push(row => row[key] < value); return query; },
      lte(key, value) { filters.push(row => row[key] <= value); return query; },
      ilike(key, value) {
        call.search = value;
        const needle = value.slice(1, -1).replace(/\\([\\%_])/g, '$1').toLowerCase();
        filters.push(row => String(row[key]).toLowerCase().includes(needle)); return query;
      },
      order(key, opts = {}) { order.push([key, opts.ascending !== false]); return query; },
      limit(value) { call.limit = value; return query; },
      maybeSingle() { single = true; return query; },
      then(resolve, reject) {
        if (!Object.hasOwn(tables, table)) throw new Error(`Missing fixture ${table}`);
        let rows = tables[table].filter(row => filters.every(filter => filter(row)));
        rows.sort((a, b) => { for (const [key, asc] of order) { const d = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0; if (d) return asc ? d : -d; } return 0; });
        const count = rows.length; if (call.limit) rows = rows.slice(0, call.limit);
        return Promise.resolve({ data: head ? null : single ? rows[0] ?? null : rows, count, error: options.fail === table ? { message: 'private database failure' } : null }).then(resolve, reject);
      },
    };
    return query;
  } };
}
function fixture(options = {}) {
  const tag = '#AA', observed = '2026-09-16T11:00:00.000Z';
  const tables = {
    members: [{ player_tag: tag, highest_trophies: 1234, owner_user_id: 'PRIVATE' }],
    player_profile_details: [{ player_tag: tag, fame: 0, observed_at: observed, field_checked_at: { fame: observed, highest_trophies: observed, secret: observed } }],
    player_brawler_details: Array.from({ length: 5 }, (_, id) => ({ player_tag: tag, brawler_id: id + 1, brawler_name: id % 2 ? 'Colt' : 'Shelly', power_level: 11, trophies: 100, rank: null,
      highest_trophies: id ? 100 : null, gadgets: id ? [] : null, hyper_charges: [], buffies: { gadget: false }, observed_at: observed, field_checked_at: { hyper_charges: observed, secret: observed }, owner_user_id: 'PRIVATE' })),
    player_ranked_history: [1, 2, 3].map(id => ({ id, player_tag: tag, observed_at: id === 1 ? '2026-08-20T12:00:00.000Z' : `2026-09-16T1${id - 2}:00:00.000Z`, kind: id === 1 ? 'initial' : 'change', season_id: 48, points: id * 100, all_time_best: 'Masters', all_time_best_points: 0,
      source: 'profile', provenance: { ranked_points: { source: 'profile', checked_at: observed, key: 'PRIVATE' }, secret: { source: 'profile', checked_at: observed } } })),
    brawler_snapshots: [{ player_tag: tag, brawler_id: 1, recorded_at: '2026-08-20T12:00:00.000Z', power_level: 10, trophies: 50, rank: null }, { player_tag: tag, brawler_id: 1, recorded_at: observed, power_level: 11, trophies: 100, rank: null, gadgets_count: 0, star_powers_count: 0, gears_count: 0 }],
  };
  tables.player_brawler_details.push({ ...tables.player_brawler_details[0], player_tag: '#OTHER', brawler_name: 'Private unrelated', brawler_id: 99 });
  if (options.empty) { tables.player_profile_details = []; tables.player_brawler_details = []; tables.player_ranked_history = []; tables.brawler_snapshots = []; }
  if (options.notFound) tables.members = [];
  const db = database(tables, options);
  const route = loadTypeScript('src/app/api/members/[tag]/progress/route.ts', { '@/lib/supabase-admin': { supabaseAdmin: db }, 'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } } }, { Date: FixedDate });
  const get = async (query = '', tag = '%23AA') => route.GET(new Request(`http://fixture/api/members/${tag}/progress?${query}`), { params: Promise.resolve({ tag }) });
  return { get, db, tables };
}
test('collection search is applied before keyset paging and nullable details remain unknown', async () => {
  const f = fixture(); const response = await f.get('collectionSearch=Shelly&collectionLimit=1'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const a = await response.json(); assert.equal(a.collection.total, 3); assert.equal(a.collection.items[0].id, 1); assert.equal(a.collection.nextCursor, 1);
  const b = await (await f.get('collectionSearch=Shelly&collectionLimit=1&collectionCursor=1')).json(); assert.equal(b.collection.total, 3); assert.equal(b.collection.items[0].id, 3); assert.equal(b.collection.nextCursor, 3);
  const c = await (await f.get('collectionSearch=Shelly&collectionLimit=1&collectionCursor=3')).json(); assert.equal(c.collection.items[0].id, 5); assert.equal(c.collection.nextCursor, null);
  assert.equal(a.collection.items[0].rank, null); assert.equal(a.collection.items[0].highestTrophies, null); assert.equal(a.collection.items[0].gadgets, null); assert.deepEqual(a.collection.items[0].hyperCharges, []);
  assert.deepEqual(a.collection.items[0].buffies, { gadget: false, starPower: null, hyperCharge: null });
  assert.equal(a.profile.highestTrophies, 1234); assert.equal(a.profile.fame, 0); assert.equal(a.profile.expPoints, null);
  assert.equal(a.collection.lastCheckedAt, a.profile.lastCheckedAt); assert.ok(a.collection.items[0].fieldCheckedAt.hyperCharges);
  assert.doesNotMatch(JSON.stringify(a), /PRIVATE|secret|owner_user_id|Private unrelated/);
  assert.ok(f.db.calls.every(call => call.filters.some(([key, value]) => key === 'player_tag' && value === '#AA')));
  assert.ok(f.db.calls.every(call => call.columns && !call.columns.includes('*')));
});
test('rank and brawler histories use actual selected observations with independent retained coverage bounds', async () => {
  const f = fixture(); const a = await (await f.get('rankLimit=1&brawlerId=1')).json();
  assert.deepEqual(a.rankedHistory.items.map(row => row.id), ['3']); assert.equal(a.rankedHistory.coverageStart, '2026-08-20T12:00:00.000Z');
  assert.equal(a.rankedHistory.items[0].allTimeBestPoints, 0); assert.equal(a.rankedHistory.items[0].currentRank, null);
  const b = await (await f.get(`rankLimit=1&rankCursor=${a.rankedHistory.nextCursor}`)).json(); assert.deepEqual(b.rankedHistory.items.map(row => row.id), ['2']); assert.equal(b.rankedHistory.nextCursor, null);
  assert.equal(a.brawlerHistory.items.length, 1); assert.equal(a.brawlerHistory.items[0].recordedAt, '2026-09-16T11:00:00.000Z'); assert.equal(a.brawlerHistory.items[0].rank, null);
  assert.equal(a.brawlerHistory.coverageStart, '2026-08-20T12:00:00.000Z'); assert.equal(a.rankedHistory.retention.detailedDays, 7); assert.equal(a.rankedHistory.retention.dailyDays, 90);
  assert.ok(f.db.calls.filter(call => !['members', 'player_profile_details'].includes(call.table) && call.limit !== null).every(call => call.limit <= 201));
});
test('progress empty state, bounded parameters and query errors are truthful', async () => {
  const empty = await (await fixture({ empty: true }).get()).json();
  assert.equal(empty.profile.lastCheckedAt, null); assert.equal(empty.collection.total, 0); assert.deepEqual(empty.collection.items, []); assert.equal(empty.rankedHistory.coverageStart, null);
  assert.equal((await fixture({ notFound: true }).get()).status, 404);
  for (const query of ['collectionLimit=101', 'rankLimit=201', 'brawlerId=-1', 'collectionCursor=abc', 'rankCursor=bad', 'collectionSearch=' + 'x'.repeat(81)]) assert.equal((await fixture().get(query)).status, 400);
  assert.equal((await fixture().get('', '%INVALID')).status, 400);
  const response = await fixture({ fail: 'player_ranked_history' }).get(); assert.equal(response.status, 500); assert.doesNotMatch(JSON.stringify(await response.json()), /private database/);
});
test('one profile fetch feeds optional progress and ranks without new upstream calls', async () => {
  let committed, players = 0, rankedCalls = 0;
  const player = { tag: '#AA', name: 'A', trophies: 100, highestTrophies: 120, expLevel: 5, expPoints: 101, fame: 200, fameTierName: 'Global I', totalPrestigeLevel: 1,
    soloVictories: 1, duoVictories: 2, '3vs3Victories': 3, rankedRankName: 'DIAMOND I', rankedElo: 3417, highestAllTimeRankedRankName: 'MASTERS', highestAllTimeRankedElo: 0,
    brawlers: [{ id: 1, name: 'SHELLY', power: 11, trophies: 100, rank: 1, highestTrophies: 200, gadgets: [], starPowers: [], gears: [], hyperCharges: [], buffies: { gadget: false } }] };
  const db = { from: table => { assert.equal(table, 'settings'); return { select: () => ({ in: async () => ({ data: [{ key: 'club_tag', value: '#CLUB' }, { key: 'api_key', value: 'test-only' }] }) }) }; },
    rpc: async (name, args) => { if (name === 'acquire_sync_run') return { data: { acquired: true, run_id: 'test', fence: 1 } }; assert.equal(name, 'commit_sync_snapshot'); committed = args.p_payload; return { data: { success: true } }; } };
  const service = loadTypeScript('src/lib/sync-service.ts', {
    '@/lib/mega-pig-source-cache': { refreshMegaPigSource: async () => {} },
    '@/lib/sync-club-planning': { refreshPlanningAfterSync: async () => {} }, '@/lib/supabase-admin': { supabaseAdmin: db }, '@/lib/brawl-api': {
    getClub: async () => ({ members: [{ tag: '#AA', name: 'A', role: 'member' }] }), getPlayer: async () => { players++; return player; },
    getPlayerBattleLog: async () => ({ items: [] }), processBattleLog: () => [], calculateWinRateFromBattleLog: () => ({ winRate: null }),
    getPlayerRankedData: async () => { rankedCalls++; throw new Error('unexpected fallback'); },
  } });
  assert.equal((await service.executeSync({ source: 'cron' })).success, true); assert.equal(players, 1); assert.equal(rankedCalls, 0);
  assert.equal(committed.members[0].profile_progress.fame, 200); assert.equal(committed.brawlers[0].progress.highest_trophies, 200); assert.deepEqual(json(committed.brawlers[0].progress.hyper_charges), []);
});
