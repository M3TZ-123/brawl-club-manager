const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');

// Use the installed Next implementation, including its App Router nested-cache
// behavior and stale revalidation. Only the persistent backing store is a fixture.
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
const { unstable_cache } = require('next/dist/server/web/spec-extension/unstable-cache');
const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external');
const { workUnitAsyncStorage } = require('next/dist/server/app-render/work-unit-async-storage.external');
const event = { slotId: 1, id: 15000007, mode: 'gemGrab', map: 'Hard Rock Mine', startTime: '2026-09-18T00:00:00Z', endTime: '2026-09-19T08:00:00Z' };
const catalog = { list: [15000007, 15000008].map(id => ({ id, name: 'Hard Rock Mine', gameMode: { id: 48000000 }, imageUrl: `https://cdn.brawlify.com/maps/regular/${id}.png`, link: `https://brawlify.com/maps/${id}` })) };
const rows = { data: [{ 'map.eventId_measure': '15000007', 'map.map_dimension': 'Hard Rock Mine', 'map.mode_dimension': 'gemGrab', 'map.brawler_dimension': 'SHELLY', 'map.picks_measure': '200', 'map.winRate_measure': '.5', 'map.winRateAdj_measure': '.55', 'map.timestamp_measure': '2026-09-18T00:30:00Z' }] };

function harness() {
  let now = Date.parse('2026-09-18T01:00:00Z');
  const calls = { catalog: 0, token: 0, stats: 0, events: 0 }, entries = new Map();
  const failures = { catalog: false, stats: false };
  const rangeResponses = new Map(), rangeQueries = [];
  let rotation = { data: [event], fetchedAt: new Date(now).toISOString(), stale: false, refreshing: false };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const incrementalCache = {
    generateSimpleCacheKey: async key => key,
    get: async key => { const saved = entries.get(key); return saved ? { value: saved.value, isStale: now - saved.at >= saved.value.revalidate * 1000 } : null; },
    set: async (key, value) => { entries.set(key, { value, at: now }); },
  };
  const worker = () => loadTypeScript('src/lib/map-cache.ts', {
    'next/cache': { unstable_cache },
    './game-cache': { loadGameData: async kind => { assert.equal(kind, 'events'); calls.events++; return rotation; } },
  }, { Date: Clock, fetch: async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    let value;
    if (url === 'https://api.brawlapi.com/v1/maps') {
      calls.catalog++; if (failures.catalog) throw Error('SECRET CATALOG FAILURE'); value = catalog;
    } else if (url === 'https://brawltime.ninja/api/auth.getToken') {
      calls.token++; value = { result: { data: { json: { token: 'TEST_ANONYMOUS_SECRET', expiresAt: now + 86_400_000 } } } };
    } else if (url.startsWith('https://cube.brawltime.ninja/cubejs-api/v1/load?query=')) {
      calls.stats++; assert.equal(options.headers.Authorization, 'TEST_ANONYMOUS_SECRET');
      const query = JSON.parse(new URL(url).searchParams.get('query'));
      assert.equal(query.filters[0].or.length, 1);
      const bucket = query.filters.find(item => item.member === 'map.trophyRange_dimension')?.values[0];
      const range = bucket === undefined ? 'all' : String(Number(bucket) * 100);
      rangeQueries.push(range);
      if (failures.stats) throw Error('SECRET STATISTICS FAILURE'); value = rangeResponses.get(range) ?? rows;
    } else throw Error('Unexpected URL');
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  } });
  const request = async (service, range) => {
    const store = { route: '/api/game-maps', incrementalCache, isDraftMode: false, isStaticGeneration: false };
    const result = await workAsyncStorage.run(store, () => workUnitAsyncStorage.run({ type: 'request', phase: 'render', url: { pathname: '/api/game-maps', search: '' } }, () => service.loadMapSnapshot(range)));
    await Promise.all(Object.values(store.pendingRevalidates ?? {}));
    return result;
  };
  return { worker, request, calls, failures, entries, rangeResponses, rangeQueries, advance: ms => { now += ms; }, rotation: value => { rotation = value; } };
}

test('real Next cache shares hourly success between workers, without nested five-minute provider refreshes', async () => {
  const h = harness(), firstWorker = h.worker();
  const result = await h.request(firstWorker);
  assert.equal(result.data.length, 1); // The other catalog map is not in the official rotation.
  assert.equal(result.data[0].statsStatus, 'available');
  assert.equal(result.data[0].sampleSize, 200);
  assert.equal(result.trophyRange, '1000');
  assert.equal(result.minTrophies, 1000);
  assert.equal(result.data[0].minTrophies, 1000);
  assert.equal(result.data[0].imageUrl, 'https://cdn.brawlify.com/maps/regular/15000007.png');
  assert.equal(result.stale, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|Authorization|expiresAt/);
  h.advance(301000);
  await h.request(firstWorker);
  await h.request(h.worker());
  assert.equal(h.calls.catalog, 1);
  assert.equal(h.calls.token, 1);
  assert.equal(h.calls.stats, 1);
  assert.equal(h.entries.size, 2);
  for (const entry of h.entries.values()) assert.equal(entry.value.revalidate, 3600);
});

test('concurrent trophy selections isolate cached samples, denominators and DTO labels while sharing artwork', async () => {
  const h = harness(), worker = h.worker();
  for (const [range, shelly, colt] of [['all', 400, 600], ['600', 150, 150], ['1000', 100, 400]]) {
    h.rangeResponses.set(range, { data: [
      { ...rows.data[0], 'map.picks_measure': String(shelly) },
      { ...rows.data[0], 'map.brawler_dimension': 'COLT', 'map.picks_measure': String(colt) },
    ] });
  }
  const results = await Promise.all(['all', '600', '1000'].map(range => h.request(worker, range)));
  assert.deepEqual(results.map(result => result.trophyRange), ['all', '600', '1000']);
  assert.deepEqual(results.map(result => result.minTrophies), [null, 600, 1000]);
  assert.deepEqual(results.map(result => result.data[0].minTrophies), [null, 600, 1000]);
  assert.deepEqual(results.map(result => result.data[0].sampleSize), [1000, 300, 500]);
  assert.deepEqual(results.map(result => result.data[0].brawlers[0].pickRate), [40, 50, 20]);
  assert.deepEqual(h.rangeQueries.slice().sort(), ['1000', '600', 'all']);
  assert.equal(h.calls.catalog, 1);
  assert.equal(h.calls.token, 1);
  assert.equal(h.calls.stats, 3);
  const anotherWorker = h.worker();
  await Promise.all(['all', '600', '1000'].map(range => h.request(anotherWorker, range)));
  assert.equal(h.calls.stats, 3);
  assert.equal(h.calls.catalog, 1);
});

test('empty or failed1000+ samples never fall back to a populated all-trophy cache', async () => {
  const h = harness(), worker = h.worker();
  await h.request(worker, 'all');
  h.rangeResponses.set('1000', { data: [] });
  const empty = await h.request(worker);
  assert.equal(empty.trophyRange, '1000');
  assert.equal(empty.data[0].minTrophies, 1000);
  assert.equal(empty.data[0].sampleSize, null);
  assert.equal(empty.data[0].brawlers.length, 0);
  h.failures.stats = true;
  const failed = await h.request(worker, '600');
  assert.equal(failed.trophyRange, '600');
  assert.equal(failed.data[0].statsStatus, 'unavailable');
  assert.equal(failed.data[0].minTrophies, 600);
  assert.equal(failed.data[0].sampleSize, null);
  assert.ok(failed.data[0].imageUrl);
});

test('real Next stale revalidation preserves success and original observation time after provider failures', async t => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.map(String).join(' ')));
  const h = harness(), worker = h.worker();
  const original = await h.request(worker);
  h.advance(3_601_000);
  h.failures.catalog = h.failures.stats = true;
  const stale = await h.request(worker);
  assert.equal(stale.stale, true);
  assert.equal(stale.data[0].statsStatus, 'stale');
  assert.equal(stale.data[0].sampleSize, original.data[0].sampleSize);
  assert.equal(stale.data[0].statsFetchedAt, original.data[0].statsFetchedAt);
  assert.equal(stale.data[0].statsUpdatedAt, original.data[0].statsUpdatedAt);
  assert.equal(stale.data[0].imageUrl, original.data[0].imageUrl);
  assert.equal(h.calls.catalog, 2);
  assert.equal(h.calls.stats, 2);
  await h.request(worker);
  assert.equal(h.calls.catalog, 2); // Failed refresh is cooled down in this worker.
  assert.equal(h.calls.stats, 2);
  assert.doesNotMatch(errors.join(' '), /TEST_ANONYMOUS_SECRET|SECRET STATISTICS|SECRET CATALOG/);
  h.advance(301000);
  h.failures.catalog = h.failures.stats = false;
  await h.request(worker); // Stale response while Next performs background refresh.
  const refreshed = await h.request(worker);
  assert.equal(refreshed.stale, false);
  assert.equal(refreshed.data[0].statsStatus, 'available');
  assert.notEqual(refreshed.data[0].statsFetchedAt, original.data[0].statsFetchedAt);
});

test('cold statistics failures preserve artwork, stay unavailable and retry after bounded worker cooldown', async () => {
  const h = harness(), worker = h.worker();
  h.failures.stats = true;
  const failed = await h.request(worker);
  assert.equal(failed.data[0].statsStatus, 'unavailable');
  assert.equal(failed.data[0].sampleSize, null);
  assert.equal(failed.data[0].statsFetchedAt, null);
  assert.ok(failed.data[0].imageUrl);
  assert.equal(failed.stale, true);
  await h.request(worker);
  assert.equal(h.calls.catalog, 1);
  assert.equal(h.calls.stats, 1);
  h.advance(301000); h.failures.stats = false;
  assert.equal((await h.request(worker)).data[0].statsStatus, 'available');
  assert.equal(h.calls.stats, 2);
  assert.equal(h.calls.catalog, 1);
});

test('concurrent readers coalesce within a worker and absent official rotation cannot create replacement events', async () => {
  const h = harness(), worker = h.worker();
  const results = await Promise.all([h.request(worker), h.request(worker), h.request(worker)]);
  assert.ok(results.every(result => result.data.length === 1));
  assert.equal(h.calls.catalog, 1); assert.equal(h.calls.stats, 1); assert.equal(h.calls.events, 1);
  h.rotation({ data: null, fetchedAt: null, stale: true, refreshing: false });
  const absent = await h.request(worker);
  assert.equal(absent.data, null);
  assert.equal(absent.stale, true);
  assert.equal(h.calls.stats, 1);
  h.rotation({ data: [], fetchedAt: null, stale: false, refreshing: false });
  assert.equal((await h.request(worker)).data.length, 0);
  assert.equal(h.calls.stats, 1);
});

test('map endpoint accepts only finite trophy ranges and rejects duplicate/arbitrary filters before load', async () => {
  let reads = 0; const ranges = [];
  const api = loadTypeScript('src/app/api/game-maps/route.ts', {
    'next/server': { NextResponse: { json: (value, options) => new Response(JSON.stringify(value), options) } },
    '@/lib/map-cache': { loadMapSnapshot: async range => { reads++; ranges.push(range); return { data: [], trophyRange: range, stale: false }; } },
  });
  for (const query of ['?url=https://attacker.invalid', '?map=15000007', '?force=1', '?trophies=', '?trophies=100', '?trophies=1000&trophies=all', '?trophies=all&url=anything']) {
    const response = await api.GET(new Request(`https://app.test/api/game-maps${query}`));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(reads, 0);
  const ok = await api.GET(new Request('https://app.test/api/game-maps'));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('cache-control'), /s-maxage=60/);
  assert.equal(reads, 1);
  for (const range of ['all', '600', '1000']) {
    const response = await api.GET(new Request(`https://app.test/api/game-maps?trophies=${range}`));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).trophyRange, range);
  }
  assert.deepEqual(ranges, ['1000', 'all', '600', '1000']);
});

test('endpoint hides raw provider failures and bounds client retries', async () => {
  const api = loadTypeScript('src/app/api/game-maps/route.ts', {
    'next/server': { NextResponse: { json: (value, options) => new Response(JSON.stringify(value), options) } },
    '@/lib/map-cache': { loadMapSnapshot: async () => { throw Error('PRIVATE_AUTH_TOKEN'); } },
  });
  const response = await api.GET(new Request('https://app.test/api/game-maps'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '300');
  assert.doesNotMatch(await response.text(), /PRIVATE_AUTH_TOKEN/);
});
