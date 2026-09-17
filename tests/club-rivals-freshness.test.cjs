const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, elements, textContent } = require('./helpers/client-renderer.cjs');

const rival = { tag: '#GGRR', profile: { name: 'Compared club', rosterTrophies: 1000, memberCount: 10, medianTrophies: 100, requiredTrophies: 0 }, fetchedAt: null, stale: false, history: [] };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture({ rivals = [rival], reply } = {}) {
  const renderer = hookRenderer(), requests = [], listeners = new Map();
  const state = {
    rivals: { clubTag: '#PYLQ', region: 'TN', rivals, ranks: [], rankingAt: null, rankingStale: true },
    own: { club: { tag: '#PYLQ', metadata: { name: 'Original club', requiredTrophies: 500 }, rosterTrophies: 11111, memberCount: 30, observedAt: '2026-09-16T12:00:00Z' }, strength: { medianTrophies: 222 } },
  };
  const surface = { visibilityState: 'visible', addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
  const Page = loadTypeScript('src/app/rivals/page.tsx', { ...componentMocks, react: renderer.react,
    '@/hooks/use-admin-session': { useAdminSession: () => ({ isAdmin: false }) },
    '@/components/club-ranking-summary': { ClubRankingSummary: 'ClubRankingSummary' },
    '@/components/club-rivals-comparison': { ClubRivalsComparison: 'ClubRivalsComparison' },
    '@/lib/client-data-cache': { invalidateJsonCache() {}, fetchJsonCached: async (url, options) => {
      requests.push({ url, options }); return reply ? reply(url, state, requests) : url.startsWith('/api/club-intelligence') ? state.own : state.rivals;
    } },
  }, { window: surface, document: surface }).default;
  return { state, requests, render: () => renderer.render(Page), update() {
    for (const listener of listeners.get('club-data-updated') || []) listener({ detail: { source: 'sync-status', datasets: ['roster'] } });
  } };
}
const comparison = tree => elements(tree).find(node => node.type === 'ClubRivalsComparison')?.props;
const ranking = tree => elements(tree).find(node => node.type === 'ClubRankingSummary')?.props;

test('automatic roster success refreshes an open rivals comparison without focus or navigation', async () => {
  const f = fixture(); let tree = await f.render(); assert.equal(comparison(tree).own.club.rosterTrophies, 11111);
  f.state.own = { ...f.state.own, club: { ...f.state.own.club, rosterTrophies: 22222, memberCount: 29 } };
  f.update(); tree = await f.render();
  assert.equal(f.requests.length, 4); assert.ok(f.requests.slice(2).every(request => request.options.force === true));
  assert.equal(comparison(tree).own.club.rosterTrophies, 22222); assert.equal(comparison(tree).own.club.memberCount, 29);
});

test('independent old-club responses cannot populate the new club comparison row', async () => {
  const f = fixture(); await f.render();
  f.state.rivals = { ...f.state.rivals, clubTag: '#GGRR' }; f.update();
  let tree = await f.render();
  assert.equal(comparison(tree).data.clubTag, '#GGRR'); assert.equal(comparison(tree).own, null); assert.equal(comparison(tree).ownError, true);
  f.state.own = { ...f.state.own, club: { ...f.state.own.club, tag: '#GGRR', metadata: { name: 'Replacement club', requiredTrophies: 0 }, rosterTrophies: 33333 } };
  f.update(); tree = await f.render();
  assert.equal(comparison(tree).own.club.metadata.name, 'Replacement club'); assert.equal(comparison(tree).own.club.rosterTrophies, 33333);
  assert.equal(comparison(tree).ownError, false);
});

test('an empty rival list defaults to Tunisia ranking and never requests or displays a redundant own comparison', async () => {
  const f = fixture({ rivals: [] }); let tree = await f.render();
  assert.deepEqual(f.requests.map(request => request.url), ['/api/club-rivals?region=TN']);
  assert.equal(ranking(tree).region, 'TN'); assert.equal(ranking(tree).tag, '#PYLQ');
  assert.equal(comparison(tree), undefined); assert.match(textContent(tree), /No rival clubs selected yet/);
  assert.match(textContent(tree), /An administrator can add the first club to compare/);
  assert.ok(elements(tree).some(node => node.type === 'Link' && node.props.href === '/admin?next=%2Frivals'));
  assert.equal(elements(tree).filter(node => node.props?.role === 'tab').length, 0);
  const refresh = elements(tree).find(node => node.type === 'Button' && textContent(node) === 'Refresh');
  refresh.props.onClick(); tree = await f.render(); f.update(); tree = await f.render();
  assert.equal(f.requests.length, 3); assert.ok(f.requests.every(request => request.url === '/api/club-rivals?region=TN'));
  assert.equal(comparison(tree), undefined); assert.equal(ranking(tree).region, 'TN');
});

test('adding the first followed club activates the own aggregate only after it is needed', async () => {
  const f = fixture({ rivals: [] }); await f.render();
  f.state.rivals = { ...f.state.rivals, rivals: [rival] }; f.update();
  const tree = await f.render();
  assert.equal(f.requests.filter(request => request.url.startsWith('/api/club-intelligence')).length, 1);
  assert.equal(comparison(tree).data.rivals.length, 1); assert.equal(comparison(tree).own.club.tag, '#PYLQ');
});

test('own aggregate errors expose an independent retry without reloading the ranking', async () => {
  let ownAttempts = 0;
  const f = fixture({ reply: (url, state) => {
    if (!url.startsWith('/api/club-intelligence')) return state.rivals;
    if (++ownAttempts === 1) throw new Error('Own aggregate unavailable');
    return state.own;
  } });
  let tree = await f.render(); assert.equal(comparison(tree).own, null); assert.equal(comparison(tree).ownError, true);
  assert.equal(ranking(tree).tag, '#PYLQ');
  comparison(tree).onRetryOwn(); tree = await f.render();
  assert.equal(comparison(tree).ownError, false); assert.equal(comparison(tree).own.club.rosterTrophies, 11111);
  assert.equal(f.requests.filter(request => request.url.startsWith('/api/club-rivals')).length, 1);
  assert.equal(f.requests.filter(request => request.url.startsWith('/api/club-intelligence')).length, 2);
  assert.equal(f.requests.at(-1).options.force, true);
});

test('a delayed previous-region response cannot overwrite the selected region or attach the wrong own club', async () => {
  const oldRegion = deferred();
  const f = fixture({ reply: (url, state) => {
    if (url.startsWith('/api/club-intelligence')) return state.own;
    if (url.includes('region=TN')) return oldRegion.promise;
    return { ...state.rivals, region: 'FR', clubTag: '#REPLACED', ranks: [{ region: 'FR', rank: 12 }] };
  } });
  let tree = await f.render(); assert.equal(ranking(tree), undefined);
  elements(tree).find(node => node.type === 'select' && node.props['aria-label'] === 'Region').props.onChange({ target: { value: 'FR' } });
  tree = await f.render(); assert.equal(ranking(tree).region, 'FR'); assert.equal(ranking(tree).tag, '#REPLACED');
  assert.equal(comparison(tree).own, null); assert.equal(comparison(tree).ownError, true);
  oldRegion.resolve(f.state.rivals); tree = await f.render();
  assert.equal(ranking(tree).region, 'FR'); assert.equal(ranking(tree).tag, '#REPLACED');
  assert.equal(ranking(tree).observations[0].rank, 12); assert.equal(comparison(tree).data.clubTag, '#REPLACED');
  assert.equal(comparison(tree).own, null);
});

test('a failed ranking refresh marks retained data stale and its retry preserves the independent comparison', async () => {
  let rankingAttempts = 0;
  const f = fixture({ reply: (url, state) => {
    if (url.startsWith('/api/club-intelligence')) return state.own;
    if (++rankingAttempts === 2) throw new Error('Ranking unavailable');
    return state.rivals;
  } });
  f.state.rivals.rankingStale = false;
  let tree = await f.render(); assert.equal(ranking(tree).rankingStale, false);
  f.update(); tree = await f.render();
  assert.equal(ranking(tree).rankingStale, true); assert.match(textContent(tree), /last successful load/);
  assert.equal(comparison(tree).own.club.rosterTrophies, 11111);
  const ownBefore = f.requests.filter(request => request.url.startsWith('/api/club-intelligence')).length;
  elements(tree).find(node => node.type === 'Button' && textContent(node) === 'Retry').props.onClick();
  tree = await f.render(); assert.equal(ranking(tree).rankingStale, false); assert.doesNotMatch(textContent(tree), /last successful load/);
  assert.equal(f.requests.filter(request => request.url.startsWith('/api/club-intelligence')).length, ownBefore);
});

test('an older own-club response stays hidden while the new club aggregate is still loading', async () => {
  const oldOwn = deferred(), newOwn = deferred(); let ownAttempts = 0;
  const f = fixture({ reply: (url, state) => url.startsWith('/api/club-intelligence') ? (++ownAttempts === 1 ? oldOwn.promise : newOwn.promise) : state.rivals });
  let tree = await f.render(); assert.equal(comparison(tree).own, null); assert.equal(comparison(tree).ownLoading, true);
  f.state.rivals = { ...f.state.rivals, clubTag: '#REPLACED' }; f.update(); tree = await f.render();
  assert.equal(comparison(tree).data.clubTag, '#REPLACED');
  oldOwn.resolve(f.state.own); tree = await f.render();
  assert.equal(comparison(tree).own, null); assert.equal(comparison(tree).ownLoading, true);
  newOwn.resolve({ ...f.state.own, club: { ...f.state.own.club, tag: '#REPLACED', rosterTrophies: 33333 } });
  tree = await f.render(); assert.equal(comparison(tree).own.club.tag, '#REPLACED');
  assert.equal(comparison(tree).own.club.rosterTrophies, 33333); assert.equal(comparison(tree).ownError, false);
});
