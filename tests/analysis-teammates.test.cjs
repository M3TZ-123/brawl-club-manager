const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, elements, textContent, action, i18n } = require('./helpers/client-renderer.cjs');
const pair = (id, values = {}) => ({ player1: { tag: `#A${id}`, name: `Player ${id}` }, player2: { tag: `#B${id}`, name: `Partner ${id}` },
  context: { key: 'ladder', label: 'Trophy matches' }, matches: 20, wins: 10, losses: 10, draws: 0, unknownResults: 0, winRate: 50, ...values });
const data = pairs => ({ pairs, period: { key: '7d', start: '2026-09-10T12:00:00Z', end: '2026-09-17T12:00:00Z' }, filters: { context: null, mode: null, map: null, brawler: null },
  limits: { truncated: false, groupCounts: { pairs: pairs.length } }, generatedAt: '2026-09-17T12:00:00Z' });
const control = (tree, name) => { const node = elements(tree).find(node => node.props?.['aria-label'] === name); assert.ok(node, name); return node; };
const cards = tree => elements(tree).filter(node => node.type === 'li');

function harness(initial, locale = 'en') {
  const renderer = hookRenderer(); let response = initial;
  const { translate } = loadTypeScript('src/lib/i18n/messages.ts');
  const { arAnalysisTeammates } = loadTypeScript('src/lib/i18n/ar-analysis-teammates.ts');
  const local = { ...i18n, t: (key, values = {}) => {
    const message = locale === 'ar' && arAnalysisTeammates[key] ? arAnalysisTeammates[key] : translate(key, locale);
    return message.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  } };
  const { AnalysisTeammates } = loadTypeScript('src/components/analysis-teammates.tsx', { ...componentMocks, react: renderer.react,
    '@/components/locale-provider': { useI18n: () => local },
  });
  return { setData: value => { response = value; }, render: () => renderer.render(() => AnalysisTeammates({ data: response })) };
}

test('teammate search checks either name or tag and filters without merging contexts or mutating source rows', () => {
  const { selectTeammatePairs } = loadTypeScript('src/lib/analysis-teammates.ts');
  const rows = [pair('ONE', { matches: 6 }), pair('TWO', { matches: 2 }), pair('ONE', { context: { key: 'ranked', label: 'Ranked' }, matches: 12 })];
  const original = JSON.stringify(rows);
  const select = (query, minimumMatches = 0) => selectTeammatePairs(rows, { query, minimumMatches, sort: 'matches' });
  assert.deepEqual(Array.from(select(' partner one '), row => row.context.key), ['ranked', 'ladder']);
  assert.deepEqual(Array.from(select('#bone', 10), row => row.matches), [12]);
  assert.deepEqual(Array.from(select('player two'), row => row.player1.tag), ['#ATWO']);
  assert.equal(select('#bmissing').length, 0);
  assert.equal(JSON.stringify(rows), original);
});

test('win-rate order prioritizes ten decided results and never ranks a one-match100percent record above qualified comparisons', () => {
  const { selectTeammatePairs, teammateWinRate } = loadTypeScript('src/lib/analysis-teammates.ts');
  const rows = [
    pair('TINY', { matches: 1, wins: 1, losses: 0, winRate: 100 }),
    pair('SOLID', { matches: 10, wins: 8, losses: 2, winRate: 80 }),
    pair('MORE', { matches: 30, wins: 20, losses: 10, winRate: 66.67 }),
    pair('DRAWS', { matches: 50, wins: 4, losses: 0, draws: 46, winRate: 100 }),
    pair('UNKNOWN', { matches: 100, wins: 0, losses: 0, unknownResults: 100, winRate: null }),
    pair('ZERO', { matches: 10, wins: 0, losses: 10, winRate: 0 }),
  ];
  const ordered = selectTeammatePairs(rows, { query: '', minimumMatches: 0, sort: 'win_rate' });
  assert.deepEqual(Array.from(ordered, row => row.player1.tag), ['#ASOLID', '#AMORE', '#AZERO', '#ADRAWS', '#ATINY', '#AUNKNOWN']);
  assert.equal(teammateWinRate(pair('NONE', { wins: 0, losses: 0, winRate: 0 })), null);
  assert.equal(teammateWinRate(pair('ZERO', { wins: 0, losses: 10, winRate: 0 })), 0);
  assert.equal(teammateWinRate(pair('INVALID', { winRate: 101 })), null);
});

test('teammate rows preserve contexts, zero versus unknown rates, small samples and only nonzero draws or unknown results', async () => {
  const source = data([
    pair('ONE', { matches: 10, wins: 0, losses: 10, winRate: 0, notes: 'PRIVATE_NOTES' }),
    pair('ONE', { context: { key: 'ranked', label: 'Ranked' }, matches: 4, wins: 1, losses: 0, draws: 2, unknownResults: 1, winRate: 100 }),
    pair('NONE', { matches: 1, wins: 0, losses: 0, unknownResults: 1, winRate: null }),
  ]);
  source.limits.groupCounts.pairs = 300;
  const page = harness(source); let tree = await page.render();
  assert.equal(cards(tree).length, 3);
  assert.match(textContent(tree), /3 matching teammate records/);
  assert.match(textContent(tree), /Loaded 3 of 300 teammate records/);
  assert.match(textContent(tree), /One row per teammate pair and battle type/);
  assert.match(textContent(cards(tree)[0]), /Win rate0%/);
  assert.doesNotMatch(textContent(cards(tree)[0]), /draws|unknown results|Small sample/);
  assert.match(textContent(cards(tree)[1]), /Ranked/);
  assert.match(textContent(cards(tree)[1]), /2 draws1 unknown results/);
  assert.match(textContent(cards(tree)[1]), /100%Small sample/);
  assert.match(textContent(cards(tree)[2]), /Win rateUnknownSmall sample/);
  assert.equal(elements(tree).filter(node => node.type === 'Link').length, 6);
  assert.ok(elements(tree).some(node => node.props?.href === '/members/%23BONE'));
  assert.doesNotMatch(textContent(tree), /PRIVATE_NOTES|best team|kick|inactive/i);
  control(tree, 'Sort teammates').props.onChange({ target: { value: 'win_rate' } }); tree = await page.render();
  assert.match(textContent(tree), /Ten results is a browsing threshold, not proof of stronger teamwork/);
});

test('pagination resets for filters and relevant pair data while a refresh timestamp alone preserves the selected page', async () => {
  const pairs = Array.from({ length: 27 }, (_, index) => pair(String(index).padStart(2, '0'), { matches: 40 - index }));
  const response = data(pairs); const page = harness(response); let tree = await page.render();
  assert.equal(cards(tree).length, 12);
  action(tree, 'Next')(); tree = await page.render();
  assert.match(textContent(tree), /Showing 13–24 of 27 teammate records/);
  page.setData({ ...response, pairs: response.pairs.map(row => ({ ...row })), generatedAt: '2026-09-17T12:10:00Z' }); tree = await page.render();
  assert.match(textContent(tree), /Showing 13–24 of 27 teammate records/);
  control(tree, 'Find a teammate').props.onChange({ target: { value: 'Partner 26' } }); tree = await page.render();
  assert.equal(cards(tree).length, 1);
  assert.match(textContent(cards(tree)[0]), /Player 26/);
  action(tree, 'Clear teammate filters')(); tree = await page.render();
  assert.match(textContent(tree), /Showing 1–12 of 27 teammate records/);
  action(tree, 'Next')(); tree = await page.render();
  control(tree, 'Sort teammates').props.onChange({ target: { value: 'win_rate' } }); tree = await page.render();
  assert.match(textContent(tree), /Showing 1–12 of 27 teammate records/);
  action(tree, 'Next')(); tree = await page.render();
  control(tree, 'Minimum shared matches').props.onChange({ target: { value: '10' } }); tree = await page.render();
  assert.match(textContent(tree), /Showing 1–12 of 27 teammate records/);
  action(tree, 'Next')(); tree = await page.render();
  page.setData({ ...response, pairs: [{ ...pairs[0], matches: 41 }, ...pairs.slice(1)] }); tree = await page.render();
  assert.match(textContent(tree), /Showing 1–12 of 27 teammate records/);
});

test('empty searches remain distinct from absent recorded pairs and Arabic controls have readable labels', async () => {
  const empty = harness(data([])); assert.match(textContent(await empty.render()), /No confirmed teammate pairs in these records/);
  const searched = harness(data([pair('A')])); let tree = await searched.render();
  control(tree, 'Find a teammate').props.onChange({ target: { value: 'Nobody' } }); tree = await searched.render();
  assert.match(textContent(tree), /No teammate records match these filters/);
  assert.doesNotMatch(textContent(tree), /No confirmed teammate pairs in these records/);
  const arabic = harness(data([pair('A', { wins: 1, losses: 0, matches: 1, winRate: 100 })]), 'ar');
  tree = await arabic.render();
  for (const label of ['البحث عن زميل', 'ترتيب الثنائيات', 'الأكثر لعبًا معًا', 'عينة صغيرة', 'المباريات المشتركة']) assert.ok(textContent(tree).includes(label), label);
  assert.doesNotMatch(textContent(tree), /Find a teammate|Small sample|Sort teammates/);
});
