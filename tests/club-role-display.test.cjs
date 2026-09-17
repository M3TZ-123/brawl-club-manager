const { expandHistory } = require("./helpers/history-renderer.cjs");
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, elements, textContent } = require('./helpers/client-renderer.cjs');

const { clubRoleLabel } = loadTypeScript('src/lib/club-role.ts');
const { translate } = loadTypeScript('src/lib/i18n/messages.ts');

test('club role labels are readable in English and use existing Arabic translations', () => {
  for (const [raw, english, arabic] of [
    ['president', 'President', 'الرئيس'], ['vicePresident', 'Vice President', 'نائب الرئيس'],
    ['senior', 'Senior', 'عضو مخضرم'], ['member', 'Member', 'عضو'],
  ]) {
    assert.equal(clubRoleLabel(raw), english);
    assert.equal(translate(clubRoleLabel(raw), 'en'), english);
    assert.equal(translate(clubRoleLabel(raw), 'ar'), arabic);
  }
  assert.equal(clubRoleLabel('VICEPRESIDENT'), 'Vice President');
  for (const missing of [null, undefined, '', '  ']) assert.equal(clubRoleLabel(missing), 'Unknown');
  assert.equal(clubRoleLabel('futureRole'), 'futureRole', 'Unrecognized roles must not become Member');
});

test('desktop and mobile member badges display readable roles without changing member values', async () => {
  const renderer = hookRenderer();
  const { MembersTable } = loadTypeScript('src/components/members-table.tsx', {
    ...componentMocks, react: { ...renderer.react, memo: component => component },
    '@/components/ui/table': Object.fromEntries(['Table', 'TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow'].map(name => [name, name])),
  });
  const member = { player_tag: '#PYLQ', player_name: 'A player', role: 'vicePresident', trophies: 10000,
    highest_trophies: 11000, rank_current: null, rank_highest: null, win_rate: null,
    brawlers_count: 20, trio_victories: 100, icon_id: null, activity_status: 'active' };
  const tree = await renderer.render(() => MembersTable({ members: [member] }));
  assert.equal(elements(tree).filter(node => node.type === 'Badge' && textContent(node) === 'Vice President').length, 2);
  assert.doesNotMatch(textContent(tree), /vicePresident/);
  assert.equal(member.role, 'vicePresident');
});

test('club leadership and former-member cards translate the shared display key', async () => {
  const renderer = hookRenderer();
  const locale = { t: key => translate(key, 'ar'), number: String, dateTime: String };
  const { ClubIdentity } = loadTypeScript('src/components/club-identity.tsx', {
    ...componentMocks, react: renderer.react,
    '@/components/locale-provider': { useI18n: () => locale },
    '@/components/club-intelligence-panel': { ClubIntelligencePanel: 'Panel', useClubIntelligence: () => ({ data: {
      club: { tag: '#CLUB', metadata: { name: 'Club' }, memberCount: 1, openSeats: 29,
        leaders: [{ tag: '#PYLQ', name: 'A player', role: 'vicePresident' }] }, metadataHistory: [],
    } }) },
  });
  assert.match(textContent(await renderer.render(() => ClubIdentity({}))), /نائب الرئيس/);

  const cardRenderer = hookRenderer();
  const { HistoryMemberCard } = loadTypeScript('src/components/history-member-card.tsx', {
    ...componentMocks, react: cardRenderer.react,
    '@/components/membership-timeline': { MembershipTimeline: 'Timeline' },
  });
  const member = { player_tag: '#PYLQ', player_name: 'A player', is_current_member: false, role_at_leave: 'vicePresident' };
  let tree = await cardRenderer.render(() => expandHistory(HistoryMemberCard({ member, isAdmin: false, onReview() {} })));
  elements(tree).find(node => node.type === 'details').props.onToggle({ currentTarget: { open: true } });
  tree = await cardRenderer.render(() => expandHistory(HistoryMemberCard({ member, isAdmin: false, onReview() {} })));
  assert.match(textContent(tree), /Vice President/);
  assert.equal(member.role_at_leave, 'vicePresident');
});
