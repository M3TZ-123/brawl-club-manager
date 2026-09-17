const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const provider = loadTypeScript('src/lib/mega-pig-source-provider.ts');
const club = '#PYLQ';
const clean = value => JSON.parse(JSON.stringify(value));
const sample = (wins = 4) => ({ clubTag: club, totalWins: wins, reportedPlayersPlayed: 1, members: [
  { playerTag: '#PYLR', playerName: 'Member', reportedWins: wins, reportedTicketsRemaining: 2 },
  { playerTag: '#PYLC', playerName: 'Second', reportedWins: 0, reportedTicketsRemaining: 6 },
] });
function entry(extra = {}) {
  const now = Date.now();
  return { club_tag: club, payload: sample(), previous_payload: null, fetched_at: new Date(now - 1000).toISOString(),
    changed_at: new Date(now - 1000).toISOString(), last_attempt_at: new Date(now - 1000).toISOString(),
    next_check_at: new Date(now + 1200000).toISOString(), error_code: null, consecutive_failures: 0, lease_expires_at: null, ...extra };
}
function fixture(options = {}) {
  const calls = [], fetched = [], signals = [];
  const old = options.old || entry();
  const service = loadTypeScript('src/lib/mega-pig-source-cache.ts', {
    '@/lib/supabase-admin': { supabaseAdmin: { rpc(name, args) {
      calls.push({ name, args });
      return { abortSignal(signal) {
        signals.push(signal);
        if (options.rpc) return options.rpc(name, args, signal);
        return Promise.resolve(name === 'claim_mega_pig_source_cache'
          ? { data: { acquired: options.acquired !== false, entry: old }, error: options.claimError || null }
          : { data: { accepted: options.accepted !== false, entry: entry(args.p_error_code
            ? { ...old, error_code: args.p_error_code, consecutive_failures: 1, lease_expires_at: null }
            : { payload: args.p_payload }) }, error: options.finishError || null });
      } };
    } } },
    '@/lib/mega-pig-source-provider': { ...provider, fetchMegaPigSource: async (tag, { signal }) => {
      fetched.push(tag); signals.push(signal);
      if (options.fetch) return options.fetch(signal);
      if (options.providerError) throw options.providerError;
      return options.payload || sample(8);
    } },
  });
  return { ...service, calls, fetched, signals, old };
}

test('one claim fetches once, reprojects only counters, and finishes the same lease', async () => {
  const payload = sample(8); payload.secret = 'NEVER STORE'; payload.members[0].notes = 'PRIVATE';
  const f = fixture({ payload }); const result = await f.refreshMegaPigSource(club);
  assert.deepEqual(f.fetched, [club]); assert.deepEqual(f.calls.map(c => c.name), ['claim_mega_pig_source_cache', 'finish_mega_pig_source_cache']);
  assert.equal(f.calls[0].args.p_token, f.calls[1].args.p_token);
  assert.equal(f.calls[1].args.p_error_code, null); assert.equal(result.payload.totalWins, 8); assert.equal(result.stale, false);
  assert.deepEqual(result.payload.members.map(m => m.playerTag).join(','), '#PYLC,#PYLR');
  assert.doesNotMatch(JSON.stringify(f.calls), /NEVER STORE|PRIVATE|secret|notes/);
  assert.ok(f.signals.every(signal => signal.aborted), 'Completed request scopes dispose abort listeners/timers');
});

test('concurrent local readers share one durable claim and one provider request', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const f = fixture({ fetch: () => delayed });
  const first = f.refreshMegaPigSource(club), second = f.refreshMegaPigSource(club);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.fetched.length, 1); release(sample(9));
  const results = await Promise.all([first, second]); assert.equal(results[0].payload.totalWins, 9); assert.deepEqual(clean(results[0]), clean(results[1]));
  assert.equal(f.calls.length, 2);
});

test('a durable cooldown or another worker lease never calls the provider or finish', async () => {
  const f = fixture({ acquired: false, old: entry({ lease_expires_at: new Date(Date.now() + 10000).toISOString() }) });
  const result = await f.refreshMegaPigSource(club);
  assert.equal(result.refreshing, true); assert.equal(result.payload.totalWins, 4); assert.equal(f.fetched.length, 0); assert.equal(f.calls.length, 1);
});

test('rate limiting preserves the last snapshot and forwards only sanitized retry metadata', async () => {
  const f = fixture({ providerError: new provider.SourceProviderError('rate_limited', 7200) });
  const result = await f.refreshMegaPigSource(club);
  assert.equal(result.payload.totalWins, 4); assert.equal(result.stale, true); assert.equal(result.errorCode, 'rate_limited');
  assert.equal(f.calls[1].args.p_retry_after_seconds, 7200); assert.equal(f.calls[1].args.p_payload, null);
  assert.equal(result.fetchedAt, f.old.fetched_at);
});
test('source Retry-After longer than one day survives the service boundary', async () => {
  for (const [seconds, expected] of [[172800, 172800], [2147483647, 604800]]) {
    const f = fixture({ providerError: new provider.SourceProviderError('rate_limited', seconds) });
    await f.refreshMegaPigSource(club); assert.equal(f.calls[1].args.p_retry_after_seconds, expected);
  }
});

test('an invalid response or arbitrary upstream error cannot replace known data or leak its body', async () => {
  for (const options of [{ payload: { ...sample(), totalWins: 900 } }, { providerError: new Error('Bearer SECRET raw response') }]) {
    const f = fixture(options), result = await f.refreshMegaPigSource(club);
    assert.equal(result.payload.totalWins, 4); assert.equal(result.stale, true);
    assert.equal(f.calls[1].args.p_error_code, options.payload ? 'invalid' : 'unavailable');
    assert.doesNotMatch(JSON.stringify({ result, calls: f.calls }), /Bearer|SECRET|raw response/);
  }
});

test('claim failures and already cancelled callers never reach the provider', async () => {
  const f = fixture({ claimError: { message: 'PRIVATE DATABASE' } });
  await assert.rejects(f.refreshMegaPigSource(club), /temporarily unavailable/); assert.equal(f.fetched.length, 0);
  const aborted = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(aborted.refreshMegaPigSource(club, { signal: controller.signal })); assert.equal(aborted.calls.length, 0);
  await assert.rejects(aborted.refreshMegaPigSource('invalid')); assert.equal(aborted.calls.length, 0);
});

test('a stalled database gate is bounded even if transport ignores AbortSignal', async () => {
  const f = fixture({ rpc: () => new Promise(() => {}) }), start = Date.now();
  await assert.rejects(f.refreshMegaPigSource(club, { deadlineAt: Date.now() + 30 }));
  assert.ok(Date.now() - start < 500); assert.equal(f.fetched.length, 0); assert.ok(f.signals[0].aborted);
});
test('a cancelled in-flight fetch is settled and recorded without waiting for an ignoring provider', async () => {
  const f = fixture({ fetch: () => new Promise(() => {}) }), controller = new AbortController();
  const request = f.refreshMegaPigSource(club, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.fetched.length, 1); controller.abort();
  const result = await request; assert.equal(result.stale, true); assert.equal(result.payload.totalWins, 4);
  assert.equal(f.calls[1].args.p_error_code, 'unavailable'); assert.ok(f.signals.every(signal => signal.aborted));
});

test('a failed or superseded finish never presents new data as durably saved', async () => {
  for (const options of [{ finishError: { message: 'SQL SECRET' } }, { accepted: false }]) {
    const f = fixture(options), result = await f.refreshMegaPigSource(club);
    assert.equal(result.payload.totalWins, 4); assert.equal(result.stale, true); assert.equal(result.errorCode, 'unavailable');
    assert.equal(result.fetchedAt, f.old.fetched_at);
  }
});

test('a stalled finish uses the caller deadline and leaves old data stale', async () => {
  const f = fixture({ rpc: name => name === 'claim_mega_pig_source_cache'
    ? Promise.resolve({ data: { acquired: true, entry: entry() }, error: null }) : new Promise(() => {}) });
  const start = Date.now(), result = await f.refreshMegaPigSource(club, { deadlineAt: Date.now() + 30 });
  assert.ok(Date.now() - start < 500); assert.equal(result.payload.totalWins, 4); assert.equal(result.stale, true);
  assert.equal(f.fetched.length, 0, 'Insufficient remaining fetch/finish budget skips an external request');
});

test('restored cache values are revalidated and unfinished attempts never appear fresh', async () => {
  const f = fixture({ acquired: false, old: entry({ payload: { ...sample(), totalWins: 99 } }) });
  let result = await f.refreshMegaPigSource(club); assert.equal(result.payload, null); assert.equal(result.fetchedAt, null); assert.equal(result.stale, true);
  const future = fixture({ acquired: false, old: entry({ fetched_at: '2099-01-01T00:00:00Z' }) });
  result = await future.refreshMegaPigSource(club); assert.equal(result.fetchedAt, null); assert.equal(result.stale, true);
  const unfinished = fixture({ acquired: false, old: entry({ last_attempt_at: new Date().toISOString() }) });
  assert.equal((await unfinished.refreshMegaPigSource(club)).stale, true);
  const wrongClub = fixture({ acquired: false, old: entry({ club_tag: '#OTHER' }) });
  await assert.rejects(wrongClub.refreshMegaPigSource(club)); assert.equal(wrongClub.fetched.length, 0);
});
