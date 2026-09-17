const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { componentMocks, elements, textContent, i18n } = require('./helpers/client-renderer.cjs');

function hours(changes = {}) {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, observations: 0, uniquePlayers: 0, activeDays: 0, ...changes[hour] }));
}
function render(hourly, { locale = 'en', timeZone = 'Africa/Tunis' } = {}) {
  const { translate } = loadTypeScript('src/lib/i18n/messages.ts');
  const { AnalysisPlayingHours } = loadTypeScript('src/components/analysis-playing-hours.tsx', { ...componentMocks,
    '@/components/locale-provider': { useI18n: () => ({ ...i18n, t: (key, values) => translate(key, locale, values) }) },
  });
  return AnalysisPlayingHours({ data: { hourly, timeZone, period: { key: '7d', days: 7, aggregation: 'rolling' } } });
}

test('playing-hour suggestions prioritize different members then repeated days over a small group playing many matches', () => {
  const tree = render(hours({
    3: { observations: 1000, uniquePlayers: 2, activeDays: 7 },
    18: { observations: 18, uniquePlayers: 9, activeDays: 2 },
    19: { observations: 30, uniquePlayers: 8, activeDays: 8 },
    20: { observations: 400, uniquePlayers: 8, activeDays: 4 },
  }));
  const cards = elements(tree).filter(node => node.type === 'article');
  assert.deepEqual(cards.map(card => textContent(elements(card).find(node => node.type === 'h4'))), ['18:00–19:00', '19:00–20:00', '20:00–21:00']);
  assert.match(textContent(cards[1]), /8 members · 8 recorded days/);
  assert.match(textContent(tree), /not necessarily online together/);
  assert.match(textContent(tree), /confirm availability with members/);
});

test('all-hour rows retain 24 server-grouped slots, roll midnight correctly and label the requested time zone', () => {
  const tree = render(hours({ 23: { observations: 9, uniquePlayers: 3, activeDays: 1 } }));
  const rows = elements(tree).filter(node => node.type === 'li');
  assert.equal(rows.length, 24);
  assert.match(textContent(rows[0]), /00:00–01:00/);
  assert.match(textContent(rows[23]), /23:00–00:00/);
  assert.doesNotMatch(textContent(tree), /24:00/);
  assert.match(textContent(tree), /Times shown in Africa\/Tunis/);
  assert.match(textContent(tree), /Only one day observed at this hour/);
  const detail = elements(tree).find(node => node.type === 'details');
  assert.ok(!detail.props.open);
  assert.match(textContent(detail), /Bars show distinct members, not time online/);
  const utc = render(hours({ 23: { observations: 9, uniquePlayers: 3, activeDays: 1 } }), { timeZone: 'UTC' });
  assert.match(textContent(utc), /Times shown in UTC/);
  assert.match(textContent(elements(utc).find(node => node.type === 'article')), /23:00–00:00/);
});

test('empty observations and missing member-count metadata do not invent a busiest hour or online totals', () => {
  const empty = render(hours());
  assert.equal(elements(empty).some(node => node.type === 'article'), false);
  assert.match(textContent(empty), /No recorded battles match this period and these filters. This does not prove inactivity/);
  const partial = hours({ 12: { observations: 100, uniquePlayers: undefined, activeDays: undefined } });
  const tree = render(partial);
  assert.equal(elements(tree).some(node => node.type === 'article'), false);
  assert.doesNotMatch(textContent(tree), /Hours with the most different members/);
  assert.match(textContent(tree), /Bars show recorded participations, not time online/);
  assert.equal(elements(tree).filter(node => node.type === 'li').length, 24);
  assert.match(textContent(elements(tree).filter(node => node.type === 'li')[12]), /100 recorded participations/);
});

test('Arabic playing hours explain member counts, limited days and midnight without untranslated headings', () => {
  const tree = render(hours({ 23: { observations: 9, uniquePlayers: 3, activeDays: 1 } }), { locale: 'ar' });
  for (const copy of ['متى يُرصد لعب الأعضاء', 'ساعات رُصد فيها أكبر عدد من الأعضاء', 'عرض الساعات الأربع والعشرين', 'لا يعني ذلك أن الأعضاء كانوا متصلين معًا', 'يوم واحد فقط']) assert.ok(textContent(tree).includes(copy), copy);
  assert.doesNotMatch(textContent(tree), /When members are recorded playing|Hours with the most different members|All 24 hours/);
  assert.match(textContent(tree), /23:00–00:00/);
  assert.match(textContent(tree), /Africa\/Tunis/);
});

test('device timezone uses a stable UTC server snapshot and updates the client zone on focus with cleanup', () => {
  let zone = 'Africa/Tunis', callbacks, changes = 0;
  const listeners = new Map();
  const { useDeviceTimeZone, readDeviceTimeZone } = loadTypeScript('src/hooks/use-device-time-zone.ts', {
    react: { useSyncExternalStore: (subscribe, snapshot, serverSnapshot) => { callbacks = { subscribe, snapshot, serverSnapshot }; return snapshot(); } },
  }, {
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: zone }) }) },
    window: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); } },
  });
  assert.equal(useDeviceTimeZone(), 'Africa/Tunis');
  assert.equal(callbacks.serverSnapshot(), 'UTC');
  const unsubscribe = callbacks.subscribe(() => changes++);
  zone = 'Asia/Tokyo'; listeners.get('focus')();
  assert.equal(changes, 1);
  assert.equal(callbacks.snapshot(), 'Asia/Tokyo');
  zone = ''; assert.equal(readDeviceTimeZone(), 'UTC');
  unsubscribe(); assert.equal(listeners.has('focus'), false);
  const unavailable = loadTypeScript('src/hooks/use-device-time-zone.ts', { react: {} }, { Intl: { DateTimeFormat() { throw new Error('Unavailable'); } } });
  assert.equal(unavailable.readDeviceTimeZone(), 'UTC');
});
