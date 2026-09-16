const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const tags = Array.from({ length: 30 }, (_, i) => `#P${String(i).padStart(2, '0')}`);
const unavailable = { available: false, currentRank: 'Unranked', highestRank: 'Unranked', currentPoints: 0, highestPoints: 0 };
const available = { available: true, currentRank: 'Gold I', highestRank: 'Gold I', currentPoints: 1500, highestPoints: 1500 };
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  let now = Date.now(), cooldownUntil = 0;
  const attempts = new Map(), calls = [], network = [], pending = [], timers = [], profiles = [];
  class ClockDate extends Date { static now() { return now; } }
  const abortable = signal => new Promise((_, reject) => {
    const aborted = () => reject(new Error('Aborted test-only database read'));
    if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
  });
  const db = {
    from(table) {
      const query = {
        select() { return query; }, eq() { return query; },
        in() {
          if (table === 'settings') return Promise.resolve({ data: [{ key: 'club_tag', value: '#CLUB' }, { key: 'api_key', value: 'test-only' }] });
          assert.equal(table, 'sync_ranked_fallback_attempts');
          return { abortSignal: async signal => {
            calls.push({ name: 'queue', signal });
            if (options.queueStalled) return abortable(signal);
            return { data: options.staleQueue ? [] : [...attempts].map(([player_tag, at]) => ({ player_tag, attempted_at: new Date(at).toISOString() })), error: options.queueError ? { code: 'test-only' } : null };
          } };
        },
      };
      return query;
    },
    rpc(name, args) {
      calls.push({ name, args });
      if (name === 'acquire_sync_run') return { data: { acquired: true, run_id: 'test-run', fence: 1 } };
      if (name === 'begin_sync_ranked_fallback') return { abortSignal: async signal => {
        assert.equal(args.p_player_tags.length, 1, 'Only the next worker request may be reserved');
        if (options.gateStalled) return abortable(signal);
        if (options.gateError) return { data: null, error: { code: 'test-only' } };
        const tag = args.p_player_tags[0];
        if (attempts.has(tag) && now - attempts.get(tag) < 29 * 60000) return { data: [] };
        attempts.set(tag, now); return { data: [tag] };
      } };
      if (name === 'commit_sync_snapshot') return { data: { success: true, warnings: args.p_payload.warnings } };
      if (name === 'fail_sync_run' || name === 'defer_sync_upstream') return { data: true };
      throw new Error(name);
    },
  };
  const api = {
    getClub: async () => ({ members: tags.map(tag => ({ tag, name: tag, role: 'member' })) }),
    getPlayer: async tag => {
      profiles.push(tag);
      return { tag, name: tag, trophies: 100, highestTrophies: 100, expLevel: 1, soloVictories: 0, duoVictories: 0, '3vs3Victories': 0, brawlers: [], ...options.profile };
    },
    getPlayerBattleLog: async () => ({ items: [] }), processBattleLog: () => [], calculateWinRateFromBattleLog: () => ({ winRate: null }),
    getPlayerRankedData: async tag => {
      network.push(tag);
      if (options.providerCooldown) { cooldownUntil = now + 120000; return { ...unavailable, retryAfterMs: 120000 }; }
      if (options.slowRanks) return new Promise(resolve => pending.push(resolve));
      return available;
    },
  };
  const service = loadTypeScript('src/lib/sync-service.ts', {
    '@/lib/supabase-admin': { supabaseAdmin: db }, '@/lib/brawl-api': api,
    '@/lib/upstream-rate-limit': { getUpstreamCooldownMs: provider => provider === 'rnt' ? Math.max(0, cooldownUntil - now) : 0 },
  }, {
    Date: ClockDate, setTimeout: fn => { fn(); return 0; }, console: { error() {} },
    AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout(ms) { const controller = new AbortController(); timers.push({ ms, controller }); return controller.signal; } },
  });
  return { service, attempts, calls, network, pending, profiles, options,
    now: () => now, advance(ms) { now += ms; },
    abortFallback() { now += 8001; for (const timer of timers) if (timer.ms <= 8000) timer.controller.abort(); },
  };
}

test('eight slow30-player runs visit every player without reserving the unstarted queue', async () => {
  const f = fixture({ slowRanks: true });
  for (let run = 0; run < 8; run++) {
    const work = f.service.executeSync({ source: 'cron' }); await settle();
    assert.equal(f.pending.length, 4, 'The fallback pool remains bounded to four requests');
    assert.equal(f.attempts.size, Math.min((run + 1) * 4, 30));
    f.abortFallback(); for (const resolve of f.pending.splice(0)) resolve(unavailable);
    await work;
    const commit = f.calls.filter(call => call.name === 'commit_sync_snapshot').at(-1);
    assert.equal(commit.args.p_payload.ranked_complete, false);
    // Run again after the normal full cadence. Old first players will become
    // eligible before everyone was visited; they must not jump the queue.
    f.advance(10 * 60000);
  }
  assert.deepEqual(f.network.slice(0, 30), tags);
  assert.equal(new Set(f.network).size, 30);
  assert.equal(f.calls.filter(call => call.name === 'begin_sync_ranked_fallback').length, 32);
});

test('stale queue ordering still skips player cooldowns and reaches eligible players', async () => {
  const f = fixture({ staleQueue: true });
  tags.slice(0, 4).forEach(tag => f.attempts.set(tag, f.now()));
  await f.service.executeSync({ source: 'cron' });
  assert.deepEqual(f.network, tags.slice(4));
  assert.equal(f.calls.filter(call => call.name === 'begin_sync_ranked_fallback').length, 30);
});

test('queue or gate database errors preserve the primary snapshot without any RNT request', async () => {
  for (const options of [{ queueError: true }, { gateError: true }]) {
    const f = fixture(options); const result = await f.service.executeSync({ source: 'cron' });
    assert.equal(result.success, true); assert.deepEqual(f.network, []); assert.equal(f.attempts.size, 0);
    assert.ok(result.warnings.includes('ranked_unavailable'));
    const body = f.calls.find(call => call.name === 'commit_sync_snapshot').args.p_payload;
    assert.equal(body.ranked_complete, false); assert.equal(body.ranked_attempted, false);
    assert.ok(f.calls.filter(call => call.name === 'begin_sync_ranked_fallback').length <= 4);
  }
});

test('stalled queue and reservation calls abort within the shared fallback budget', { timeout: 2000 }, async () => {
  for (const options of [{ queueStalled: true }, { gateStalled: true }]) {
    const f = fixture(options); const work = f.service.executeSync({ source: 'cron' }); await settle();
    assert.equal(f.calls.some(call => call.name === 'commit_sync_snapshot'), false);
    f.abortFallback(); const result = await work;
    assert.equal(result.success, true); assert.deepEqual(f.network, []); assert.equal(f.attempts.size, 0);
    assert.ok(result.warnings.includes('ranked_unavailable'));
  }
});

test('a provider cooldown stops further queue reservations', async () => {
  const f = fixture({ providerCooldown: true }); await f.service.executeSync({ source: 'cron' });
  assert.equal(f.network.length, 4); assert.equal(f.attempts.size, 4);
  assert.equal(f.calls.filter(call => call.name === 'begin_sync_ranked_fallback').length, 4);
  assert.ok(f.calls.some(call => call.name === 'defer_sync_upstream' && call.args.p_provider === 'rnt'));
});

test('missing or invalid mandatory account counters fail before fallback or persistence', async () => {
  const options = {}; const f = fixture(options);
  for (const field of ['trophies', 'highestTrophies', 'expLevel', 'soloVictories', 'duoVictories', '3vs3Victories']) {
    for (const value of [undefined, null, -1, 1.5, Infinity, '100', 2147483648]) {
      options.profile = { [field]: value }; f.calls.length = 0; f.profiles.length = 0;
      await assert.rejects(f.service.executeSync({ source: 'cron' }), error => error.code === 'invalid_upstream_profile' && error.status === 502);
      assert.equal(f.profiles.length, 4, 'Invalid primary data must stop subsequent serial batches');
      assert.deepEqual(f.calls.map(call => call.name), ['acquire_sync_run', 'fail_sync_run']);
      assert.equal(f.calls.at(-1).args.p_error_code, 'invalid_upstream_profile');
    }
  }
  assert.deepEqual(f.network, []); assert.equal(f.attempts.size, 0);
});

test('required profile shape is checked but valid zero counters and optional-field omissions are accepted', async () => {
  for (const profile of [{ name: null }, { brawlers: null }]) {
    const f = fixture({ profile }); await assert.rejects(f.service.executeSync({ source: 'member', playerTag: '#P00' }), error => error.code === 'invalid_upstream_profile');
    assert.equal(f.calls.some(call => call.name === 'commit_sync_snapshot'), false);
  }
  const f = fixture({ profile: { trophies: 0, highestTrophies: 0, expLevel: 0 } });
  assert.equal((await f.service.executeSync({ source: 'member', playerTag: '#P00' })).success, true);
  const body = f.calls.find(call => call.name === 'commit_sync_snapshot').args.p_payload;
  assert.equal(body.members[0].trophies, 0); assert.equal(body.members[0].trio_victories, 0);
});
