const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, elements, textContent } = require('./helpers/client-renderer.cjs');

function fixture() {
  const renderer = hookRenderer(), requests = [], listeners = new Map();
  const state = {
    rivals: { clubTag: '#PYLQ', region: 'global', rivals: [], ranks: [], rankingAt: null, rankingStale: true },
    own: { club: { tag: '#PYLQ', metadata: { name: 'Original club', requiredTrophies: 500 }, rosterTrophies: 11111, memberCount: 30, observedAt: '2026-09-16T12:00:00Z' }, strength: { medianTrophies: 222 } },
  };
  const surface = { visibilityState: 'visible', addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
  const Page = loadTypeScript('src/app/rivals/page.tsx', { ...componentMocks, react: renderer.react,
    '@/hooks/use-admin-session': { useAdminSession: () => ({ isAdmin: false }) }, '@/components/club-trend-line': { ClubTrendLine: 'Trend' },
    '@/lib/client-data-cache': { invalidateJsonCache() {}, fetchJsonCached: async (url, options) => {
      requests.push({ url, options }); return url.startsWith('/api/club-intelligence') ? state.own : state.rivals;
    } },
  }, { window: surface, document: surface }).default;
  return { state, requests, render: () => renderer.render(Page), update() {
    for (const listener of listeners.get('club-data-updated') || []) listener({ detail: { source: 'sync-status', datasets: ['roster'] } });
  } };
}
const ownRow = tree => elements(elements(tree).find(node => node.type === 'table')).filter(node => node.type === 'tr')[1];

test('automatic roster success refreshes an open rivals comparison without focus or navigation', async () => {
  const f = fixture(); let tree = await f.render(); assert.match(textContent(ownRow(tree)), /11,111/);
  f.state.own = { ...f.state.own, club: { ...f.state.own.club, rosterTrophies: 22222, memberCount: 29 } };
  f.update(); tree = await f.render();
  assert.equal(f.requests.length, 4); assert.ok(f.requests.slice(2).every(request => request.options.force === true));
  assert.match(textContent(ownRow(tree)), /22,222/); assert.doesNotMatch(textContent(ownRow(tree)), /11,111/);
});

test('independent old-club responses cannot populate the new club comparison row', async () => {
  const f = fixture(); await f.render();
  f.state.rivals = { ...f.state.rivals, clubTag: '#GGRR' }; f.update();
  let tree = await f.render(); let row = ownRow(tree);
  assert.match(textContent(row), /Your club#GGRR/); assert.doesNotMatch(textContent(row), /Original club|11,111|222|500/);
  assert.deepEqual(elements(row).filter(node => node.type === 'td').slice(1).map(textContent), ['—', '—', '—', '—']);
  f.state.own = { ...f.state.own, club: { ...f.state.own.club, tag: '#GGRR', metadata: { name: 'Replacement club', requiredTrophies: 0 }, rosterTrophies: 33333 } };
  f.update(); tree = await f.render(); row = ownRow(tree);
  assert.match(textContent(row), /Replacement club#GGRR/); assert.match(textContent(row), /33,333/);
});
