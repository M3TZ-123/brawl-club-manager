const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { componentMocks, elements, textContent, action } = require('./helpers/client-renderer.cjs');

const points = [
  { day: '2026-09-16', observedAt: '2026-09-16T23:58:00Z', totalTrophies: 3276557, members: 30 },
  { day: '2026-09-17', observedAt: '2026-09-17T21:28:00Z', totalTrophies: 3279435, members: 30 },
];
const fixture = {
  status: 'partial_period', requestedStart: '2026-09-10T00:00:00Z', requestedEnd: '2026-09-17T22:00:00Z',
  startAt: points[0].observedAt, endAt: points[1].observedAt,
  totalChange: 2878, commonProgress: 2878, addedTrophies: 0, removedTrophies: 0,
  commonMembers: 30, addedMembers: 0, removedMembers: 0, points,
};

function render(data, { locale = 'en', onRetry = () => {} } = {}) {
  const { translate, intlLocale } = loadTypeScript('src/lib/i18n/messages.ts');
  const language = intlLocale(locale);
  const i18n = {
    t: (key, values) => translate(key, locale, values),
    number: value => new Intl.NumberFormat(language).format(value),
    delta: value => value == null ? '—' : new Intl.NumberFormat(language, { signDisplay: 'exceptZero' }).format(value),
    dateTime: value => value == null ? translate('Unknown', locale) : new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Tunis' }).format(new Date(value)),
    date: (value, options) => new Intl.DateTimeFormat(language, options).format(new Date(value)),
  };
  const { ClubGrowth } = loadTypeScript('src/components/club-growth.tsx', {
    ...componentMocks,
    '@/components/locale-provider': { useI18n: () => i18n },
  });
  return ClubGrowth({ data, onRetry });
}

const mainChange = tree => elements(tree).find(element => element.type === 'p' && element.props.className?.includes('text-2xl'));

test('short history shows its actual comparison dates and keeps explanations and daily records collapsed', () => {
  const tree = render(fixture);
  assert.equal(textContent(mainChange(tree)), '+2,878');
  assert.match(textContent(tree), /Since first available record/);
  assert.match(textContent(tree), /Full-period history is not available yet/);
  assert.match(textContent(tree), /From: 17 Sept 2026, 00:58/);
  assert.match(textContent(tree), /To: 17 Sept 2026, 22:28/);
  assert.doesNotMatch(textContent(tree), /Last 7 days|Roster growth|starting roster has not been recorded/);
  const details = elements(tree).filter(element => element.type === 'details');
  assert.equal(details.length, 1);
  assert.ok(!details[0].props.open);
  assert.match(textContent(details[0]), /Requested period/);
  assert.match(textContent(details[0]), /Account changes can include play outside the club and are not a participation score/);
  assert.equal(elements(tree).some(element => element.type === 'select'), false, 'The comparison shares its parent report period');
});

test('trophy deltas retain positive, negative and zero values without showing minus zero for absent departures', () => {
  for (const [change, expected] of [[2878, '+2,878'], [-350, '-350'], [0, '0']]) {
    const tree = render({ ...fixture, status: 'complete_period', totalChange: change, commonProgress: change });
    assert.equal(textContent(mainChange(tree)), expected);
    assert.doesNotMatch(textContent(tree), /Full-period history is not available yet|Since first available record/);
    const breakdown = elements(tree).find(element => element.type === 'dl');
    const values = elements(breakdown).filter(element => element.type === 'dd' && element.props.className?.includes('font-semibold')).map(textContent);
    assert.deepEqual(values, [expected, '0', '0']);
  }
  const changedRoster = render({ ...fixture, totalChange: 2878, commonProgress: -1122, addedTrophies: 14000, removedTrophies: 10000, commonMembers: 29, addedMembers: 1, removedMembers: 1 });
  assert.match(textContent(changedRoster), /Same members-1,12229 membersMembers added\+14,0001 membersMembers left-10,0001 members/);
});

test('an unavailable optional report offers retry and is distinct from an incomplete history', () => {
  let retries = 0;
  const tree = render(null, { onRetry: () => retries++ });
  assert.match(textContent(tree), /Club trophy changes are temporarily unavailable/);
  assert.doesNotMatch(textContent(tree), /complete roster record|Since first available record/);
  assert.equal(mainChange(tree), undefined);
  action(tree, 'Retry')();
  assert.equal(retries, 1);
  for (const savedPoints of [[], points.slice(0, 1)]) {
    const pending = render({ ...fixture, status: 'insufficient_history', startAt: savedPoints[0]?.observedAt ?? null, endAt: null, totalChange: null, commonProgress: null, addedTrophies: null, removedTrophies: null, commonMembers: null, addedMembers: null, removedMembers: null, points: savedPoints });
    assert.equal(mainChange(pending), undefined, 'Unknown movement must not appear as zero');
    assert.doesNotMatch(textContent(pending), /temporarily unavailable|Members added|Members left/);
    assert.match(textContent(pending), savedPoints.length ? /One complete roster record is available/ : /after two complete roster records are saved/);
    if (savedPoints.length) assert.match(textContent(pending), /First complete record: 17 Sept 2026, 00:58/);
  }
});

test('daily records distinguish UTC buckets from local observations and remain in a bounded accessible table', () => {
  const tree = render(fixture);
  const table = elements(tree).find(element => element.type === 'table');
  assert.deepEqual(elements(table).filter(element => element.type === 'th').map(textContent), ['Day (UTC)', 'Last observed (local time)', 'Trophies', 'Members']);
  const rows = elements(table).filter(element => element.type === 'tr' && elements(element).some(child => child.type === 'td'));
  assert.match(textContent(rows[0]), /16 Sept 202617 Sept 2026, 00:58/);
  assert.match(textContent(rows[1]), /17 Sept 202617 Sept 2026, 22:28/);
  const region = elements(tree).find(element => element.props.role === 'region');
  assert.equal(region.props.tabIndex, 0);
  assert.equal(region.props['aria-label'], 'Recorded daily roster totals');
  assert.match(region.props.className, /max-w-full.*overflow-auto/);
});

test('Arabic comparison labels and partial-history guidance are translated and dates remain isolated for RTL', () => {
  const tree = render(fixture, { locale: 'ar' });
  const text = textContent(tree);
  for (const label of ['تغيّر كؤوس النادي', 'منذ أول سجل متاح', 'لم يكتمل سجل الفترة المطلوبة بعد', 'الأعضاء المشتركون', 'الأعضاء المنضمون', 'الأعضاء المغادرون', 'اليوم (UTC)', 'آخر رصد (بالتوقيت المحلي)']) assert.ok(text.includes(label), label);
  assert.doesNotMatch(text, /Club trophy changes|Since first available record|Requested period|Last observed|Same members/);
  assert.ok(elements(tree).filter(element => element.type === 'bdi').length >= 10);
  assert.match(textContent(render(null, { locale: 'ar' })), /بيانات تغيّر كؤوس النادي غير متاحة مؤقتًا/);
});
