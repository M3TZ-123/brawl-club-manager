const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

const epoch = Date.parse("2026-09-16T12:00:00Z");

function fakeClock() {
  let now = epoch, nextId = 0;
  const timers = new Map();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const math = Object.create(Math);
  math.random = () => 0.5;
  async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
  return {
    now: () => now,
    pending: () => timers.size,
    flush,
    globals: {
      Date: ClockDate, Math: math,
      setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
      clearTimeout: (id) => timers.delete(id),
    },
    async advance(ms) {
      const target = now + ms;
      await flush();
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= target);
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn(); await flush();
      }
      now = target; await flush();
    },
  };
}

function helper(clock = fakeClock()) {
  return { clock, api: loadTypeScript("src/lib/upstream-rate-limit.ts", {}, clock.globals) };
}

function limited(retryAfter, status = 429) {
  return { isAxiosError: true, response: { status, headers: { "Retry-After": retryAfter }, data: { reason: "SECRET_BODY" } }, config: { headers: { Authorization: "SECRET_KEY" } } };
}

function brawlFixture({ brawl = async () => ({ data: {} }), ranked = async () => ({ data: {} }) } = {}) {
  const clock = fakeClock();
  const logs = [];
  const api = loadTypeScript("src/lib/brawl-api.ts", {
    axios: { create: () => ({ get: brawl }), get: ranked, isAxiosError: (error) => error?.isAxiosError === true },
    "./utils": { encodeTag: encodeURIComponent },
  }, { ...clock.globals, console: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args), log: (...args) => logs.push(args) } });
  return { api, clock, logs };
}

test("Retry-After parses seconds and HTTP dates without mistaking invalid numbers for dates", () => {
  const { api } = helper();
  assert.equal(api.parseRetryAfterMs("120", epoch), 120000);
  assert.equal(api.parseRetryAfterMs(" 0.125 ", epoch), 125);
  assert.equal(api.parseRetryAfterMs(0, epoch), 0);
  assert.equal(api.parseRetryAfterMs("Wed, 16 Sep 2026 12:00:07 GMT", epoch), 7000);
  assert.equal(api.parseRetryAfterMs("Wed, 16 Sep 2026 11:59:00 GMT", epoch), 0);
  for (const invalid of [undefined, null, "", "-1", "NaN", "Infinity", "invalid", [], {}]) {
    assert.equal(api.parseRetryAfterMs(invalid, epoch), null);
  }
});

test("429 retries use exponential backoff plus positive jitter and a bounded attempt count", async () => {
  const { api, clock } = helper();
  const calledAt = [];
  const request = api.callWithUpstreamRetry(async () => { calledAt.push(clock.now() - epoch); throw limited(undefined); }, { provider: "brawl" });
  const rejection = assert.rejects(request, (error) => error instanceof api.UpstreamRateLimitError && error.status === 429 && error.retryAfterMs === 4500);
  await clock.flush();
  await clock.advance(1124); assert.deepEqual(calledAt, [0]);
  await clock.advance(1); assert.deepEqual(calledAt, [0, 1125]);
  await clock.advance(2249); assert.equal(calledAt.length, 2);
  await clock.advance(1); await rejection;
  assert.deepEqual(calledAt, [0, 1125, 3375]);
  assert.equal(clock.pending(), 0);
});

test("Retry-After is a lower bound even when its HTTP-date exceeds exponential backoff", async () => {
  const { api, clock } = helper(); let calls = 0;
  const request = api.callWithUpstreamRetry(async () => {
    calls++;
    if (calls === 1) throw { response: { status: 429, headers: new Headers({ "retry-after": "Wed, 16 Sep 2026 12:00:05 GMT" }) } };
    return "ok";
  }, { provider: "brawl" });
  await clock.advance(4999); assert.equal(calls, 1);
  await clock.advance(1); assert.equal(await request, "ok"); assert.equal(calls, 2);
});

test("a long cooldown fails promptly and prevents subsequent calls without consuming their request budget", async () => {
  const { api, clock } = helper(); let calls = 0;
  const fetch = async () => { calls++; throw limited("120"); };
  await assert.rejects(api.callWithUpstreamRetry(fetch, { provider: "brawl", deadlineAt: epoch + 45000 }), (error) => error.retryAfterMs === 120000 && error.provider === "brawl");
  await assert.rejects(api.callWithUpstreamRetry(fetch, { provider: "brawl", deadlineAt: epoch + 45000 }), (error) => error.retryAfterMs === 120000);
  assert.equal(calls, 1); assert.equal(clock.pending(), 0); assert.equal(clock.now(), epoch);
  await clock.advance(119999);
  const resumed = api.callWithUpstreamRetry(async () => { calls++; return "ready"; }, { provider: "brawl" });
  await clock.flush(); assert.equal(calls, 1);
  await clock.advance(1); assert.equal(await resumed, "ready"); assert.equal(calls, 2);
});

test("all concurrent calls honor a provider cooldown while the other provider remains available", async () => {
  const { api, clock } = helper(); let firstCalls = 0, secondCalls = 0, rankedCalls = 0;
  const first = api.callWithUpstreamRetry(async () => { if (++firstCalls === 1) throw limited("3"); return "first"; }, { provider: "brawl" });
  await clock.flush();
  const second = api.callWithUpstreamRetry(async () => { secondCalls++; return "second"; }, { provider: "brawl" });
  assert.equal(await api.callWithUpstreamRetry(async () => { rankedCalls++; return "ranked"; }, { provider: "rnt" }), "ranked");
  await clock.advance(2999); assert.equal(firstCalls, 1); assert.equal(secondCalls, 0); assert.equal(rankedCalls, 1);
  await clock.advance(1); assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
});

test("a later in-flight 429 extends existing sleepers and concurrent success cannot clear that cooldown", async () => {
  const { api, clock } = helper(); let rejectLater, succeedLater, slowCalls = 0, firstCalls = 0;
  const slow = api.callWithUpstreamRetry(async () => {
    if (++slowCalls === 1) return new Promise((_, reject) => { rejectLater = reject; });
    return "slow";
  }, { provider: "brawl" });
  const successfulInFlight = api.callWithUpstreamRetry(() => new Promise((resolve) => { succeedLater = resolve; }), { provider: "brawl" });
  const first = api.callWithUpstreamRetry(async () => { if (++firstCalls === 1) throw limited("2"); return "first"; }, { provider: "brawl" });
  await clock.advance(1000);
  rejectLater(limited("5")); succeedLater("already in flight"); await clock.flush();
  assert.equal(await successfulInFlight, "already in flight");
  assert.equal(api.getUpstreamCooldownMs("brawl"), 5000);
  await clock.advance(1000); assert.equal(firstCalls, 1); assert.equal(slowCalls, 1);
  await clock.advance(3999); assert.equal(firstCalls, 1);
  await clock.advance(1); assert.deepEqual(await Promise.all([first, slow]), ["first", "slow"]);
});

test("abort cancels a cooldown sleep, clears its timer and retains the cooldown for durable persistence", async () => {
  const { api, clock } = helper(); const controller = new AbortController(); let calls = 0;
  const request = api.callWithUpstreamRetry(async () => { calls++; throw limited("3"); }, { provider: "brawl", signal: controller.signal });
  const rejection = assert.rejects(request, (error) => error.name === "AbortError");
  await clock.flush(); assert.equal(clock.pending(), 1);
  controller.abort(new Error("SECRET_REASON")); await rejection;
  assert.equal(clock.pending(), 0); assert.equal(api.getUpstreamCooldownMs("brawl"), 3000);
  await clock.advance(5000); assert.equal(calls, 1);
});

test("already-aborted and expired calls never start HTTP work", async () => {
  const { api, clock } = helper(); let calls = 0; const controller = new AbortController(); controller.abort();
  const fetch = async () => { calls++; };
  await assert.rejects(api.callWithUpstreamRetry(fetch, { provider: "brawl", signal: controller.signal }), (error) => error.name === "AbortError");
  await assert.rejects(api.callWithUpstreamRetry(fetch, { provider: "brawl", deadlineAt: epoch }), (error) => error.name === "TimeoutError");
  assert.equal(calls, 0); assert.equal(clock.pending(), 0);
});

test("request timeouts shrink to the remaining deadline and transient retries stay bounded", async () => {
  const { api, clock } = helper(); const timeouts = [];
  const request = api.callWithUpstreamRetry(async (timeout) => { timeouts.push(timeout); if (timeouts.length === 1) throw limited(undefined, 503); return "ok"; }, {
    provider: "rnt", deadlineAt: epoch + 2000, requestTimeoutMs: 4000, maxAttempts: 2, retryTransient: true,
  });
  await clock.advance(1125); assert.equal(await request, "ok"); assert.deepEqual(timeouts, [2000, 875]);
  assert.equal(api.getUpstreamCooldownMs("rnt"), 0);
  let calls = 0;
  await assert.rejects(api.callWithUpstreamRetry(async () => { calls++; throw limited(undefined, 404); }, { provider: "rnt", retryTransient: true }), (error) => error.response.status === 404);
  assert.equal(calls, 1);
});

test("abort also interrupts transient-error backoff without another network request", async () => {
  const { api, clock } = helper(); const controller = new AbortController(); let calls = 0;
  const request = api.callWithUpstreamRetry(async () => { calls++; throw limited(undefined, 503); }, { provider: "rnt", signal: controller.signal, retryTransient: true });
  const rejection = assert.rejects(request, (error) => error.name === "AbortError");
  await clock.flush(); controller.abort(); await rejection;
  assert.equal(clock.pending(), 0); assert.equal(calls, 1);
});

test("Brawl API exposes sanitized typed cooldowns, preserving status, provider and caller deadline", async () => {
  let calls = 0, timeout;
  const { api, logs } = brawlFixture({ brawl: async (_url, options) => { calls++; timeout = options.timeout; throw limited("60"); } });
  await assert.rejects(api.getClub("#CLUB", "SECRET_KEY", undefined, epoch + 5000), (error) => {
    assert.ok(error instanceof api.BrawlApiError); assert.equal(error.status, 429); assert.equal(error.provider, "brawl"); assert.equal(error.retryAfterMs, 60000);
    assert.ok(!JSON.stringify(error).includes("SECRET")); assert.ok(!error.message.includes("SECRET")); return true;
  });
  await assert.rejects(api.getPlayerBattleLog("#PLAYER", "SECRET_KEY", undefined, epoch + 5000), (error) => error.status === 429);
  assert.equal(timeout, 5000); assert.equal(calls, 1); assert.deepEqual(logs, []);
});

test("HTTP authentication errors never expose response bodies, request tokens or raw Axios messages", async () => {
  const { api, logs } = brawlFixture({ brawl: async () => { throw { ...limited(undefined, 403), message: "SECRET_ERROR_MESSAGE" }; } });
  await assert.rejects(api.getPlayer("#PLAYER", "SECRET_KEY"), (error) => {
    assert.equal(error.status, 403); assert.equal(error.reason, "accessDenied"); assert.match(error.message, /45\.79\.218\.79/);
    assert.ok(!JSON.stringify(error).includes("SECRET")); assert.ok(!error.message.includes("SECRET")); return true;
  });
  assert.deepEqual(logs, []);
});

test("ranked 429 returns unavailable with cooldown and subsequent calls do not hit RNT", async () => {
  let calls = 0;
  const { api, logs } = brawlFixture({ ranked: async () => { calls++; throw limited("120"); } });
  const first = await api.getPlayerRankedData("#PLAYER", { deadlineAt: epoch + 8000 });
  const second = await api.getPlayerRankedData("#OTHER", { deadlineAt: epoch + 8000 });
  assert.equal(first.available, false); assert.equal(first.retryAfterMs, 120000); assert.equal(second.retryAfterMs, 120000); assert.equal(calls, 1); assert.deepEqual(logs, []);
  assert.deepEqual(JSON.parse(JSON.stringify(await api.getClub("#CLUB"))), {});
});

test("ranked success distinguishes explicit zero points from missing or invalid stats", async () => {
  const responses = [
    { ok: true, result: { stats: [{ id: 24, value: 0 }, { id: 25, value: 1500 }] } },
    { ok: true, result: { stats: [] } },
    { ok: true, result: { stats: [{ id: 24, value: "0" }, { id: 25, value: 1500 }] } },
    { ok: true, result: { stats: [{ id: 24, value: NaN }, { id: 25, value: 1500 }] } },
    { ok: true, result: { stats: [{ id: 24, value: -1 }, { id: 25, value: 1500 }] } },
    { ok: true, result: { stats: [{ id: 24, value: 1500 }, { id: 25, value: -1 }] } },
    { ok: false, result: { stats: [{ id: 24, value: 0 }, { id: 25, value: 0 }] } },
  ];
  const { api } = brawlFixture({ ranked: async () => ({ data: responses.shift() }) });
  const valid = await api.getPlayerRankedData("#PLAYER");
  assert.equal(valid.available, true); assert.equal(valid.currentRank, "Bronze I"); assert.equal(valid.highestRank, "Gold I"); assert.equal(valid.currentPoints, 0);
  for (let i = 0; i < 6; i++) assert.equal((await api.getPlayerRankedData("#PLAYER")).available, false);
});

test("ranked transient failures retry once and aborted work remains unavailable", async () => {
  let calls = 0;
  const { api, clock, logs } = brawlFixture({ ranked: async () => { calls++; throw limited(undefined, 503); } });
  const request = api.getPlayerRankedData("#PLAYER");
  await clock.advance(1125); assert.equal((await request).available, false); assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort();
  assert.equal((await api.getPlayerRankedData("#PLAYER", { signal: controller.signal })).available, false);
  assert.equal(calls, 2); assert.equal(clock.pending(), 0); assert.deepEqual(logs, []);
});
