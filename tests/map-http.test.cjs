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
  await assert.rejects(http.boundedMapWork(value => { signal = value; return new Promise(() => {}); }, 10), /temporarily unavailable/);
  assert.equal(signal.aborted, true);
  assert.equal(await http.boundedMapWork(async () => 42, 1000), 42);
});
