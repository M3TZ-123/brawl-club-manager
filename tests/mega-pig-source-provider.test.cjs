const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript: loadModule } = require('./helpers/load-typescript.cjs');
const loadTypeScript = (relativePath, mocks = {}, globals = {}) => loadModule(relativePath, mocks, { console: { ...console, warn() {} }, ...globals });
const file = 'src/lib/mega-pig-source-provider.ts';
const club = '#PYLC';
const headers = ['NAME', 'Mega Pig Wins', 'Mega Pig Tickets Left', 'Trophies', 'RANKED RANK'];
const clean = value => JSON.parse(JSON.stringify(value));
function fixture({ members = [{ tag: '#PYLQ', name: 'عضو &amp; واحد', wins: 1, tickets: 5 }, { tag: '#PYLR', name: '<span>Example</span> member', wins: 2, tickets: 4 }], total = 3, played = 2, tag = club, head = headers } = {}) {
  return `<main><h3>Example club</h3><p>${tag}</p><b>Total Wins: ${total}</b><b>Players Played: ${played}</b>
    <p>Members (${members.length} / 30) 10 ONLINE</p><table id="megaPigTable"><thead><tr>${head.map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>
    ${members.map(m => `<tr><td><img src="https://untrusted.invalid/image" onerror="fetch('https://untrusted.invalid/')" alt="IGNORED"><a target="_blank" href="https://brawlace.com/players/${encodeURIComponent(m.tag)}">${m.name}</a></td><td data-order="999">${m.wins}</td><td>${m.tickets}</td><td>99,999</td><td data-order="10"><img src="https://untrusted.invalid/rank"> I </td></tr>`).join('')}
    </tbody></table><script>fetch('https://untrusted.invalid/'); const fake = 'Total Wins: 999 #GGRR';</script></main>`;
}
function apiFixture({ members = [
  { tag: '#PYLQ', name: 'عضو & واحد', megaPig: { wins: 1, ticketsLeft: 5 } },
  { tag: '#PYLR', name: 'Example member', megaPig: { wins: 2, ticketsLeft: 4 } },
], total = 3, played = 4, tag = club } = {}) {
  return { tag, timestamp: 1789749903, data: {
    name: 'Club profile ignored', description: 'PRIVATE PROFILE', memberCount: members.length,
    megaPig: { id: 1, totalWins: total, totalPlayed: played }, members,
  } };
}
function response(body = JSON.stringify(apiFixture()), extraHeaders = {}) { return new Response(body, { headers: { 'content-type': 'application/json; charset=UTF-8', ...extraHeaders } }); }
const invalid = error => error.code === 'invalid' && !/PRIVATE|untrusted/.test(error.message);

test('parser identifies the exact table and returns only public tags, decoded names and reported counters', () => {
  const provider = loadTypeScript(file);
  const payload = clean(provider.parseMegaPigSourceHtml(fixture(), club));
  assert.deepEqual(payload, { source: 'BrawlAce', clubTag: club, totalWins: 3, reportedPlayersPlayed: 2, reportedBattlesPlayed: null, members: [
    { playerTag: '#PYLQ', playerName: 'عضو & واحد', reportedWins: 1, reportedTicketsRemaining: 5 },
    { playerTag: '#PYLR', playerName: 'Example member', reportedWins: 2, reportedTicketsRemaining: 4 },
  ] });
  assert.doesNotMatch(JSON.stringify(payload), /ONLINE|trophies|rank|sourceUpdated|cycle|fetch\(|<|IGNORED/);
  assert.deepEqual(clean(provider.parseMegaPigSourceHtml(fixture().replace('<thead><tr>', '<thead>').replace('</tr></thead>', '</thead>'), club)), payload,
    'Header semantics remain exact when the source omits an optional heading row wrapper');
});

test('reported participation is preserved, never inferred from wins or tickets; real zero stays zero', () => {
  const provider = loadTypeScript(file);
  const html = fixture({ members: [{ tag: '#PYLQ', name: 'Player', wins: 0, tickets: 5 }, { tag: '#PYLR', name: 'Other', wins: 0, tickets: 6 }], total: 0, played: 1 });
  const payload = provider.parseMegaPigSourceHtml(html, club);
  assert.equal(payload.totalWins, 0); assert.equal(payload.reportedPlayersPlayed, 1);
  assert.equal(payload.members[0].reportedWins, 0); assert.equal(payload.members[0].reportedTicketsRemaining, 5);
  assert.deepEqual(clean(provider.parseMegaPigSourceHtml(fixture({ members: [], total: 0, played: 0 }), club)), { source: 'BrawlAce', clubTag: club, totalWins: 0, reportedPlayersPlayed: 0, reportedBattlesPlayed: null, members: [] });
});

test('observed modal structure retains unknown rows without fabricating the missing share of reported total wins', () => {
  const { parseMegaPigSourceHtml } = loadTypeScript(file);
  const alphabet = '0289PYLQGRJCUV';
  const members = Array.from({ length: 30 }, (_, index) => ({
    tag: `#PYL${alphabet[Math.floor(index / alphabet.length)]}${alphabet[index % alphabet.length]}`,
    name: `Synthetic member ${index + 1}`, wins: index < 26 ? 3 : index < 28 ? 0 : '-', tickets: index < 28 ? 0 : '-',
  }));
  const html = fixture({ members, total: 82, played: 24 })
    .replace(`<main><h3>Example club</h3><p>${club}</p>`, `<h1>Example club</h1><span class='lead'><span class='badge'>${club}</span></span><h2><img alt='mega pig'>MEGA PIG</h2>`)
    .replace('</b><b>Players', '</b><br><b>Players').replace('<thead><tr>', '<thead>').replace('</tr></thead>', '</thead>').replace('</main>', '');
  const result = clean(parseMegaPigSourceHtml(html, club));
  assert.equal(result.members.length, 30); assert.equal(result.totalWins, 82); assert.equal(result.reportedPlayersPlayed, 24);
  assert.equal(result.members.filter(member => member.reportedWins === null).length, 2);
  assert.equal(result.members.reduce((sum, member) => sum + (member.reportedWins ?? 0), 0), 78);
  assert.deepEqual(result.members.slice(-2).map(member => [member.reportedWins, member.reportedTicketsRemaining]), [[null, null], [null, null]]);
});

test('only the exact source dash means unknown and unknown counters do not disable aggregate validation', () => {
  const provider = loadTypeScript(file);
  const members = [{ tag: '#PYLQ', name: 'Known', wins: 3, tickets: '-' }, { tag: '#PYLR', name: 'Unknown', wins: '-', tickets: 0 }];
  const result = provider.parseMegaPigSourceHtml(fixture({ members, total: 4, played: 1 }), club);
  assert.equal(result.members[0].reportedTicketsRemaining, null); assert.equal(result.members[1].reportedTicketsRemaining, 0);
  assert.equal(provider.validateMegaPigSourcePayload(result, club).members[1].reportedWins, null);
  assert.throws(() => provider.parseMegaPigSourceHtml(fixture({ members, total: 2, played: 1 }), club), invalid, 'Known wins cannot exceed the reported total');
  assert.throws(() => provider.parseMegaPigSourceHtml(fixture().replace('<td>5</td>', '<td>-</td>').replace('Total Wins: 3', 'Total Wins: 4'), club), invalid, 'Unknown tickets do not make known wins incomplete');
  for (const placeholder of ['', '—', '–', '--', 'N/A', 'null', 'unknown']) {
    assert.throws(() => provider.parseMegaPigSourceHtml(fixture().replace('<td>5</td>', `<td>${placeholder}</td>`), club), invalid);
  }
  assert.throws(() => provider.parseMegaPigSourceHtml(fixture().replace('Total Wins: 3', 'Total Wins: -'), club), invalid, 'Aggregate counters must still be numeric');
});

test('changed headers, missing cells, club mismatch, duplicate identities and foreign player links fail closed', () => {
  const { parseMegaPigSourceHtml } = loadTypeScript(file);
  const base = fixture();
  const variants = [
    base.replace('id="megaPigTable"', 'id="other"'), base.replace('Mega Pig Tickets Left', 'Tickets used'),
    base.replace('<th>NAME</th>', '<th>Name</th>'), base.replace('<td>5</td>', ''), base.replace('<td>5</td>', '<td>5</td><td>extra</td>'),
    base.replace('<p>#PYLC</p>', '<p>#GGRR</p>'), base.replace('/players/%23PYLR', '/players/%23PYLQ'),
    base.replace('/players/%23PYLQ', '/players/%23INVALID'), base.replace('https://brawlace.com/players/', 'https://untrusted.invalid/players/'),
    base.replace('https://brawlace.com/players/', 'https://secret@brawlace.com/players/'),
    base.replace('/players/%23PYLQ', '/players/%23PYLQ?token=PRIVATE'),
    base.replace('</main>', '<div id="megaPigTable"></div></main>'), base.replace('<tbody>', '<tbody><table></table>'),
  ];
  for (const html of variants) assert.throws(() => parseMegaPigSourceHtml(html, club), invalid);
});

test('missing, negative, decimal and inconsistent counters are never silently converted into valid totals', () => {
  const { parseMegaPigSourceHtml } = loadTypeScript(file);
  for (const value of ['', '-1', '1.5', 'NaN', 'null', '1,000', '01', '1001', '2147483648']) {
    assert.throws(() => parseMegaPigSourceHtml(fixture().replace('<td>5</td>', `<td>${value}</td>`), club), invalid);
  }
  for (const html of [fixture({ total: 4 }), fixture({ played: 3 }), fixture().replace('<b>Total Wins: 3</b>', ''), fixture() + '<b>Total Wins: 3</b>']) {
    assert.throws(() => parseMegaPigSourceHtml(html, club), invalid);
  }
  assert.equal(parseMegaPigSourceHtml(fixture({ members: [{ tag: '#PYLQ', name: 'Player', wins: 1000, tickets: 1000 }], total: 1000, played: 1 }), club).totalWins, 1000);
  assert.throws(() => parseMegaPigSourceHtml(fixture({ members: [{ tag: '#PYLQ', name: 'Player', wins: 1001, tickets: 0 }], total: 1001, played: 1 }), club), invalid);
});

test('bounded parsing rejects oversized documents, too many rows and pathological nesting', () => {
  const { parseMegaPigSourceHtml } = loadTypeScript(file);
  assert.throws(() => parseMegaPigSourceHtml(fixture() + ' '.repeat(128 * 1024), club), invalid);
  assert.throws(() => parseMegaPigSourceHtml('<div>'.repeat(66) + fixture() + '</div>'.repeat(66), club), invalid);
  assert.throws(() => parseMegaPigSourceHtml(fixture({ members: Array(31).fill({ tag: '#PYLQ', name: 'Fixture', wins: 0, tickets: 0 }), total: 0, played: 0 }), club), invalid);
  assert.throws(() => parseMegaPigSourceHtml(fixture() + '\0', club), invalid);
});

test('cache reprojection removes extra properties and rejects malformed or wrong-club payloads', () => {
  const provider = loadTypeScript(file), payload = clean(provider.parseMegaPigSourceHtml(fixture(), club));
  payload.secret = 'PRIVATE'; payload.members[0].owner = 'PRIVATE';
  assert.doesNotMatch(JSON.stringify(provider.validateMegaPigSourcePayload(payload, club)), /PRIVATE|secret|owner/);
  for (const patch of [p => { delete p.members[0].reportedWins; }, p => { p.members[0].reportedTicketsRemaining = '5'; }, p => { p.members[0].reportedTicketsRemaining = 1001; }, p => { p.members[0].playerName = ''; }, p => { p.clubTag = '#GGRR'; }, p => { p.totalWins = 30001; }]) {
    const changed = clean(payload); patch(changed); assert.throws(() => provider.validateMegaPigSourcePayload(changed, club), invalid);
  }
});

test('documented API response keeps played battles separate from players and omits ambiguous cycle and timestamp fields', () => {
  const provider = loadTypeScript(file), raw = apiFixture();
  const result = clean(provider.parseMegaPigSourceJson(JSON.stringify(raw), club));
  assert.deepEqual(result, { source: 'BrawlTools', clubTag: club, totalWins: 3, reportedPlayersPlayed: null, reportedBattlesPlayed: 4, members: [
    { playerTag: '#PYLQ', playerName: 'عضو & واحد', reportedWins: 1, reportedTicketsRemaining: 5 },
    { playerTag: '#PYLR', playerName: 'Example member', reportedWins: 2, reportedTicketsRemaining: 4 },
  ] });
  assert.doesNotMatch(JSON.stringify(result), /timestamp|cycle|PRIVATE|description|"id"/);
  raw.timestamp += 120; raw.data.megaPig.id = 17;
  assert.deepEqual(clean(provider.parseMegaPigSourceJson(JSON.stringify(raw), club)), result, 'Counter-identical reads do not become new snapshots because provider metadata changed');
  delete raw.data.memberCount;
  assert.deepEqual(clean(provider.parseMegaPigSourceJson(JSON.stringify(raw), club)), result, 'An optional roster count is not needed when all identities and rows are valid');
});

test('API missing counters remain unknown while explicit zeros stay source-reported zeros', () => {
  const { parseMegaPigSourceJson } = loadTypeScript(file);
  const members = [
    { tag: '#PYLQ', name: 'Known zero', megaPig: { wins: 0, ticketsLeft: 0 } },
    { tag: '#PYLR', name: 'Absent object' },
    { tag: '#PYLP', name: 'Null object', megaPig: null },
    { tag: '#PYLY', name: 'One missing value', megaPig: { wins: 1 } },
    { tag: '#PYLV', name: 'One explicit null', megaPig: { wins: null, ticketsLeft: 6 } },
  ];
  const raw = apiFixture({ members, total: 5, played: 12 });
  const result = clean(parseMegaPigSourceJson(JSON.stringify(raw), club));
  assert.deepEqual(result.members.map(m => [m.reportedWins, m.reportedTicketsRemaining]), [[0, 0], [null, null], [null, null], [1, null], [null, 6]]);
  assert.equal(result.totalWins, 5); assert.equal(result.reportedPlayersPlayed, null); assert.equal(result.reportedBattlesPlayed, 12);
  delete raw.data.megaPig.totalPlayed;
  assert.equal(parseMegaPigSourceJson(JSON.stringify(raw), club).reportedBattlesPlayed, null);
  raw.data.megaPig.totalPlayed = null;
  assert.equal(parseMegaPigSourceJson(JSON.stringify(raw), club).reportedBattlesPlayed, null);
  assert.deepEqual(clean(parseMegaPigSourceJson(JSON.stringify(apiFixture({ members: [], total: 0, played: 0 })), club)), {
    source: 'BrawlTools', clubTag: club, totalWins: 0, reportedPlayersPlayed: null, reportedBattlesPlayed: 0, members: [],
  });
});

test('API rejects malformed structure, identity, roster count, and counters without treating missing evidence as zero', () => {
  const { parseMegaPigSourceJson } = loadTypeScript(file);
  const changes = [
    r => { r.tag = '#GGRR'; }, r => { delete r.tag; }, r => { r.data = []; }, r => { r.data.megaPig = null; },
    r => { delete r.data.megaPig.totalWins; }, r => { r.data.members = {}; }, r => { r.data.memberCount = 3; },
    r => { r.data.memberCount = null; }, r => { r.data.members[1].tag = '#PYLQ'; }, r => { r.data.members[0].tag = '#INVALID'; },
    r => { r.data.members[0].name = ''; }, r => { r.data.members[0].name = 'PRIVATE\0NAME'; },
    r => { r.data.members[0].megaPig = 'PRIVATE'; }, r => { r.data.members[0].megaPig = []; },
    r => { r.data.megaPig.totalWins = 2; }, r => { r.data.megaPig.totalWins = 4; }, r => { r.data.megaPig.totalPlayed = 2; },
    r => { r.data.members = Array(31).fill(r.data.members[0]); r.data.memberCount = 31; },
  ];
  for (const change of changes) { const raw = apiFixture(); change(raw); assert.throws(() => parseMegaPigSourceJson(JSON.stringify(raw), club), invalid); }
  for (const value of [-1, 1.5, '1', true, {}, [], 1001]) {
    const raw = apiFixture(); raw.data.members[0].megaPig.ticketsLeft = value;
    assert.throws(() => parseMegaPigSourceJson(JSON.stringify(raw), club), invalid);
  }
  for (const value of [-1, 3.5, '4', true, {}, [], 30001]) {
    const raw = apiFixture(); raw.data.megaPig.totalPlayed = value;
    assert.throws(() => parseMegaPigSourceJson(JSON.stringify(raw), club), invalid);
  }
  for (const raw of ['null', '[]', '{}', '{PRIVATE', JSON.stringify(apiFixture()) + ' '.repeat(128 * 1024)]) assert.throws(() => parseMegaPigSourceJson(raw, club), invalid);
  const incomplete = apiFixture({ members: [{ tag: '#PYLQ', name: 'Known', megaPig: { wins: 4 } }, { tag: '#PYLR', name: 'Unknown' }], total: 3 });
  assert.throws(() => parseMegaPigSourceJson(JSON.stringify(incomplete), club), invalid, 'Unknown rows do not allow known wins to exceed the total');
});

test('legacy cache values retain BrawlAce provenance and provider-specific metrics cannot be mixed', () => {
  const provider = loadTypeScript(file), legacy = clean(provider.parseMegaPigSourceHtml(fixture(), club));
  delete legacy.source; delete legacy.reportedBattlesPlayed;
  const restored = provider.validateMegaPigSourcePayload(legacy, club);
  assert.equal(restored.source, 'BrawlAce'); assert.equal(restored.reportedBattlesPlayed, null); assert.equal(restored.reportedPlayersPlayed, 2);
  const api = clean(provider.parseMegaPigSourceJson(JSON.stringify(apiFixture()), club));
  for (const row of [
    { ...legacy, source: 'Other' }, { ...legacy, source: null }, { ...legacy, reportedPlayersPlayed: null },
    { ...legacy, reportedBattlesPlayed: 4 }, { ...api, reportedPlayersPlayed: 2 }, { ...api, reportedBattlesPlayed: 2 },
    { ...api, reportedBattlesPlayed: 30001 }, { ...api, reportedBattlesPlayed: '4' },
  ]) assert.throws(() => provider.validateMegaPigSourcePayload(row, club), invalid);
});

test('fetch makes exactly one fixed-host anonymous request with honest identification and no redirect or cache reuse', async () => {
  const calls = [];
  const provider = loadTypeScript(file, {}, { fetch: async (...args) => { calls.push(args); return response(); } });
  const payload = await provider.fetchMegaPigSource('pylc');
  assert.equal(payload.clubTag, club); assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://api.brawltools.net/clubs/%23PYLC');
  assert.equal(options.method, 'GET'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
  assert.equal(options.headers['User-Agent'], 'BrawlStatz (+https://brawlstatz.vercel.app)');
  assert.equal(options.headers.Accept, 'application/json');
  assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent']);
  assert.ok(options.signal instanceof AbortSignal);
  for (const bad of ['https://untrusted.invalid', '#PYLC/../x', '#PYLC?x=1', '#INVALID', '#PYLC\nCookie: private']) await assert.rejects(provider.fetchMegaPigSource(bad), invalid);
  assert.equal(calls.length, 1, 'Bad inputs never trigger a network request');
});

test('rate limits expose only sanitized retry seconds and never retry or consume the error body', async () => {
  class FixedDate extends Date { static now() { return Date.parse('2026-09-17T12:00:00Z'); } }
  for (const [header, expected] of [['120', 120], ['Thu, 17 Sep 2026 12:02:00 GMT', 120], ['-1', undefined], ['private invalid', undefined]]) {
    let calls = 0;
    const provider = loadTypeScript(file, {}, { Date: FixedDate, fetch: async () => { calls++; return new Response('PRIVATE', { status: 429, headers: { 'retry-after': header } }); } });
    await assert.rejects(provider.fetchMegaPigSource(club), error => error.code === 'rate_limited' && error.retryAfterSeconds === expected && !/PRIVATE|private/.test(error.message));
    assert.equal(calls, 1);
  }
});

test('HTTP failure, redirects and network details become typed unavailable errors without leaking payloads', async () => {
  for (const status of [301, 403, 500]) {
    let calls = 0;
    const provider = loadTypeScript(file, {}, { fetch: async () => { calls++; return new Response('PRIVATE', { status }); } });
    await assert.rejects(provider.fetchMegaPigSource(club), error => error.code === 'unavailable' && !/PRIVATE/.test(error.message)); assert.equal(calls, 1);
  }
  const provider = loadTypeScript(file, {}, { fetch: async () => { throw new Error('PRIVATE TOKEN'); } });
  await assert.rejects(provider.fetchMegaPigSource(club), error => error.code === 'unavailable' && !/PRIVATE/.test(error.message));
  const challenge = loadTypeScript(file, {}, { fetch: async () => response('<html><title>Verification required</title><script>location.href="https://untrusted.invalid";</script></html>') });
  await assert.rejects(challenge.fetchMegaPigSource(club), invalid, 'A challenge page is rejected without running scripts or bypassing it');
});

test('UTF8 streaming counts bytes across chunks and rejects invalid or excessive data', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(apiFixture())), firstArabic = bytes.findIndex(byte => byte >= 128);
  const valid = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, firstArabic + 1)); controller.enqueue(bytes.slice(firstArabic + 1)); controller.close(); } });
  const provider = loadTypeScript(file, {}, { fetch: async () => response(valid) });
  assert.equal((await provider.fetchMegaPigSource(club)).members[0].playerName, 'عضو & واحد');
  for (const body of [new Uint8Array([0xc3, 0x28]), new Uint8Array(128 * 1024 + 1)]) {
    await assert.rejects(loadTypeScript(file, {}, { fetch: async () => response(body) }).fetchMegaPigSource(club), invalid);
  }
  await assert.rejects(loadTypeScript(file, {}, { fetch: async () => response(JSON.stringify(apiFixture()), { 'content-length': String(128 * 1024 + 1) }) }).fetchMegaPigSource(club), invalid);
  await assert.rejects(loadTypeScript(file, {}, { fetch: async () => new Response(JSON.stringify(apiFixture()), { headers: { 'content-type': 'text/html' } }) }).fetchMegaPigSource(club), invalid);
});

test('caller cancellation covers both fetch and body reads, cancels the reader and prevents an already-aborted request', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const pre = loadTypeScript(file, {}, { fetch: async () => { calls++; return response(); } });
  await assert.rejects(pre.fetchMegaPigSource(club, { signal: controller.signal }), error => error.code === 'unavailable'); assert.equal(calls, 0);
  for (const phase of ['fetch', 'body']) {
    const signal = new AbortController(); let cancelled = false;
    const provider = loadTypeScript(file, {}, { fetch: async () => phase === 'fetch' ? new Promise(() => {}) : response(new ReadableStream({ cancel() { cancelled = true; } })) });
    const pending = provider.fetchMegaPigSource(club, { signal: signal.signal });
    setTimeout(() => signal.abort(), 5);
    await assert.rejects(pending, error => error.code === 'unavailable');
    if (phase === 'body') assert.equal(cancelled, true);
  }
});

test('the eight-second provider deadline includes a stalled body even after response headers succeeded', async () => {
  let duration, cancelled = false;
  const provider = loadTypeScript(file, {}, {
    setTimeout: (callback, delay) => { duration = delay; return setTimeout(callback, 5); },
    fetch: async () => response(new ReadableStream({ cancel() { cancelled = true; } })),
  });
  await assert.rejects(provider.fetchMegaPigSource(club), error => error.code === 'unavailable');
  assert.equal(duration, 8000); assert.equal(cancelled, true);
});

test('server diagnostics record only a finite reason and HTTP status while preserving public error codes', async () => {
  for (const [status, reason, code] of [[403, 'http_status', 'unavailable'], [500, 'http_status', 'unavailable'], [429, 'rate_limited', 'rate_limited']]) {
    const logs = [];
    const provider = loadTypeScript(file, {}, {
      console: { warn: (...args) => logs.push(args) },
      fetch: async () => new Response('PRIVATE SOURCE BODY #PYLC', { status, headers: { 'set-cookie': 'PRIVATE_COOKIE', 'retry-after': '60' } }),
    });
    await assert.rejects(provider.fetchMegaPigSource(club), error => error.code === code);
    assert.deepEqual(clean(logs), [['mega_pig_source_failure', { reason, httpStatus: status }]]);
  }
  const logs = [];
  const provider = loadTypeScript(file, {}, { console: { warn: (...args) => logs.push(args) }, fetch: async () => response() });
  await provider.fetchMegaPigSource(club);
  assert.deepEqual(logs, [], 'Successful reads do not emit failure diagnostics');
});

test('network, invalid-page and aborted-body diagnostics never include exception or source details', async () => {
  for (const phase of ['network', 'invalid', 'aborted']) {
    const logs = [], controller = new AbortController();
    const provider = loadTypeScript(file, {}, {
      console: { warn: (...args) => logs.push(args) },
      fetch: async () => {
        if (phase === 'network') throw new Error('PRIVATE_TOKEN https://private.invalid/?secret=PRIVATE #PYLC');
        if (phase === 'invalid') return response('<html>PRIVATE BODY #PYLC</html>');
        return response(new ReadableStream({ start() { setTimeout(() => controller.abort(), 5); } }));
      },
    });
    await assert.rejects(provider.fetchMegaPigSource(club, { signal: controller.signal }), error => error.code === (phase === 'invalid' ? 'invalid' : 'unavailable'));
    assert.deepEqual(clean(logs), [['mega_pig_source_failure', {
      reason: phase === 'network' ? 'network_error' : phase === 'invalid' ? 'invalid_data' : 'aborted', httpStatus: phase === 'network' ? null : 200,
    }]]);
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|PYLC|https?:\/\/|cookie|secret/i);
  }
});
