const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, windowMock, elements, textContent, i18n } = require('./helpers/client-renderer.cjs');
const { expandHistory } = require('./helpers/history-renderer.cjs');
const tables = Object.fromEntries(['Table', 'TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow'].map(name => [name, name]));
const member = (tag, current, overrides = {}) => ({ player_tag: tag, player_name: tag, first_seen: '2026-09-01T00:00:00Z', last_left_at: null,
  times_joined: null, times_left: null, is_current_member: current, notes: 'Private fixture', role_at_leave: null, trophies_at_leave: null, ...overrides });
const rows = [member('#CURRENT', true), member('#RETURNED', true, { times_left: 1 }), member('#FORMER', false), member('#FORMERRETURN', false, { times_left: 2 })];
const summary = tree => Object.fromEntries(elements(tree).filter(node => node.type === 'div' && elements(node).filter(child => child.type === 'dt').length === 1 && elements(node).filter(child => child.type === 'dd').length === 1)
  .map(node => [textContent(elements(node).find(child => child.type === 'dt')), textContent(elements(node).find(child => child.type === 'dd'))]));

function harness() {
  const renderer = hookRenderer(), requests = [];
  const Page = loadTypeScript('src/app/history/page.tsx', { ...componentMocks, react: renderer.react,
    '@/components/ui/table': tables, '@/components/time-range-picker': { TimeRangePicker: 'TimeRangePicker' },
    '@/components/history-member-card': { HistoryMemberCard: 'HistoryMemberCard' },
    '@/components/membership-timeline': { MembershipTimeline: 'MembershipTimeline' },
    '@/hooks/use-admin-session': { useAdminSession: () => ({ isAdmin: true, isLoading: false }) },
    '@/lib/client-fetch': { fetchJsonWithTimeout: async (url, options) => { requests.push({ url, options }); return { history: rows }; } },
  }, { window: windowMock }).default;
  return { requests, render: () => renderer.render(() => expandHistory(Page())) };
}

test('history summaries follow the visible search and status filters while returned history overlaps membership status', async () => {
  const page = harness(); let tree = await page.render();
  assert.equal(page.requests[0].url, '/api/history?range=all');
  assert.deepEqual(summary(tree), { 'Matching members': '4', 'Current in results': '2', 'Former in results': '2' });
  elements(tree).find(node => node.type === 'select').props.onChange({ target: { value: 'returned' } }); tree = await page.render();
  assert.deepEqual(summary(tree), { 'Matching members': '2', 'Current in results': '1', 'Former in results': '1' });
  assert.match(textContent(tree), /Previously returned: 2 of these members/);
  elements(tree).find(node => node.type === 'Input').props.onChange({ target: { value: 'FORMER' } }); tree = await page.render();
  assert.deepEqual(summary(tree), { 'Matching members': '1', 'Current in results': '0', 'Former in results': '1' });
  assert.match(textContent(tree), /#FORMERRETURN/);
  elements(tree).find(node => node.type === 'select').props.onChange({ target: { value: 'current' } }); tree = await page.render();
  assert.deepEqual(summary(tree), { 'Matching members': '0', 'Current in results': '0', 'Former in results': '0' });
  assert.match(textContent(tree), /No member history found/);
});

test('desktop has five concise columns and loads membership details only after selecting a member', async () => {
  const page = harness(); let tree = await page.render();
  assert.deepEqual(elements(tree).filter(node => node.type === 'TableHead').map(textContent), ['Player', 'Current status', 'Latest recorded event', 'Private notes', 'Details']);
  assert.equal(elements(tree).some(node => node.type === 'MembershipTimeline'), false);
  assert.equal(elements(tree).some(node => node.type === 'Input' && node.props.placeholder === 'Add a note...'), false);
  assert.doesNotMatch(textContent(tree), /Club growth and retention|Observed member retention/);
  elements(tree).find(node => node.props?.['aria-label'] === 'Details for #FORMERRETURN').props.onClick(); tree = await page.render();
  assert.equal(elements(tree).find(node => node.type === 'MembershipTimeline').props.playerTag, '#FORMERRETURN');
  assert.ok(elements(tree).some(node => node.props?.href === '/club-planning?member=%23FORMERRETURN#mega-pig-history'));
  elements(tree).find(node => node.type === 'Sheet').props.onOpenChange(false); tree = await page.render();
  assert.equal(elements(tree).some(node => node.type === 'MembershipTimeline'), false);
});

test('latest membership events preserve source and event meaning instead of treating last seen as a join', () => {
  const { HistoryLatestEvent } = loadTypeScript('src/components/history-member-details.tsx', componentMocks);
  const unknown = HistoryLatestEvent({ member: member('#A', true, { last_seen: '2026-09-18', latest_membership_event: null }) });
  assert.equal(textContent(unknown), 'No dated membership event');
  for (const [type, label] of [['join', 'Joined club'], ['leave', 'Left club'], ['initial_seen', 'First observed']]) {
    const tree = HistoryLatestEvent({ member: member('#A', true, { latest_membership_event: { type, at: '2026-09-10T12:00:00Z', source: 'reconstructed' } }) });
    assert.match(textContent(tree), new RegExp(label));
    assert.match(textContent(tree), /Reconstructed/);
    assert.equal(elements(tree).find(node => node.type === 'LocalDate').props.value, '2026-09-10T12:00:00Z');
    assert.doesNotMatch(textContent(tree), /kicked|Kicked/);
  }
});

test('current status is always separate from a known return and private notes and Mega Pig links are admin only', () => {
  const { HistoryMemberStatus, HistoryPrivateNote, HistoryMemberDetails, hasRecordedReturn } = loadTypeScript('src/components/history-member-details.tsx', { ...componentMocks, '@/components/membership-timeline': { MembershipTimeline: 'MembershipTimeline' } });
  assert.equal(hasRecordedReturn(rows[0]), false);
  assert.equal(hasRecordedReturn(rows[1]), true);
  assert.equal(hasRecordedReturn(rows[3]), true);
  assert.deepEqual(elements(HistoryMemberStatus({ member: rows[3] })).filter(node => node.type === 'Badge').map(textContent), ['Former', 'Previously returned']);
  const publicNote = HistoryPrivateNote({ member: rows[3], isAdmin: false, onReview() { throw new Error('Private review cannot open'); } });
  assert.doesNotMatch(textContent(publicNote), /Private fixture/);
  assert.equal(elements(publicNote).find(node => node.type === 'Link').props.href, '/reviews?member=%23FORMERRETURN');
  const publicDetails = HistoryMemberDetails({ member: rows[3], isAdmin: false });
  assert.equal(elements(publicDetails).some(node => node.props?.href?.startsWith('/club-planning')), false);
  const privateNote = HistoryPrivateNote({ member: rows[3], isAdmin: true, onReview() {} });
  assert.match(textContent(privateNote), /Private fixture/);
  assert.equal(elements(privateNote).filter(node => node.props?.onClick).length, 1);
});

test('Arabic history wording keeps recorded events and prior returns distinct', () => {
  const { translate } = loadTypeScript('src/lib/i18n/messages.ts');
  for (const key of ['Matching members', 'Current in results', 'Former in results', 'Previously returned', 'Latest recorded event', 'No dated membership event', 'Mega Pig history']) assert.match(translate(key, 'ar'), /[\u0600-\u06ff]/);
  const { HistoryLatestEvent } = loadTypeScript('src/components/history-member-details.tsx', { ...componentMocks,
    '@/components/locale-provider': { LocalDate: 'LocalDate', useI18n: () => ({ ...i18n, t: key => translate(key, 'ar') }) },
  });
  const tree = HistoryLatestEvent({ member: member('#A', false, { latest_membership_event: { type: 'leave', at: '2026-09-10', source: 'recorded' } }) });
  assert.match(textContent(tree), /غادر النادي/);
  assert.doesNotMatch(textContent(tree), /طرد/);
});
