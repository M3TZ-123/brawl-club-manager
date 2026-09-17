const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, windowMock, elements, textContent, action } = require('./helpers/client-renderer.cjs');
const mocks = { ...componentMocks,
  'next/dynamic': () => 'Chart',
  '@/components/club-report-card': { ClubReportCard: 'ReportImage' },
  '@/components/club-growth': { ClubGrowth: 'Growth' },
  '@/components/club-activity-calendar': { ClubActivityCalendar: 'Calendar' },
  '@/components/time-range-picker': { TimeRangePicker: 'PeriodPicker' },
  '@/components/ui/tabs': Object.fromEntries(['Tabs', 'TabsContent', 'TabsList', 'TabsTrigger'].map(name => [name, name])),
  '@/components/ui/table': Object.fromEntries(['Table', 'TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow'].map(name => [name, name])),
};
const report = (name = 'Current player') => ({ generatedAt: '2026-09-17T00:15:00Z', period: { start: '2026-09-17T00:00:00Z', end: '2026-09-17T00:15:00Z' },
  summary: { totalMembers: 1, totalTrophies: 1000, avgTrophies: 1000, activeMembers: 1, activityRate: 100, weeklyWins: 0, weeklyBattles: 0, weeklyWinRate: 0 },
  topGainers: [{ playerTag: '#PLAYER', playerName: name, trophyChange: 50 }], topLosers: [], recentEvents: [], trophyTrend: [],
  activityDistribution: { active: 1, minimal: 0, inactive: 0 }, trophyChange: { marker: name } });
function reportHarness(search, fetch) {
  const renderer = hookRenderer(), urls = [], downloads = [], listeners = new Map();
  const Page = loadTypeScript('src/app/reports/page.tsx', { ...mocks, react: renderer.react,
    '@/lib/client-data-cache': { fetchJsonCached: async url => { urls.push(url); return fetch ? fetch(url) : report(); }, invalidateJsonCache() {} },
  }, { window: { ...windowMock, location: { search }, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) }, Blob: class { constructor(parts) { this.text = parts.join(''); } },
    URL: { createObjectURL(blob) { downloads.push(blob.text); return 'blob:test'; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {} }) } });
  return { render: () => renderer.render(Page.default), urls, downloads, listeners };
}

test('reports honor linked periods before the first request and default malformed periods to seven days', async () => {
  for (const [query, range] of [['?range=30d', '30d'], ['?range=90d', '90d'], ['?range=all', '7d'], ['', '7d']]) {
    const page = reportHarness(query), tree = await page.render();
    assert.deepEqual(page.urls, [`/api/reports/weekly?range=${range}`]);
    assert.equal(elements(tree).find(node => node.type === 'PeriodPicker').props.value, range);
  }
});

test('a delayed linked-period report cannot populate or export the newly selected period', async () => {
  let finishOld;
  const page = reportHarness('?range=30d', url => url.includes('30d') ? new Promise(resolve => { finishOld = resolve; }) : report('New period player'));
  let tree = await page.render();
  elements(tree).find(node => node.type === 'PeriodPicker').props.onChange('90d'); tree = await page.render();
  assert.match(textContent(tree), /New period player/);
  assert.equal(elements(tree).find(node => node.type === 'Growth').props.data.marker, 'New period player');
  finishOld(report('Old period player')); tree = await page.render();
  assert.doesNotMatch(textContent(tree), /Old period player/);
  assert.equal(elements(tree).find(node => node.type === 'Growth').props.data.marker, 'New period player');
  elements(tree).find(node => node.type === 'Button' && node.props['aria-label'] === 'Export').props.onClick();
  assert.match(page.downloads[0], /New period player/); assert.doesNotMatch(page.downloads[0], /Old period player/);
});

test('changing report period clears existing trophy changes until the matching response arrives', async () => {
  let finish;
  const page = reportHarness('?range=7d', url => url.includes('7d') ? report('Seven-day player') : new Promise(resolve => { finish = resolve; }));
  let tree = await page.render();
  assert.equal(elements(tree).find(node => node.type === 'Growth').props.data.marker, 'Seven-day player');
  elements(tree).find(node => node.type === 'PeriodPicker').props.onChange('30d'); tree = await page.render();
  assert.equal(elements(tree).some(node => node.type === 'Growth'), false);
  assert.doesNotMatch(textContent(tree), /Seven-day player/);
  assert.equal(elements(tree).find(node => node.type === 'Button' && node.props['aria-label'] === 'Export').props.disabled, true);
  finish(report('Monthly player')); tree = await page.render();
  assert.equal(elements(tree).find(node => node.type === 'Growth').props.data.marker, 'Monthly player');
  assert.match(textContent(tree), /Monthly player/);
});

test('today report explicitly separates rolling account progress in the page and HTML export', async () => {
  const page = reportHarness('?range=24h'), tree = await page.render();
  assert.equal(elements(tree).find(node => node.type === 'PeriodPicker').props.dayBased, true);
  assert.match(textContent(tree), /Account trophy change · Last 24 hours/);
  elements(tree).find(node => node.type === 'Button' && node.props['aria-label'] === 'Export').props.onClick();
  assert.match(page.downloads[0], /Account trophy change · Last 24 hours/);
  assert.match(page.downloads[0], /\(UTC\)/);
});

test('report clears the previous club immediately while its replacement read is still pending', async () => {
  let calls = 0, finish;
  const page = reportHarness('', () => ++calls === 1 ? report('Previous club') : new Promise(resolve => { finish = resolve; }));
  let tree = await page.render(); assert.match(textContent(tree), /Previous club/);
  assert.equal(elements(tree).find(node => node.type === 'Growth').props.data.marker, 'Previous club');
  page.listeners.get('club-data-updated')({ detail: { clubChanged: true } });
  tree = await page.render(); assert.doesNotMatch(textContent(tree), /Previous club/);
  assert.equal(elements(tree).some(node => node.type === 'Growth'), false);
  assert.equal(elements(tree).find(node => node.type === 'Button' && node.props['aria-label'] === 'Export').props.disabled, true);
  finish(report('Replacement club')); tree = await page.render(); assert.match(textContent(tree), /Replacement club/);
  assert.equal(elements(tree).find(node => node.type === 'Growth').props.data.marker, 'Replacement club');
});

function activityHarness(members) {
  const renderer = hookRenderer(), children = new Map(); let active = renderer;
  const react = new Proxy({}, { get: (_, key) => key === 'memo' ? component => component : (...args) => active.react[key](...args) });
  const boards = Object.fromEntries(['trophyLeaders', 'weeklyBattlers', 'weeklyWinRate', 'weeklyTrophyGainers', 'weeklyStarPlayers', 'mostActive'].map(key => [key,
    key === 'trophyLeaders' || key === 'weeklyBattlers' ? members : key === 'weeklyTrophyGainers' ? members.filter(m => m.weekly.netTrophies != null && m.weekly.netTrophies !== 0) : []]));
  const Page = loadTypeScript('src/app/activity/page.tsx', { ...mocks, react,
    '@/lib/client-data-cache': { fetchJsonCached: async () => ({ memberCount: members.length, leaderboards: boards }) },
  }, { window: windowMock }).default;
  return {
    async render() { active = renderer; let tree = await renderer.render(Page); if (!elements(tree).some(node => node.type === 'Tabs')) { action(tree, 'Member rankings')(); tree = await renderer.render(Page); } return tree; },
    async child(element) {
      const slot = element.type.name;
      if (children.get(slot)?.key !== element.key) children.set(slot, { key: element.key, renderer: hookRenderer() });
      active = children.get(slot).renderer; return active.render(() => element.type(element.props));
    },
  };
}
const player = (index, netTrophies = null) => ({ tag: `#P${index}`, name: `Player${String(index).padStart(2, '0')}`, role: 'member', trophies: 1000, highestTrophies: 1200,
  weekly: { netTrophies, battles: 1, wins: 1, losses: 0, starPlayer: 0, activeDays: 1, winRate: 100 } });
const categoryChild = (tree, category, name) => elements(elements(tree).find(node => node.type === 'TabsContent' && node.props.value === category)).find(node => node.type?.name === name);

test('ranking empty states distinguish missing account baselines, observed zero progress and a battle qualification threshold', async () => {
  for (const [progress, expected] of [[null, /Not enough history/], [0, /No trophy change recorded/]]) {
    const page = activityHarness([player(1, progress)]), tree = await page.render();
    assert.match(textContent(await page.child(categoryChild(tree, 'weeklyTrophyGainers', 'Podium'))), expected);
    assert.match(textContent(await page.child(categoryChild(tree, 'weeklyWinRate', 'Podium'))), /No members have enough recorded battles/);
    assert.equal(categoryChild(tree, 'weeklyBattlers', 'Podium').props.members.length, 1);
  }
});

test('filtering a later ranking page starts at the first matching results instead of silently skipping them', async () => {
  const page = activityHarness(Array.from({ length: 30 }, (_, i) => player(i, 30 - i)));
  let tree = await page.render(), table = await page.child(categoryChild(tree, 'weeklyTrophyGainers', 'LeaderboardTable'));
  action(table, 'Next')(); table = await page.child(categoryChild(tree, 'weeklyTrophyGainers', 'LeaderboardTable'));
  assert.match(textContent(table), /Player13/); assert.doesNotMatch(textContent(table), /Player03/);
  elements(tree).find(node => node.type === 'input' && node.props['aria-label'] === 'Search player or tag').props.onChange({ target: { value: 'Player0' } });
  tree = await page.render(); table = await page.child(categoryChild(tree, 'weeklyTrophyGainers', 'LeaderboardTable'));
  assert.match(textContent(table), /Player03/);
  action(tree, 'Reset')(); tree = await page.render(); table = await page.child(categoryChild(tree, 'weeklyTrophyGainers', 'LeaderboardTable'));
  assert.match(textContent(table), /Player03/); assert.doesNotMatch(textContent(table), /Player13/);
});

test('history counts an observed return even when the old join count is unknown', async () => {
  const renderer = hookRenderer();
  const Page = loadTypeScript('src/app/history/page.tsx', { ...mocks, react: renderer.react,
    '@/hooks/use-admin-session': { useAdminSession: () => ({ isAdmin: false, isLoading: false }) },
  }, { window: windowMock, fetch: async () => Response.json({ history: [
    { player_tag: '#RETURNED', player_name: 'Returned player', is_current_member: true, times_joined: null, times_left: 1 },
    { player_tag: '#UNKNOWN', player_name: 'Unknown history', is_current_member: true, times_joined: null, times_left: null },
  ] }) }).default;
  const tree = await renderer.render(Page);
  assert.match(textContent(tree), /Previously returned: 1 of these members/);
  const current = elements(tree).find(node => node.type === 'div' && elements(node).some(child => child.type === 'dt' && textContent(child) === 'Current in results') && elements(node).filter(child => child.type === 'dd').length === 1);
  assert.equal(textContent(elements(current).find(node => node.type === 'dd')), '2');
});

test('calendar and daily report ranges use the same UTC dates on both sides of midnight and leap day', () => {
  const { buildClubIntelligence } = loadTypeScript('src/lib/club-intelligence.ts');
  const { getReportingPeriod } = loadTypeScript('src/lib/reporting-period.ts');
  const raw = { clubTag: '#CLUB', profile: null, members: [], daily: [], coverage: [], gaps: [], snapshots: [], events: [], metadataHistory: [] };
  for (const instant of ['2026-09-16T23:59:59.999Z', '2026-09-17T00:00:00.000Z', '2024-03-01T00:15:00+02:00']) {
    const now = new Date(instant);
    assert.deepEqual(Array.from(buildClubIntelligence(raw, '7d', now).calendar.days), Array.from(getReportingPeriod('7d', now).dates));
  }
});

test('feature views preserve transient failures but discard old-club data at a roster boundary', async () => {
  const renderer = hookRenderer(), listeners = new Map();
  let status = 200, body = { members: ['Old club player'] }, pending;
  const events = { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  const { useFeatureResource } = loadTypeScript('src/components/use-feature-resource.ts', { react: renderer.react }, {
    window: events, document: { ...events, visibilityState: 'visible' },
    fetch: async () => pending || Response.json(body, { status }),
  });
  const render = () => renderer.render(() => useFeatureResource('/api/readiness?limit=24', 'roster'));
  let resource = await render(); assert.deepEqual(Array.from(resource.data.members), ['Old club player']);
  status = 503; body = { error: 'Temporary failure' };
  await resource.reload(); resource = await render();
  assert.equal(resource.error, true); assert.deepEqual(Array.from(resource.data.members), ['Old club player']);
  status = 409; body = { error: 'The club roster is awaiting a successful sync.' };
  await resource.reload(); resource = await render();
  assert.equal(resource.error, true); assert.equal(resource.data, null);
  status = 200; body = { members: ['New club player'] };
  await resource.reload(); resource = await render();
  assert.deepEqual(Array.from(resource.data.members), ['New club player']);
  let finish;
  pending = new Promise(resolve => { finish = resolve; });
  listeners.get('club-data-updated')({ detail: { clubChanged: true, datasets: ['roster'] } });
  resource = await render(); assert.equal(resource.data, null); assert.equal(resource.loading, true);
  finish(Response.json({ members: ['Latest club player'] }));
  resource = await render(); assert.deepEqual(Array.from(resource.data.members), ['Latest club player']);
});
