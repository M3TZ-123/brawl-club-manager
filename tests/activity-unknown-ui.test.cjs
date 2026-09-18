const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, windowMock, elements, textContent, action, i18n } = require('./helpers/client-renderer.cjs');

const unknownMember = { player_tag: '#NEW', player_name: 'New member', role: 'member', trophies: 1000, highest_trophies: 1000,
  activity_status: 'unknown', trio_victories: 0, solo_victories: 0, duo_victories: 0 };
const summary = { totalMembers: 3, totalTrophies: 3000, avgTrophies: 1000, activeMembers: 1, unknownActivityMembers: 2 };

test('dashboard activity card distinguishes unknown activity from the inactive remainder and translates it', async () => {
  const renderer = hookRenderer();
  const { StatsCards } = loadTypeScript('src/components/stats-cards.tsx', { ...componentMocks, react: { ...renderer.react, memo: value => value } });
  const tree = await renderer.render(() => StatsCards(summary));
  assert.match(textContent(tree), /33% active.*Activity unknown: 2/);
  assert.doesNotMatch(textContent(tree), /Inactive/);
  const complete = await renderer.render(() => StatsCards({ ...summary, unknownActivityMembers: 0 }));
  assert.doesNotMatch(textContent(complete), /Activity unknown/);
  const { translate } = loadTypeScript('src/lib/i18n/messages.ts');
  assert.equal(translate('Activity unknown: {count}', 'ar', { count: '2' }), 'النشاط غير معروف: 2');
});

test('a dashboard attention row with missing activity never labels the member Active', async () => {
  const renderer = hookRenderer();
  const Page = loadTypeScript('src/app/page.tsx', {
    ...componentMocks, react: renderer.react,
    '@/components/time-range-picker': { TimeRangePicker: 'TimeRangePicker' },
    '@/components/setup-wizard': { SetupWizard: 'SetupWizard' },
    '@/lib/store': { useAppStore: () => ({ clubTag: '#CLUB', apiKeyConfigured: true, lastSyncTime: '2026-09-18T12:00:00Z', hasLoadedSettings: true, isLoadingSettings: false, loadSettingsFromDB() {} }) },
    '@/lib/client-data-cache': { fetchJsonCached: async url => url.startsWith('/api/dashboard')
      ? { summary, attentionMembers: [unknownMember], topMembers: [], topGainers: [], recentEvents: [], changeSummary: {} }
      : { insights: { totalBattlesThisWeek: 0, totalWins: 0, thisWeekTotal: 0, prevWeekTotal: 0, trendDiff: 0, winRate: 0 } } },
  }, { window: windowMock }).default;
  const tree = await renderer.render(Page);
  assert.equal(elements(tree).find(node => node.type === 'StatsCards').props.unknownActivityMembers, 2);
  const signal = elements(tree).find(node => node.type?.name === 'MemberSignalList' && node.props.attention);
  const row = signal.type(signal.props);
  assert.match(textContent(row), /Unknown/);
  assert.doesNotMatch(textContent(row), /Active|Inactive/);
});

test('member profile exposes a translated unknown activity label rather than raw status or inactivity', async () => {
  const renderer = hookRenderer();
  const { translate } = loadTypeScript('src/lib/i18n/messages.ts');
  const Page = loadTypeScript('src/app/members/[tag]/page.tsx', {
    ...componentMocks, react: { ...renderer.react, use: value => value }, 'next/dynamic': () => 'Dynamic',
    '@/components/player-progress': { PlayerProgress: 'PlayerProgress' },
    '@/components/membership-timeline': { MembershipTimeline: 'MembershipTimeline' },
    '@/hooks/use-admin-session': { useAdminSession: () => ({ isAdmin: false }) },
    '@/components/locale-provider': { ...componentMocks['@/components/locale-provider'], useI18n: () => ({ ...i18n, t: (text, values) => translate(text, 'ar', values) }) },
    '@/lib/client-data-cache': { fetchJsonCached: async () => ({ member: unknownMember }) },
  }, { window: windowMock }).default;
  const tree = await renderer.render(() => Page({ params: { tag: '%23NEW' } }));
  const status = elements(tree).find(node => node.props?.['aria-label'] === translate('Unknown', 'ar'));
  assert.ok(status);
  assert.equal(status.props.title, translate('Unknown', 'ar'));
  assert.match(elements(status).find(node => node.type === 'Circle').props.className, /text-muted-foreground/);
});

test('activity filters preserve unknown members separately from known inactive members', async () => {
  const renderer = hookRenderer();
  const entries = ['unknown', 'inactive'].map((activityStatus, index) => ({ tag: `#${index}`, name: activityStatus, role: 'member', trophies: 1000,
    activityStatus, lastBattleAt: null, weekly: { battles: 0, wins: 0, losses: 0, starPlayer: 0, activeDays: 0, winRate: 0, netTrophies: null } }));
  const leaderboards = Object.fromEntries(['trophyLeaders', 'weeklyBattlers', 'weeklyWinRate', 'weeklyTrophyGainers', 'weeklyStarPlayers', 'mostActive'].map(key => [key, entries]));
  const Page = loadTypeScript('src/app/activity/page.tsx', {
    ...componentMocks, react: { ...renderer.react, memo: value => value },
    '@/components/ui/tabs': Object.fromEntries(['Tabs', 'TabsList', 'TabsContent', 'TabsTrigger'].map(key => [key, key])),
    '@/components/ui/table': Object.fromEntries(['Table', 'TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow'].map(key => [key, key])),
    '@/lib/client-data-cache': { fetchJsonCached: async () => ({ leaderboards, memberCount: 2 }) },
  }, { window: windowMock }).default;
  let tree = await renderer.render(Page);
  action(tree, 'Member rankings')(); tree = await renderer.render(Page);
  const select = elements(tree).find(node => node.type === 'select' && elements(node).some(option => option.props?.value === 'unknown'));
  assert.ok(select);
  assert.equal(textContent(elements(select).find(node => node.type === 'option' && node.props.value === 'unknown')), 'No data');
  select.props.onChange({ target: { value: 'unknown' } }); tree = await renderer.render(Page);
  const podium = elements(tree).find(node => node.type?.name === 'Podium');
  assert.deepEqual(Array.from(podium.props.members, row => row.activityStatus), ['unknown']);
});

test('report charts and exported summary retain unknown activity instead of adding it to inactivity', async () => {
  const renderer = hookRenderer(), downloads = [];
  const Page = loadTypeScript('src/app/reports/page.tsx', {
    ...componentMocks, react: renderer.react, 'next/dynamic': () => 'Dynamic',
    '@/lib/client-data-cache': { fetchJsonCached: async () => ({
      generatedAt: '2026-09-18T12:00:00Z', period: { start: '2026-09-11', end: '2026-09-18' },
      summary: { ...summary, activityRate: 33, weeklyWins: 0, weeklyBattles: 0, weeklyWinRate: 0 },
      topGainers: [], topLosers: [], activityDistribution: { active: 1, minimal: 0, inactive: 0, unknown: 2 }, trophyTrend: [], recentEvents: [],
    }) },
  }, { window: windowMock, Blob, URL: { createObjectURL: value => { downloads.push(value); return 'blob:fixture'; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {} }) } }).default;
  let tree = await renderer.render(Page);
  assert.match(textContent(tree), /Activity unknown: 2/);
  elements(tree).find(node => node.type === 'details' && node.props.onToggle).props.onToggle({ currentTarget: { open: true } }); tree = await renderer.render(Page);
  const pie = elements(tree).find(node => node.type === 'Dynamic' && node.props.data);
  assert.equal(pie.props.data.find(row => row.name === 'Unknown').value, 2);
  assert.equal(pie.props.data.find(row => row.name === 'Inactive').value, 0);
  const exportButton = elements(tree).find(node => node.props?.onClick && /Export/.test(textContent(node)));
  exportButton.props.onClick();
  assert.match(await downloads[0].text(), /Activity unknown: 2/);
});
