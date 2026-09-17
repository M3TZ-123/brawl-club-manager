const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, elements, textContent, action, i18n } = require('./helpers/client-renderer.cjs');

const profile = { tag: '#RIVAL', name: '<c2>Rival club</c>', description: '<c3>A club description</c>', rosterTrophies: 4000, memberCount: 20, medianTrophies: 180, requiredTrophies: 0 };
const rival = overrides => ({ tag: '#RIVAL', profile, fetchedAt: '2026-09-18T12:00:00Z', stale: false, refreshing: false,
  history: [{ at: '2026-09-17T12:00:00Z', trophies: 1400 }, { at: '2026-09-18T12:00:00Z', trophies: 1500 }], ...overrides });
const response = rivals => ({ clubTag: '#OWN', region: 'global', rivals, ranks: [], rankingAt: '2026-09-18T12:00:00Z', rankingStale: false });
const own = { club: { tag: '#OWN', metadata: { name: '<c2>Our club</c>' }, observedAt: '2026-09-18T11:00:00Z', rosterTrophies: 9000, memberCount: 30 }, strength: { medianTrophies: 250 } };
function harness(overrides = {}, locale = 'en') {
  const renderer = hookRenderer(), removed = [], retries = [];
  let clock = Date.parse('2026-09-18T13:00:00Z'), nextTimer = 0;
  const timers = new Map();
  class ClockDate extends Date { static now() { return clock; } }
  let props = { data: response([rival()]), own, ownLoading: false, ownError: false, onRetryOwn: () => retries.push(true), isAdmin: true, saving: false, onUnfollow: tag => removed.push(tag), ...overrides };
  const { translate } = loadTypeScript('src/lib/i18n/messages.ts');
  const { arRivalsComparison } = loadTypeScript('src/lib/i18n/ar-rivals-comparison.ts');
  const t = (key, values = {}) => (locale === 'ar' && arRivalsComparison[key] ? arRivalsComparison[key] : translate(key, locale))
    .replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  const { ClubRivalsComparison } = loadTypeScript('src/components/club-rivals-comparison.tsx', {
    ...componentMocks, react: renderer.react,
    '@/components/locale-provider': { useI18n: () => ({ ...i18n, t, direction: locale === 'ar' ? 'rtl' : 'ltr' }) },
    '@/components/club-trend-line': { ClubTrendLine: 'ClubTrendLine' },
    '@/components/club-ranking-summary': { ClubRankingSummary: 'ClubRankingSummary' },
  }, { Date: ClockDate, setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  return { removed, retries, setClock: value => { clock = Date.parse(value); }, setProps: values => { props = { ...props, ...values }; }, render: async () => {
    let tree = await renderer.render(() => ClubRivalsComparison(props));
    while (timers.size) {
      const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback());
      tree = await renderer.render(() => ClubRivalsComparison(props));
    }
    return tree;
  } };
}
const dataRows = tree => elements(tree).filter(node => node.type === 'tr' && elements(node).some(child => child.type === 'th' && child.props.scope === 'row'));
const expand = tree => elements(tree).find(node => node.type === 'Button' && node.props['aria-expanded'] === false).props.onClick();

test('comparison shows each club once in four columns with current-club emphasis, timestamps and contained horizontal scrolling', async () => {
  const page = harness({ data: response([rival(), rival()]) }); const tree = await page.render();
  assert.deepEqual(elements(tree).filter(node => node.type === 'th' && node.props.scope === 'col').map(textContent), ['Club', 'Roster trophies', 'Members', 'Median trophies']);
  const rows = dataRows(tree); assert.equal(rows.length, 2);
  assert.equal(rows[0].props['data-current-club'], true);
  assert.match(rows[0].props.className, /bg-primary/);
  assert.match(textContent(rows[0]), /Our club/);
  assert.match(textContent(rows[0]), /2026-09-18T11:00:00Z/);
  assert.match(textContent(rows[1]), /2026-09-18T12:00:00Z/);
  assert.equal(textContent(tree).split('Rival club').length - 1, 1);
  assert.doesNotMatch(textContent(tree), /<c2>|All observations|Required trophies/);
  const region = elements(tree).find(node => node.props.role === 'region');
  assert.equal(region.props['aria-label'], 'Club roster comparison');
  assert.equal(region.props.tabIndex, 0);
  assert.match(region.props.className, /max-w-full.*overflow-x-auto/);
});

test('own-club loading, failed reads and mismatched tags never show another club values or fabricated zeros', async () => {
  const page = harness({ own: null, ownLoading: true }); let tree = await page.render();
  assert.match(textContent(dataRows(tree)[0]), /Loading your club comparison/);
  assert.deepEqual(elements(dataRows(tree)[0]).filter(node => node.type === 'td').map(textContent), ['—', '—', '—']);
  page.setProps({ ownLoading: false, ownError: true }); tree = await page.render();
  assert.match(textContent(dataRows(tree)[0]), /Your club comparison is unavailable/);
  action(tree, 'Retry')(); assert.equal(page.retries.length, 1);
  page.setProps({ ownError: false, own: { ...own, club: { ...own.club, tag: '#OLD', metadata: { name: 'Other private scope' }, rosterTrophies: 999999 } } }); tree = await page.render();
  assert.doesNotMatch(textContent(tree), /Other private scope|999,999/);
  assert.deepEqual(elements(dataRows(tree)[0]).filter(node => node.type === 'td').map(textContent), ['—', '—', '—']);
  page.setProps({ own: { ...own, club: { ...own.club, rosterTrophies: 0, memberCount: 0 }, strength: { medianTrophies: null } } }); tree = await page.render();
  assert.deepEqual(elements(dataRows(tree)[0]).filter(node => node.type === 'td').map(textContent), ['0', '0', '—']);
});

test('stale saved figures and missing rival profiles stay visibly qualified alongside the table values', async () => {
  const page = harness({ ownError: true, data: response([rival({ stale: true })]) }); let tree = await page.render();
  assert.match(textContent(dataRows(tree)[0]), /Showing the last available update/);
  assert.match(textContent(dataRows(tree)[0]), /9,000/);
  assert.match(textContent(dataRows(tree)[1]), /4,000Stale/);
  page.setProps({ data: response([rival({ profile: null, fetchedAt: null, stale: true })]) }); tree = await page.render();
  assert.match(textContent(dataRows(tree)[1]), /No saved club data/);
  assert.deepEqual(elements(dataRows(tree)[1]).filter(node => node.type === 'td').slice(1).map(textContent), ['—', '—']);
});

test('details remain in a full-width row, retain score semantics and expose an admin-only explicit unfollow action', async () => {
  const page = harness(); let tree = await page.render();
  assert.equal(elements(tree).some(node => node.type === 'ClubTrendLine'), false);
  assert.equal(page.removed.length, 0);
  expand(tree); tree = await page.render();
  const detailCell = elements(tree).find(node => node.type === 'td' && node.props.colSpan === 4);
  assert.ok(detailCell);
  assert.match(textContent(detailCell), /A club description/);
  assert.doesNotMatch(textContent(detailCell), /<c3>|All observations/);
  const chart = elements(detailCell).find(node => node.type === 'ClubTrendLine');
  assert.equal(chart.props.label, 'Reported club trophies');
  assert.deepEqual(Array.from(chart.props.points, point => point.value), [1400, 1500]);
  assert.match(textContent(detailCell), /official club score; the table adds members' trophies/);
  assert.match(textContent(detailCell), /about 90 days/);
  assert.equal(elements(detailCell).find(node => node.type === 'ClubRankingSummary').props.tag, '#RIVAL');
  assert.equal(elements(detailCell).find(node => node.type === 'ClubRankingSummary').props.title, 'Recorded rank');
  assert.match(textContent(tree), /Club profiles refresh when viewed after six hours/);
  const stop = elements(detailCell).find(node => node.props?.['aria-label'] === 'Stop following Rival club');
  assert.ok(stop); stop.props.onClick(); assert.deepEqual(page.removed, ['#RIVAL']);
  page.setProps({ saving: true }); tree = await page.render();
  const pending = elements(tree).find(node => node.props?.['aria-label'] === 'Stop following Rival club');
  assert.equal(pending.props.disabled, true); pending.props.onClick(); assert.equal(page.removed.length, 1);
  page.setProps({ isAdmin: false, saving: false }); tree = await page.render();
  assert.equal(elements(tree).some(node => node.props?.['aria-label'] === 'Stop following Rival club'), false);
  action(tree, 'Hide details')(); tree = await page.render();
  assert.equal(elements(tree).some(node => node.type === 'ClubTrendLine'), false);
});

test('a trend requires two distinct known dates and a club-scope change closes expanded details', async () => {
  const first = rival({ history: [{ at: '2026-09-18T12:00:00Z', trophies: 100 }, { at: '2026-09-18T10:00:00Z', trophies: 99 }, { at: '2026-09-17T12:00:00Z', trophies: NaN }] });
  const page = harness({ data: response([first]) }); let tree = await page.render(); expand(tree); tree = await page.render();
  assert.equal(elements(tree).some(node => node.type === 'ClubTrendLine'), false);
  assert.match(textContent(tree), /Trophy history appears after two dated observations/);
  page.setProps({ data: { ...response([first]), clubTag: '#NEW' } }); tree = await page.render();
  assert.equal(elements(tree).some(node => node.type === 'td' && node.props.colSpan === 4), false);
  assert.doesNotMatch(textContent(tree), /Our club/);
});

test('Arabic comparison and details use translated labels and isolate names and tags for RTL', async () => {
  const page = harness({}, 'ar'); let tree = await page.render();
  assert.match(textContent(tree), /مجموع كؤوس الأعضاء/);
  assert.match(textContent(tree), /وسيط الكؤوس/);
  assert.match(textContent(tree), /يمثل وسيط الكؤوس/);
  assert.ok(elements(tree).some(node => node.type === 'bdi' && node.props.dir === 'ltr' && textContent(node) === '#RIVAL'));
  expand(tree); tree = await page.render();
  assert.match(textContent(tree), /نقاط النادي الرسمية/);
  assert.match(textContent(tree), /إلغاء متابعة النادي/);
  assert.doesNotMatch(textContent(tree), /Roster trophies|Median trophies|Stop following club/);
});

test('future profile dates are unqualified, future chart points are excluded, and later genuine responses use an updated clock', async () => {
  const future = '2999-01-01T12:00:00Z';
  const first = rival({ fetchedAt: future, history: [{ at: '2026-09-17T12:00:00Z', trophies: 1400 }, { at: future, trophies: 99999 }] });
  const page = harness({ data: response([first]), own: { ...own, club: { ...own.club, observedAt: future } } });
  let tree = await page.render();
  assert.match(textContent(dataRows(tree)[0]), /Observation time unavailable/);
  assert.match(textContent(dataRows(tree)[1]), /Observation time unavailable/);
  assert.match(textContent(dataRows(tree)[1]), /4,000Stale/);
  assert.doesNotMatch(textContent(tree), /2999/);
  expand(tree); tree = await page.render();
  assert.equal(elements(tree).some(node => node.type === 'ClubTrendLine'), false);
  page.setClock('2026-09-18T14:00:00Z');
  const accepted = '2026-09-18T13:30:00Z';
  page.setProps({ data: response([rival({ fetchedAt: accepted, history: [...first.history, { at: accepted, trophies: 1550 }] })]), own: { ...own, club: { ...own.club, observedAt: accepted } } });
  tree = await page.render();
  assert.match(textContent(dataRows(tree)[0]), /2026-09-18T13:30:00Z/);
  assert.match(textContent(dataRows(tree)[1]), /2026-09-18T13:30:00Z/);
  assert.doesNotMatch(textContent(dataRows(tree)[1]), /Observation time unavailable|Stale/);
  const chart = elements(tree).find(node => node.type === 'ClubTrendLine');
  assert.deepEqual(Array.from(chart.props.points, point => point.value), [1400, 1550]);
});
