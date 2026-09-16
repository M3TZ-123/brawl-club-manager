const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, windowMock, elements, textContent, action } = require('./helpers/client-renderer.cjs');

const mocks = {
  ...componentMocks,
  'next/dynamic': () => 'Chart',
  '@/components/time-range-picker': { TimeRangePicker: 'PeriodPicker' },
  '@/components/club-activity-calendar': { ClubActivityCalendar: 'Calendar' },
  '@/components/club-growth-period': { ClubGrowthPeriod: 'GrowthPeriod' },
  '@/components/club-report-card': { ClubReportCard: 'ReportImage' },
  '@/components/ui/tabs': Object.fromEntries(['Tabs', 'TabsContent', 'TabsList', 'TabsTrigger'].map(name => [name, name])),
  '@/components/ui/table': Object.fromEntries(['Table', 'TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow'].map(name => [name, name])),
};
const visibleText = tree => {
  if (tree == null) return '';
  if (Array.isArray(tree)) return tree.map(visibleText).join('');
  if (typeof tree !== 'object') return String(tree);
  if (tree.type === 'details' && !tree.props.open) return visibleText(elements(tree.props.children).find(node => node.type === 'summary'));
  if (tree.type === 'T') return textContent(tree);
  return visibleText(tree.props?.children);
};
const disclosure = (tree, title) => elements(tree).find(node => node.type === 'details' && textContent(elements(node.props.children).find(child => child.type === 'summary')) === title);

test('activity chooses one workflow at a time and preserves its independent periods', async () => {
  const renderer = hookRenderer(), requests = [];
  const boards = Object.fromEntries(['trophyLeaders', 'weeklyBattlers', 'weeklyWinRate', 'weeklyTrophyGainers', 'weeklyStarPlayers', 'mostActive'].map(key => [key, []]));
  const Page = loadTypeScript('src/app/activity/page.tsx', { ...mocks, react: { ...renderer.react, memo: component => component },
    '@/lib/client-data-cache': { fetchJsonCached: async url => { requests.push(url); return { leaderboards: boards, memberCount: 0 }; } },
  }, { window: windowMock }).default;
  let tree = await renderer.render(Page);
  assert.equal(requests.length, 0); assert.equal(elements(tree).find(node => node.type === 'Calendar').props.range, '7d');
  assert.equal(elements(tree).some(node => node.type === 'PeriodPicker' || node.type === 'Tabs'), false);
  elements(tree).find(node => node.type === 'select').props.onChange({ target: { value: '90d' } }); tree = await renderer.render(Page);
  action(tree, 'Member rankings')(); tree = await renderer.render(Page);
  assert.equal(requests[0], '/api/leaderboard?range=7d'); assert.equal(elements(tree).some(node => node.type === 'Calendar'), false);
  elements(tree).find(node => node.type === 'PeriodPicker').props.onChange('30d'); tree = await renderer.render(Page);
  assert.equal(requests.at(-1), '/api/leaderboard?range=30d');
  action(tree, 'Daily activity')(); tree = await renderer.render(Page);
  assert.equal(elements(tree).find(node => node.type === 'Calendar').props.range, '90d');
  action(tree, 'Member rankings')(); tree = await renderer.render(Page);
  assert.equal(elements(tree).find(node => node.type === 'PeriodPicker').props.value, '30d');
});

test('report and roster growth periods stay separate and responsive charts only mount in an open panel', async () => {
  const renderer = hookRenderer();
  const report = { generatedAt: '2026-09-17T12:00:00Z', period: { start: '2026-09-11', end: '2026-09-17' },
    summary: { totalMembers: 30, totalTrophies: 90000, avgTrophies: 3000, activeMembers: 10, activityRate: 33, weeklyWins: 5, weeklyBattles: 10, weeklyWinRate: 50 },
    activityDistribution: { active: 10, minimal: 10, inactive: 10 }, topGainers: [], topLosers: [], recentEvents: [],
    trophyTrend: [{ date: '2026-09-16', trophies: null }, { date: '2026-09-17', trophies: 90000 }] };
  const Page = loadTypeScript('src/app/reports/page.tsx', { ...mocks, react: renderer.react,
    '@/lib/client-data-cache': { fetchJsonCached: async () => report },
  }, { window: windowMock }).default;
  let tree = await renderer.render(Page);
  assert.equal(elements(tree).some(node => node.type === 'Chart' || node.type === 'GrowthPeriod'), false);
  assert.ok(elements(tree).some(node => node.type === 'ReportImage'));
  elements(tree).find(node => node.type === 'PeriodPicker').props.onChange('30d'); tree = await renderer.render(Page);
  disclosure(tree, 'Charts and current roster details').props.onToggle({ currentTarget: { open: true } }); tree = await renderer.render(Page);
  assert.equal(disclosure(tree, 'Charts and current roster details').props.open, true);
  assert.equal(elements(tree).filter(node => node.type === 'Chart').length, 2);
  const trophyChart = elements(tree).find(node => node.type === 'Chart' && node.props.points);
  assert.equal(trophyChart.props.points[0].trophies, null); assert.equal(trophyChart.props.dayBased, true);
  action(tree, 'Roster growth')(); tree = await renderer.render(Page);
  assert.equal(elements(tree).some(node => node.type === 'PeriodPicker' || node.type === 'Chart' || node.type === 'ReportImage'), false);
  elements(tree).find(node => node.type === 'GrowthPeriod').props.onChange('90d'); tree = await renderer.render(Page);
  action(tree, 'Period report')(); tree = await renderer.render(Page);
  assert.equal(elements(tree).find(node => node.type === 'PeriodPicker').props.value, '30d');
  assert.equal(disclosure(tree, 'Charts and current roster details').props.open, true);
  disclosure(tree, 'Charts and current roster details').props.onToggle({ currentTarget: { open: false } }); tree = await renderer.render(Page);
  assert.equal(elements(tree).some(node => node.type === 'Chart'), false);
  action(tree, 'Roster growth')(); tree = await renderer.render(Page);
  assert.equal(elements(tree).find(node => node.type === 'GrowthPeriod').props.range, '90d');
});

test('calendar keeps uncertainty visible while its explanatory legend starts collapsed', async () => {
  const renderer = hookRenderer();
  const calendar = { observedParticipations: 3, recordedDays: 1, days: ['2026-09-16'], rows: [{ playerTag: '#PYLQ', playerName: 'Player', cells: [
    { day: '2026-09-16', battles: 3, coverage: 'possible_gap', href: '/battle-feed?member=%23PYLQ&day=2026-09-16' },
  ] }] };
  const { ClubActivityCalendar } = loadTypeScript('src/components/club-activity-calendar.tsx', { ...mocks, react: renderer.react,
    '@/components/club-intelligence-panel': { ClubIntelligencePanel: 'Panel', useClubIntelligence: () => ({ data: { calendar } }) },
  });
  const tree = await renderer.render(() => ClubActivityCalendar({ range: '7d' }));
  assert.match(visibleText(tree), /Possible history gaps are marked in amber/); assert.match(visibleText(tree), /— means unknown/);
  assert.doesNotMatch(visibleText(tree), /Gap checks cover 28 days/);
  assert.match(textContent(disclosure(tree, 'Reading this calendar')), /not proof of no play|Gap checks cover 28 days/);
  assert.equal(elements(tree).find(node => node.props?.href?.startsWith('/battle-feed')).props.href, calendar.rows[0].cells[0].href);
});

test('trend disclosure preserves actual timestamps and separates unknown observations', () => {
  const { ClubTrendLine } = loadTypeScript('src/components/club-trend-line.tsx', componentMocks);
  const tree = ClubTrendLine({ label: 'Observed trend', points: [
    { at: '2026-09-14T10:30:00Z', value: 100 }, { at: '2026-09-15T15:00:00Z', value: null }, { at: '2026-09-16T12:45:00Z', value: 200 },
  ] });
  assert.equal(tree.type, 'details'); assert.equal(tree.props.open, undefined);
  assert.equal(visibleText(tree), 'Observed trend'); assert.equal(elements(tree).filter(node => node.type === 'polyline').length, 2);
  assert.match(textContent(tree), /2026-09-14T10:30:00Z/); assert.match(textContent(tree), /2026-09-16T12:45:00Z/);
});

test('analytics simplification labels have Arabic translations', () => {
  const dictionary = loadTypeScript('src/lib/i18n/ar-ux-analytics.ts').default;
  for (const key of ['Daily activity', 'Member rankings', 'Reading this calendar', 'Roster growth', 'Period report', 'How retention is counted', 'Understanding member history'])
    assert.match(dictionary[key], /[\u0600-\u06ff]/);
});
