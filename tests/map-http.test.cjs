const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');

test('map HTTP requests use fixed provider hosts without redirects, cookies or game credentials', async () => {
  const calls = [];
  const http = loadTypeScript('src/lib/map-http.ts', {}, { fetch: async (url, options) => {
    calls.push({ url, options });
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  } });
  const signal = new AbortController().signal;
  await http.mapProviderJson('catalog', signal);
  await http.mapProviderJson('token', signal);
  await http.mapProviderJson('stats', signal, '{"filters":[]}', 'ANONYMOUS_TEST');
  assert.equal(calls[0].url, 'https://api.brawlapi.com/v1/maps');
  assert.equal(calls[1].url, 'https://brawltime.ninja/api/auth.getToken');
  assert.equal(calls[1].options.body, '{"json":null}');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(new URL(calls[2].url).origin, 'https://cube.brawltime.ninja');
  assert.equal(new URL(calls[2].url).searchParams.get('query'), '{"filters":[]}');
  assert.equal(calls[2].options.headers.Authorization, 'ANONYMOUS_TEST');
  for (const { options } of calls) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Cookie, undefined);
  }
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  await assert.rejects(http.mapProviderJson('stats', signal, 'x'.repeat(30001), 'ANONYMOUS_TEST'));
  assert.equal(calls.length, 3);
});

test('provider rate limits, non-JSON and oversized content are rejected without echoing response bodies', async () => {
  for (const response of [
    new Response('PRIVATE_UPSTREAM_ERROR', { status: 429, headers: { 'Retry-After': '120', 'Content-Type': 'application/json' } }),
    new Response('<html>PRIVATE_UPSTREAM_ERROR</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '9000000' } }),
    new Response('x'.repeat(65537), { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const http = loadTypeScript('src/lib/map-http.ts', {}, { fetch: async () => response });
    await assert.rejects(http.mapProviderJson('token', new AbortController().signal), error => !String(error).includes('PRIVATE_UPSTREAM_ERROR'));
  }
});

test('provider work has a hard deadline even if the underlying client ignores AbortSignal', async () => {
  const http = loadTypeScript('src/lib/map-http.ts');
  let signal;
  await assert.rejects(http.boundedMapWork(value => { signal = value; return new Promise(() => {}); }, 10), error => error.reason === 'timeout');
  assert.equal(signal.aborted, true);
  assert.equal(await http.boundedMapWork(async () => 42, 1000), 42);
});

test('long Cube queries use its verified JSON POST envelope rather than a long GET URL', async () => {
  const query = { dimensions: ['map.brawler_dimension'], filters: [{ member: 'map.map_dimension', operator: 'equals', values: ['x'.repeat(2200)] }] };
  let captured;
  const http = loadTypeScript('src/lib/map-http.ts', {}, { fetch: async (url, options) => {
    captured = { url, options }; return new Response('{"data":[]}', { headers: { 'Content-Type': 'application/json' } });
  } });
  await http.mapStatisticsJson(new AbortController().signal, JSON.stringify(query), 'ANONYMOUS_TEST');
  assert.equal(captured.url, 'https://cube.brawltime.ninja/cubejs-api/v1/load');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(captured.options.body), { query });
  assert.equal(captured.options.redirect, 'error');
});

test('Cube Continue wait responses retry with bounded backoff and return the eventual data', async () => {
  let calls = 0; const delays = [];
  const http = loadTypeScript('src/lib/map-http.ts', {}, {
    setTimeout: (callback, delay) => { delays.push(delay); return setTimeout(callback, 0); },
    fetch: async () => new Response(JSON.stringify(++calls < 3 ? { error: 'Continue wait' } : { data: [{ value: 1 }] }), { headers: { 'Content-Type': 'application/json' } }),
  });
  const value = await http.mapStatisticsJson(new AbortController().signal, '{}', 'ANONYMOUS_TEST');
  assert.equal(value.data[0].value, 1);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]);
});

test('persistent Cube pending responses stop after four calls without echoing query or token', async () => {
  let calls = 0; const delays = [];
  const http = loadTypeScript('src/lib/map-http.ts', {}, {
    setTimeout: (callback, delay) => { delays.push(delay); return setTimeout(callback, 0); },
    fetch: async () => { calls++; return new Response('{"error":"Continue wait"}', { headers: { 'Content-Type': 'application/json' } }); },
  });
  await assert.rejects(http.mapStatisticsJson(new AbortController().signal, '{"private":"QUERY_TEST"}', 'ANONYMOUS_TEST'), error => {
    assert.equal(error.stage, 'stats'); assert.equal(error.reason, 'pending');
    assert.doesNotMatch(String(error), /QUERY_TEST|ANONYMOUS_TEST/); return true;
  });
  assert.equal(calls, 4);
  assert.deepEqual(delays, [500, 1000, 2000]);
});

test('only the exact Cube pending response retries, and HTTP rate limits retain a sanitized status', async () => {
  let calls = 0;
  const http = loadTypeScript('src/lib/map-http.ts', {}, { fetch: async () => {
    calls++; return new Response('{"error":"PRIVATE_RATE_LIMIT"}', { status: 429, headers: { 'Content-Type': 'application/json' } });
  } });
  await assert.rejects(http.mapStatisticsJson(new AbortController().signal, '{}', 'ANONYMOUS_TEST'), error => error.stage === 'stats' && error.reason === 'http' && error.status === 429 && !String(error).includes('PRIVATE_RATE_LIMIT'));
  assert.equal(calls, 1);
  const other = loadTypeScript('src/lib/map-http.ts', {}, { fetch: async () => { calls++; return new Response('{"error":"Other error"}', { headers: { 'Content-Type': 'application/json' } }); } });
  assert.equal((await other.mapStatisticsJson(new AbortController().signal, '{}', 'ANONYMOUS_TEST')).error, 'Other error');
  assert.equal(calls, 2);
});

test('the existing total deadline aborts a Cube wait before another request starts', async () => {
  let calls = 0;
  const http = loadTypeScript('src/lib/map-http.ts', {}, { fetch: async () => { calls++; return new Response('{"error":"Continue wait"}', { headers: { 'Content-Type': 'application/json' } }); } });
  await assert.rejects(http.boundedMapWork(signal => http.mapStatisticsJson(signal, '{}', 'ANONYMOUS_TEST'), 10), error => error.reason === 'timeout');
  assert.equal(calls, 1);
});
