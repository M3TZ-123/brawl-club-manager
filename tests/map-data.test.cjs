const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const data = loadTypeScript('src/lib/map-data.ts');
const stats = loadTypeScript('src/lib/map-statistics.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const now = Date.parse('2026-09-18T01:00:00Z');
const period = stats.mapStatisticsPeriod(now);
const target = { mapId: 15000007, mode: 'gemGrab', name: 'Hard Rock Mine' };
const catalogRow = (extra = {}) => ({ id: target.mapId, name: target.name, gameMode: { id: 48000000 }, imageUrl: 'https://cdn.brawlify.com/maps/regular/15000007.png', link: 'https://brawlify.com/maps/15000007', ...extra });
const row = (extra = {}) => ({ 'map.eventId_measure': '15000007', 'map.map_dimension': 'Hard Rock Mine', 'map.mode_dimension': 'gemGrab', 'map.brawler_dimension': 'SHELLY', 'map.picks_measure': '200', 'map.winRate_measure': '.5', 'map.winRateAdj_measure': '.55', 'map.rank1Rate_measure': '.2', 'map.timestamp_measure': '2026-09-18T00:00:00Z', ...extra });

test('trophy filters are finite, default to1000 individual-brawler trophies and use verified hundred-trophy buckets', () => {
  assert.equal(data.parseMapTrophyRange(null), '1000');
  assert.equal(data.parseMapTrophyRange(undefined), '1000');
  for (const value of ['', '100', '600+', '1000 OR 1=1', '1000.0', 1000, ['600'], true]) assert.equal(data.parseMapTrophyRange(value), null);
  for (const [range, minimum, bucket] of [['all', null, null], ['600', 600, '6'], ['1000', 1000, '10']]) {
    const query = stats.mapStatisticsQuery([target], period, range);
    const filter = query.filters.find(item => item.member === 'map.trophyRange_dimension');
    assert.equal(data.parseMapTrophyRange(range), range);
    assert.equal(data.mapMinTrophies(range), minimum);
    if (bucket === null) assert.equal(filter, undefined);
    else assert.deepEqual(plain(filter), { member: 'map.trophyRange_dimension', operator: 'gte', values: [bucket] });
    assert.equal(stats.normalizeMapStatistics({ data: [] }, [target], period, now, range)[0].minTrophies, minimum);
  }
  assert.equal(stats.mapStatisticsQuery([target], period).filters.find(item => item.member === 'map.trophyRange_dimension').values[0], '10');
  assert.throws(() => stats.mapStatisticsQuery([target], period, '2000'));
});

test('map catalog projects identity/art only and never treats static source zeros as statistics', () => {
  const result = data.normalizeMapCatalog({ list: [catalogRow({ stats: [{ brawler: 1, winRate: 99 }], dataUpdated: 0, secret: 'PRIVATE' })] });
  assert.equal(result[0].mode, 'gemGrab');
  assert.equal(result[0].imageUrl, 'https://cdn.brawlify.com/maps/regular/15000007.png');
  assert.equal(result[0].statsUpdatedAt, null);
  assert.equal(result[0].statsStatus, 'unavailable');
  assert.equal(result[0].sampleSize, null);
  assert.deepEqual(plain(result[0].brawlers), []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|dataUpdated/);
});

test('catalog refuses mismatched or unsafe asset destinations and never guesses unknown mode IDs', () => {
  for (const imageUrl of ['https://attacker.invalid/15000007.png', 'https://cdn.brawlify.com/maps/regular/15000008.png', 'https://cdn.brawlify.com@attacker.invalid/maps/regular/15000007.png']) {
    const result = data.normalizeMapCatalog({ list: [catalogRow({ imageUrl, link: 'javascript:alert(1)' })] });
    assert.equal(result[0].imageUrl, null);
    assert.equal(result[0].sourceUrl, null);
  }
  assert.deepEqual(plain(data.normalizeMapCatalog({ list: [catalogRow({ gameMode: { id: 48999999 } })] })), []);
  for (const list of [[catalogRow(), catalogRow()], [catalogRow({ id: -1 })], [catalogRow({ name: '' })]]) assert.throws(() => data.normalizeMapCatalog({ list }));
});

test('Ninja period uses its verified UTC two-week bucket, not a rolling date or Ranked season', () => {
  assert.deepEqual(plain(period), { start: '2026-09-14T08:00:00.000Z', end: '2026-09-28T08:00:00.000Z' });
  assert.equal(stats.mapStatisticsPeriod(Date.parse('2026-09-14T08:00:00Z')).end, '2026-09-14T08:00:00.000Z');
  assert.equal(stats.mapStatisticsPeriod(Date.parse('2026-09-14T08:00:00.001Z')).end, period.end);
  const query = stats.mapStatisticsQuery([target], period);
  assert.equal(query.filters[1].operator, 'equals');
  assert.deepEqual(plain(query.filters[1].values), ['2026-09-28']);
  assert.deepEqual(plain(query.filters[2].values), ['0']);
  assert.ok(query.measures.includes('map.rank1Rate_measure'));
  assert.equal(query.limit, 20000);
  assert.throws(() => stats.mapStatisticsQuery([], period));
  assert.throws(() => stats.mapStatisticsQuery(Array(101).fill(target), period));
  const five = stats.mapStatisticsQuery([{ ...target, mode: 'brawlBall5v5' }], period);
  assert.ok(five.filters[0].or[0].and[1].values.includes('brawlBall5V5'));
});

test('pick share uses every exact-map participation including unknown future brawlers', () => {
  const result = stats.normalizeMapStatistics({ data: [row(), row({ 'map.brawler_dimension': 'FUTURE BRAWLER', 'map.picks_measure': '800' })], private: 'PRIVATE' }, [target], period, now)[0];
  assert.equal(result.sampleSize, 1000);
  assert.equal(result.sampleUnit, 'player_results');
  assert.equal(result.brawlers[0].pickRate, 20);
  assert.equal(result.brawlers[1].pickRate, 80);
  assert.equal(result.brawlers[1].id, null);
  assert.equal(result.brawlers[1].imageUrl, null);
  assert.equal(result.brawlers[1].sampleSize, 800);
  assert.equal(result.brawlers[0].winRate, 50);
  assert.equal(result.brawlers[0].imageUrl, 'https://cdn.brawlify.com/brawlers/borders/16000000.png');
  assert.equal(result.brawlers[0].adjustedWinRate, 55.00000000000001);
  assert.equal(result.winRateKind, 'victory');
  assert.equal(result.statsUpdatedAt, '2026-09-18T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|map\.picks/);
});

test('other names and modes cannot contaminate the sample denominator', () => {
  const rows = [row(), row({ 'map.mode_dimension': 'heist' }), row({ 'map.map_dimension': 'Another map' })];
  const result = stats.normalizeMapStatistics({ data: rows }, [target], period, now)[0];
  assert.equal(result.sampleSize, 200);
  assert.equal(result.brawlers.length, 1);
  assert.equal(result.brawlers[0].pickRate, 100);
});

test('conflicting IDs for one name/mode invalidate the whole target instead of inflating remaining pick shares', () => {
  const rows = [row(), row({ 'map.eventId_measure': '15000008', 'map.brawler_dimension': 'COLT' })];
  assert.deepEqual(plain(stats.normalizeMapStatistics({ data: rows }, [target], period, now)), []);
});

test('Showdown uses first-place probability rather than normalized placement or adjusted score', () => {
  for (const mode of ['soloShowdown', 'duoShowdown', 'trioShowdown']) {
    const result = stats.normalizeMapStatistics({ data: [row({ 'map.mode_dimension': mode, 'map.winRate_measure': '.8', 'map.winRateAdj_measure': '.85', 'map.rank1Rate_measure': '.2' })] }, [{ ...target, mode }], period, now)[0];
    assert.equal(result.winRateKind, 'first_place');
    assert.equal(result.brawlers[0].winRate, 20);
    assert.equal(result.brawlers[0].adjustedWinRate, null);
  }
  const result = stats.normalizeMapStatistics({ data: [row({ 'map.mode_dimension': 'soloShowdown', 'map.rank1Rate_measure': null })] }, [{ ...target, mode: 'soloShowdown' }], period, now)[0];
  assert.equal(result.brawlers[0].winRate, null);
});

test('unsupported formats retain observed usage without claiming known win semantics', () => {
  for (const mode of ['bossFight', 'futureMode']) {
    const result = stats.normalizeMapStatistics({ data: [row({ 'map.mode_dimension': mode })] }, [{ ...target, mode }], period, now)[0];
    assert.equal(result.winRateKind, null);
    assert.equal(result.brawlers[0].winRate, null);
    assert.equal(result.brawlers[0].adjustedWinRate, null);
    assert.equal(result.brawlers[0].pickRate, 100);
  }
  const arena = stats.normalizeMapStatistics({ data: [row({ 'map.mode_dimension': 'brawlArena' })] }, [{ ...target, mode: 'brawlArena' }], period, now)[0];
  assert.equal(arena.winRateKind, 'victory');
  assert.equal(arena.brawlers[0].winRate, 50);
});

test('zero and missing samples remain distinct and invalid rates never become percentages', () => {
  const empty = stats.normalizeMapStatistics({ data: [] }, [target], period, now)[0];
  assert.equal(empty.sampleSize, null);
  assert.equal(empty.statsUpdatedAt, null);
  const zero = stats.normalizeMapStatistics({ data: [row({ 'map.picks_measure': '0', 'map.winRate_measure': '0', 'map.winRateAdj_measure': '0' })] }, [target], period, now)[0];
  assert.equal(zero.sampleSize, 0);
  assert.equal(zero.brawlers[0].winRate, 0);
  assert.equal(zero.brawlers[0].pickRate, null);
  for (const value of [null, '', 'NaN', 'Infinity', '-.5', '1.01', {}, true]) {
    const result = stats.normalizeMapStatistics({ data: [row({ 'map.winRate_measure': value })] }, [target], period, now)[0];
    assert.equal(result.brawlers[0].winRate, null);
  }
});

test('unknown or future provider dates never masquerade as retrieval/observation freshness', () => {
  for (const at of [null, '', 'invalid', '2026-09-18T02:00:00Z', '2026-09-01T00:00:00Z']) {
    const result = stats.normalizeMapStatistics({ data: [row({ 'map.timestamp_measure': at })] }, [target], period, now)[0];
    assert.equal(result.statsUpdatedAt, null);
  }
});

test('partial/capped, duplicate and corrupt count responses fail instead of fabricating pick shares', () => {
  for (const value of [{}, { data: Array(20000).fill(row()) }, { data: [row(), row()] }, { data: [row({ 'map.picks_measure': '1.5' })] }, { data: [row({ 'map.picks_measure': '-1' })] }]) {
    assert.throws(() => stats.normalizeMapStatistics(value, [target], period, now));
  }
});
