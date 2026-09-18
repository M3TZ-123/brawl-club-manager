const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, elements, textContent, action, windowMock } = require('./helpers/client-renderer.cjs');

const member = (name = 'Initial', trophies = 1000) => ({ player_tag: '#PYLQ', player_name: name, role: 'member', trophies,
  highest_trophies: trophies, activity_status: 'active', trio_victories: 2, solo_victories: 1, duo_victories: 0 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function profileHarness(readOverride) {
  const renderer = hookRenderer(), reads = [], writes = [], listeners = new Map();
  let tag = '%23PYLQ';
  const recentMatches = Array.from({ length: 8 }, (_, index) => ({ battle_time: `2026-09-16T12:0${index}:00Z`, mode: 'gemGrab', result: 'victory', trophy_change: index }));
  const Page = loadTypeScript('src/app/members/[tag]/page.tsx', {
    ...componentMocks, react: { ...renderer.react, use: value => value }, 'next/dynamic': () => 'Dynamic',
    '@/components/time-range-picker': { TimeRangePicker: 'TimeRangePicker' },
    '@/components/player-progress': { PlayerProgress: 'PlayerProgress' }, '@/components/membership-timeline': { MembershipTimeline: 'MembershipTimeline' },
    '@/hooks/use-admin-session': { useAdminSession: () => ({ isAdmin: true }) },
    '@/lib/client-data-cache': { fetchJsonCached: async url => {
      reads.push(url);
      if (readOverride) return readOverride(url, reads.length);
      const data = member(); data.player_tag = decodeURIComponent(new URL(url, 'http://fixture').pathname.split('/').at(-1));
      data.player_name = new URL(url, 'http://fixture').searchParams.get('range');
      return { member: data, recentMatches };
    }, invalidateJsonCache() {} },
  }, { Error, console: { error() {} }, window: { ...windowMock, addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) },
    fetch: (url) => { const pending = deferred(); writes.push({ url, ...pending }); return pending.promise; } }).default;
  return { reads, writes, listeners, setTag: value => { tag = value; }, render: () => renderer.render(() => Page({ params: { tag } })) };
}

test('delayed manual profile refresh reads the currently selected period, not the period at click time', async () => {
  const page = profileHarness(); let tree = await page.render();
  const refreshing = action(tree, 'Refresh Stats')();
  elements(tree).find(node => node.type === 'TimeRangePicker').props.onChange('30d'); tree = await page.render();
  assert.equal(elements(tree).find(node => node.type === 'h1').props.children, '30d');
  page.writes[0].resolve({ ok: true }); await refreshing; tree = await page.render();
  assert.match(page.reads.at(-1), /range=30d$/);
  assert.equal(elements(tree).find(node => node.type === 'h1').props.children, '30d');
  assert.equal(page.reads.filter(url => url.endsWith('range=7d')).length, 1);
});

test('a previous player refresh cannot replace or reload the newly opened profile', async () => {
  const page = profileHarness(); let tree = await page.render();
  const refreshing = action(tree, 'Refresh Stats')();
  page.setTag('%23QYLP'); tree = await page.render(); const count = page.reads.length;
  page.writes[0].resolve({ ok: true }); await refreshing; tree = await page.render();
  assert.equal(page.reads.length, count);
  assert.match(textContent(tree), /#QYLP/);
});

test('background profile refresh preserves expanded battles, but a new period resets the list', async () => {
  const page = profileHarness(); let tree = await page.render();
  action(tree, 'Show all recent battles')(); tree = await page.render();
  page.listeners.get('club-data-updated')(); tree = await page.render();
  assert.ok(elements(tree).some(node => node.type === 'Badge' && textContent(node) === '8 of 8'));
  elements(tree).find(node => node.type === 'TimeRangePicker').props.onChange('90d'); tree = await page.render();
  assert.ok(elements(tree).some(node => node.type === 'Badge' && textContent(node) === '5 of 8'));
});

test('changing clubs clears the profile and private controls, and old reads cannot restore them after the new read fails', async () => {
  const older = deferred(), latest = deferred();
  const page = profileHarness(async (_url, count) => {
    if (count === 1) return { member: member('Old club'), memberHistory: { first_seen: '2026-01-01' } };
    if (count === 2) return older.promise;
    await latest.promise; throw new Error('New club has no matching member');
  });
  let tree = await page.render();
  assert.ok(elements(tree).some(node => node.type === 'MemberReviewButton'));
  assert.ok(elements(tree).some(node => node.type === 'PlayerProgress'));
  page.listeners.get('club-data-updated')(); await page.render();
  page.listeners.get('club-data-updated')({ detail: { clubChanged: true } }); tree = await page.render();
  assert.doesNotMatch(textContent(tree), /Old club/);
  assert.equal(elements(tree).some(node => ['MemberReviewButton', 'MembershipTimeline', 'PlayerProgress'].includes(node.type)), false);
  latest.resolve(); tree = await page.render();
  assert.match(textContent(tree), /Could not load this member/);
  older.resolve({ member: member('Old club late response') }); tree = await page.render();
  assert.doesNotMatch(textContent(tree), /Old club/);
  assert.equal(elements(tree).some(node => node.type === 'MemberReviewButton'), false);
});

test('an old club manual refresh cannot reload a new club profile with the same player tag', async () => {
  const page = profileHarness(); let tree = await page.render();
  const refreshing = action(tree, 'Refresh Stats')();
  page.listeners.get('club-data-updated')({ detail: { clubChanged: true } }); tree = await page.render();
  const readCount = page.reads.length;
  page.writes[0].resolve({ ok: true }); await refreshing; tree = await page.render();
  assert.equal(page.reads.length, readCount);
  assert.ok(elements(tree).some(node => node.type === 'MemberReviewButton'), 'A successful new-scope read can show the shared player again');
});

test('an open member quick view follows roster updates and preserves its last snapshot on departure', async () => {
  const renderer = hookRenderer(), listeners = new Map(); let roster = [member()];
  const Page = loadTypeScript('src/app/members/page.tsx', { ...componentMocks, react: renderer.react,
    '@/components/members-table': { MembersTable: 'MembersTable', DEFAULT_MEMBER_COLUMNS: {} },
    '@/components/time-range-picker': { TimeRangePicker: 'TimeRangePicker' }, '@/components/ui/switch': { Switch: 'Switch' },
    '@/hooks/use-admin-session': { useAdminSession: () => ({ isAdmin: true, isLoading: false }) },
    '@/lib/store': { useAppStore: () => ({ clubTag: '#CLUB', apiKeyConfigured: true }) },
    '@/lib/client-data-cache': { fetchJsonCached: async () => ({ members: roster }), invalidateJsonCache() {} },
  }, { window: { ...windowMock, addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) }, CustomEvent: class {} }).default;
  let tree = await renderer.render(Page);
  elements(tree).find(node => node.type === 'MembersTable').props.onMemberSelect(roster[0]); tree = await renderer.render(Page);
  roster = [member('Updated', 2000)]; listeners.get('club-data-updated')({}); tree = await renderer.render(Page);
  assert.equal(textContent(elements(tree).find(node => node.type === 'SheetTitle')), 'Updated');
  const review = elements(tree).find(node => node.type === 'MemberReviewButton' && node.props.prominent);
  assert.equal(review.props.member.trophies, 2000);
  roster = []; listeners.get('club-data-updated')({}); tree = await renderer.render(Page);
  assert.equal(elements(tree).find(node => node.type === 'Sheet').props.open, true);
  assert.equal(textContent(elements(tree).find(node => node.type === 'SheetTitle')), 'Updated');
  assert.match(textContent(tree), /no longer in the current roster/);
});

test('club changes immediately clear the current members and ignore an older cancelled read failure', async () => {
  const renderer = hookRenderer(), listeners = new Map(), older = deferred(), latest = deferred(); let reads = 0;
  const Page = loadTypeScript('src/app/members/page.tsx', { ...componentMocks, react: renderer.react,
    '@/components/members-table': { MembersTable: 'MembersTable', DEFAULT_MEMBER_COLUMNS: {} },
    '@/components/time-range-picker': { TimeRangePicker: 'TimeRangePicker' }, '@/components/ui/switch': { Switch: 'Switch' },
    '@/hooks/use-admin-session': { useAdminSession: () => ({ isAdmin: false, isLoading: false }) },
    '@/lib/store': { useAppStore: () => ({ clubTag: '#CLUB', apiKeyConfigured: true }) },
    '@/lib/client-data-cache': { fetchJsonCached: async () => {
      if (++reads === 1) return { members: [member('Old club')] };
      if (reads === 2) { await older.promise; throw new Error('Request cancelled.'); }
      await latest.promise; return { members: [member('New club')] };
    }, invalidateJsonCache() {} },
  }, { Error, console: { error() {} }, window: { ...windowMock, addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) }, CustomEvent: class {} }).default;
  let tree = await renderer.render(Page);
  elements(tree).find(node => node.type === 'MembersTable').props.onMemberSelect(member('Old club')); tree = await renderer.render(Page);
  assert.equal(elements(tree).find(node => node.type === 'Sheet').props.open, true);
  assert.ok(elements(tree).some(node => node.type === 'MemberReviewButton'));
  listeners.get('club-data-updated')({}); await renderer.render(Page);
  listeners.get('club-data-updated')({ detail: { clubChanged: true } }); tree = await renderer.render(Page);
  assert.equal(elements(tree).some(node => node.type === 'MembersTable'), false);
  assert.equal(elements(tree).find(node => node.type === 'Sheet').props.open, false);
  assert.equal(elements(tree).some(node => node.type === 'MemberReviewButton'), false, 'A previous club member must not keep private review controls mounted');
  latest.resolve(); tree = await renderer.render(Page);
  assert.equal(elements(tree).find(node => node.type === 'MembersTable').props.members[0].player_name, 'New club');
  older.resolve(); tree = await renderer.render(Page);
  assert.equal(elements(tree).find(node => node.type === 'MembersTable').props.members[0].player_name, 'New club');
  assert.doesNotMatch(textContent(tree), /Request cancelled/);
});
