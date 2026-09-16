const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(globals = {}) {
  const pending = [];
  const cache = loadTypeScript("src/lib/client-data-cache.ts", {}, {
    fetch: (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve, reject })), ...globals,
  });
  return { ...cache, pending };
}

test("normal concurrent reads share a request and force bursts queue only one fresh read", async () => {
  const cache = fixture();
  const oldRequest = cache.fetchJsonCached("/api/battles/feed");
  const joined = cache.fetchJsonCached("/api/battles/feed");
  const forced = Array.from({ length: 20 }, () => cache.fetchJsonCached("/api/battles/feed", { force: true }));
  assert.equal(cache.pending.length, 1, "Forced reads must not overlap the current request");
  assert.equal(oldRequest, joined); assert.ok(forced.every(request => request === oldRequest));
  cache.pending[0].resolve(Response.json({ version: 1 })); await settle();
  assert.equal(cache.pending.length, 2); assert.equal(cache.pending[1].options.cache, "no-store");
  cache.pending[1].resolve(Response.json({ version: 2 }));
  assert.equal((await oldRequest).version, 2, "An earlier waiter also receives the response after the change signal");
  assert.equal((await cache.fetchJsonCached("/api/battles/feed")).version, 2);
  assert.equal(cache.pending.length, 2);
});

test("a failed superseded read cannot evict the successful queued response", async () => {
  const cache = fixture();
  const oldRequest = cache.fetchJsonCached("/api/battles/feed");
  const freshRequest = cache.fetchJsonCached("/api/battles/feed", { force: true });
  cache.pending[0].reject(new Error("Old request failed")); await settle();
  assert.equal(cache.pending.length, 2);
  cache.pending[1].resolve(Response.json({ version: 2 }));
  assert.equal((await oldRequest).version, 2); assert.equal((await freshRequest).version, 2);
  assert.equal((await cache.fetchJsonCached("/api/battles/feed")).version, 2);
});

test("invalidation refreshes an in-flight read before accepting it and preserves external catalog cache", async () => {
  const cache = fixture();
  const external = cache.fetchJsonCached("https://catalog.example/brawlers");
  cache.pending[0].resolve(Response.json({ static: true })); await external;
  const oldRequest = cache.fetchJsonCached("/api/members");
  cache.invalidateJsonCache();
  cache.pending[1].resolve(Response.json({ version: 1 })); await settle();
  assert.equal(cache.pending.length, 3);
  cache.pending[2].resolve(Response.json({ version: 2 }));
  assert.equal((await oldRequest).version, 2);
  assert.equal((await cache.fetchJsonCached("https://catalog.example/brawlers")).static, true);
  assert.equal(cache.pending.length, 3, "Club invalidation must not download static catalogs again");
});

test("auth invalidation aborts old requests even if fetch ignores abort and cannot repopulate private cache", async () => {
  const cache = fixture();
  const oldRequest = cache.fetchJsonCached("/api/member-reviews");
  const rejected = assert.rejects(oldRequest, error => error.name === "AbortError");
  cache.invalidateJsonCache("/api/", { cancelPending: true });
  assert.equal(cache.pending[0].options.signal.aborted, true); await rejected;
  const freshRequest = cache.fetchJsonCached("/api/member-reviews");
  cache.pending[1].resolve(Response.json({ reviews: [] })); await freshRequest;
  cache.pending[0].resolve(Response.json({ reviews: [{ notes: "private old session" }] })); await settle();
  assert.equal((await cache.fetchJsonCached("/api/member-reviews")).reviews.length, 0);
  assert.equal(cache.pending.length, 2);
});

test("a frozen network or frozen JSON body expires, aborts, and leaves the cache retryable", async () => {
  for (const frozenBody of [false, true]) {
    const timers = new Map(); let id = 0;
    const cache = fixture({ setTimeout: (callback, ms) => { assert.equal(ms, 25); timers.set(++id, callback); return id; }, clearTimeout: timer => timers.delete(timer) });
    const read = cache.fetchJsonCached("/api/members", { timeoutMs: 25 });
    const rejected = assert.rejects(read, error => error.name === "TimeoutError");
    if (frozenBody) { cache.pending[0].resolve({ ok: true, json: () => new Promise(() => {}) }); await settle(); }
    timers.values().next().value(); await rejected;
    assert.equal(cache.pending[0].options.signal.aborted, true); assert.equal(timers.size, 0);
    const retry = cache.fetchJsonCached("/api/members", { timeoutMs: 25 });
    cache.pending[1].resolve(Response.json({ recovered: true }));
    assert.equal((await retry).recovered, true); assert.equal(timers.size, 0);
  }
});
