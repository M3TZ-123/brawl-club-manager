const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

function fixture() {
  const pending = [];
  const cache = loadTypeScript("src/lib/client-data-cache.ts", {}, {
    fetch: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  });
  return { ...cache, pending };
}

test("a slow old request cannot replace a newer forced response", async () => {
  const cache = fixture();
  const oldRequest = cache.fetchJsonCached("/api/battles/feed");
  const freshRequest = cache.fetchJsonCached("/api/battles/feed", { force: true });
  cache.pending[1].resolve(Response.json({ version: 2 }));
  assert.equal((await freshRequest).version, 2);
  cache.pending[0].resolve(Response.json({ version: 1 }));
  await oldRequest;
  assert.equal((await cache.fetchJsonCached("/api/battles/feed")).version, 2);
  assert.equal(cache.pending.length, 2);
});

test("an old request failure cannot evict fresh cached data", async () => {
  const cache = fixture();
  const oldRequest = cache.fetchJsonCached("/api/battles/feed");
  const freshRequest = cache.fetchJsonCached("/api/battles/feed", { force: true });
  cache.pending[1].resolve(Response.json({ version: 2 }));
  await freshRequest;
  cache.pending[0].reject(new Error("Old request failed"));
  await assert.rejects(oldRequest, /Old request failed/);
  assert.equal((await cache.fetchJsonCached("/api/battles/feed")).version, 2);
});

test("invalidation prevents an in-flight response from repopulating stale cache", async () => {
  const cache = fixture();
  const oldRequest = cache.fetchJsonCached("/api/members");
  cache.invalidateJsonCache("/api/members");
  cache.pending[0].resolve(Response.json({ version: 1 }));
  await oldRequest;
  const freshRequest = cache.fetchJsonCached("/api/members");
  assert.equal(cache.pending.length, 2);
  cache.pending[1].resolve(Response.json({ version: 2 }));
  assert.equal((await freshRequest).version, 2);
});
