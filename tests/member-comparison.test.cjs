const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { buildMemberComparison, compareMembers, compareReplacement, sortComparisonMembers, comparisonPolicy, comparisonReasonLabels } = loadTypeScript('src/lib/member-comparison.ts');
const NOW = '2026-09-17T12:00:00.000Z', DAY = 86400000, end = Date.parse('2026-09-17T00:00:00Z');
const plain = value => JSON.parse(JSON.stringify(value));
const ago = hours => new Date(Date.parse(NOW) - hours * 3600000).toISOString();
const profile = () => ({ trophies: 50000, trophiesCheckedAt: ago(.05), power11: 20, profileCheckedAt: ago(.1), rank: 'Diamond I', rankedPoints: 4500, rankedSeasonId: 42, rankedCheckedAt: ago(.1) });
function member(tag = '#ONE', days = 7) {
  return { tag, name: tag, role: 'member', profile: profile(), lastActivityAt: ago(1), lastBattleAt: ago(1),
    spell: { startedAt: ago(150 * 24), source: 'recorded', kind: 'join', uncertain: false }, graceUntil: null, absence: null,
    coverage: { baselineAt: ago(100 * 24), checkedAt: ago(.05), lastStatus: 'observed', trailing48hGap: false, trailing48hExcused: false },
    days: Array.from({ length: days }, (_, i) => ({ date: new Date(end - (days - i) * DAY).toISOString().slice(0, 10), battles: 5, possibleGap: false, absenceOverlap: false })),
    events: [], eventsTruncated: false };
}
function event(id, attendance = 'present', extras = {}) {
  return { id, version: 1, title: `Club event ${id}`, kind: 'mega_pig', startsAt: '2026-09-12T18:00:00Z', endsAt: '2026-09-12T20:00:00Z',
    status: 'completed', attendance, observedAt: '2026-09-12T20:00:00Z', absenceOverlap: false, ...extras };
}
const candidate = (tag = '#CANDIDATE') => ({ kind: 'candidate', tag, name: tag, status: 'shortlisted', profile: { ...profile(), trophies: 60000, power11: 25, rankedSeasonId: null }, commitment: 'unknown' });
function snapshot(members = [member()], extras = {}) {
  return { clubTag: '#CLUB', generatedAt: NOW, range: '7d', rosterCheckedAt: ago(.05), members, candidates: [], ...extras };
}
const assessed = raw => buildMemberComparison(snapshot([raw])).members[0];
const metric = (comparison, key) => comparison.metrics.find(item => item.key === key);
function quiet(raw) { raw.days.forEach(day => { day.battles = 0; }); return raw; }

test('periods contain exactly the last completed UTC dates, including leap-day and 90-day windows', () => {
  for (const range of ['7d', '30d', '90d']) {
    const days = Number.parseInt(range), result = buildMemberComparison(snapshot([member('#ONE', days)], { range }));
    assert.equal(result.period.end, '2026-09-17T00:00:00.000Z');
    assert.equal(Date.parse(result.period.end) - Date.parse(result.period.start), days * DAY);
    assert.equal(result.members[0].activity.eligibleCompletedDays, days);
    assert.equal(result.period.completedDaysOnly, true);
  }
  const leap = buildMemberComparison(snapshot([], { generatedAt: '2024-03-01T00:00:01Z' }));
  assert.equal(leap.period.start, '2024-02-23T00:00:00.000Z');
  assert.equal(leap.period.end, '2024-03-01T00:00:00.000Z');
});

test('activity uses explicit monitored zeros and never counts missing or gap days as inactivity', () => {
  const low = quiet(member());
  let result = assessed(low);
  assert.equal(result.activity.evaluatedDays, 7); assert.equal(result.activity.minimumExpectedActiveDays, 3);
  assert.equal(result.assessment.bucket, 'review'); assert.ok(result.assessment.reasons.includes('low_observed_activity'));
  low.days[0].battles = 5; low.days[1].battles = 1; low.days[2].battles = null;
  result = assessed(low);
  assert.equal(result.activity.evaluatedDays, 6); assert.equal(result.activity.unknownDays, 1);
  assert.equal(result.activity.lowObservedActivity, false, 'The unknown day could meet the third active-day target');
  low.days[3].possibleGap = true;
  result = assessed(low);
  assert.equal(result.activity.evaluatedDays, 5); assert.equal(result.activity.sufficientSample, false);
  assert.equal(result.assessment.bucket, 'insufficient');
  low.days[3].battles = 1;
  result = assessed(low);
  assert.equal(result.activity.observedActiveDays, 3, 'Positive observations still prove participation on a partial date');
  assert.equal(result.activity.possibleGap, true);
});

test('missing rows remain unknown and old dates cannot manufacture a clean 90-day gap audit', () => {
  const missing = member(); missing.days = [];
  assert.equal(assessed(missing).activity.unknownDays, 7);
  assert.equal(assessed(missing).assessment.bucket, 'insufficient');
  const old = quiet(member('#ONE', 90));
  const result = buildMemberComparison(snapshot([old], { range: '90d' })).members[0];
  assert.ok(result.activity.unknownDays >= 62); assert.equal(result.activity.lowObservedActivity, false);
  assert.ok(result.assessment.limitations.includes('old_gap_history'));
  assert.equal(result.activity.rangeLimited, true);
});

test('leadership, active absence, grace and uncertain current membership remain outside the ranked queue', () => {
  const leader = quiet(member('#LEAD')); leader.role = 'vicePresident';
  const president = quiet(member('#PRES')); president.role = 'president';
  const absent = quiet(member('#ABS')); absent.absence = { startsAt: ago(1), endsAt: ago(-24) };
  const grace = quiet(member('#GRACE')); grace.graceUntil = ago(-24);
  const uncertain = quiet(member('#UNKNOWN')); uncertain.spell.source = 'reconstructed';
  const senior = quiet(member('#SENIOR')); senior.role = 'senior';
  const result = buildMemberComparison(snapshot([leader, president, absent, grace, uncertain, senior]));
  assert.equal(result.groups.protected, 5); assert.equal(result.groups.review, 1);
  assert.equal(result.members.find(row => row.tag === '#SENIOR').assessment.position, 1);
  assert.ok(result.members.filter(row => row.protection.active).every(row => row.assessment.position === null));
});

test('independent 48-hour evidence can support review before five days but requires the whole unexcused fresh window', () => {
  const raw = member(); raw.days = []; raw.spell.startedAt = ago(49); raw.spell.kind = 'initial_seen';
  raw.coverage.baselineAt = ago(49); raw.lastActivityAt = null; raw.lastBattleAt = null;
  let result = assessed(raw);
  assert.equal(result.activity.sufficientSample, false); assert.equal(result.activity.noRecentActivity, true);
  assert.equal(result.assessment.bucket, 'review'); assert.ok(result.assessment.reasons.includes('no_recent_activity'));
  const variations = [
    row => { row.coverage.trailing48hExcused = true; },
    row => { row.graceUntil = ago(24); },
    row => { row.coverage.trailing48hGap = true; },
    row => { row.coverage.checkedAt = ago(.6); },
    row => { row.coverage.lastStatus = 'failed'; },
    row => { row.coverage.baselineAt = ago(47); },
    row => { row.spell.startedAt = ago(47); },
    row => { row.lastBattleAt = ago(1); },
    row => { row.lastActivityAt = ago(1); },
    row => { row.lastActivityAt = ago(-1); },
  ];
  for (const mutate of variations) {
    const changed = plain(raw); mutate(changed); result = assessed(changed);
    assert.equal(result.activity.noRecentActivity, false, String(mutate));
  }
});

test('known event outcomes require completed assigned events and valid within-event administrative observations', () => {
  const raw = member(); raw.events = [
    event('a', 'absent'), event('b', 'absent'), event('c', 'present'), event('d', 'confirmed'), event('e', 'invited'),
    event('f', null), event('g', 'absent', { observedAt: '2026-09-12T19:59:59Z' }),
    event('h', 'present', { observedAt: '2026-09-12T17:59:59Z' }), event('i', 'present', { observedAt: '2026-09-12T20:00:01Z' }),
    event('j', 'absent', { status: 'cancelled' }), event('k', 'absent', { status: 'planned' }),
    event('l', 'absent', { absenceOverlap: true }), event('m', 'absent', { endsAt: '2026-09-18T20:00:00Z' }),
  ];
  const result = assessed(raw);
  assert.equal(result.events.present, 1); assert.equal(result.events.absent, 3); assert.equal(result.events.knownSample, 4);
  assert.equal(result.events.unresolved, 5); assert.equal(result.events.excused, 1);
  assert.equal(result.events.repeatedAbsences, true); assert.equal(result.assessment.bucket, 'review');
  assert.deepEqual(plain(result.events.evidence[0]), { eventId: 'a', version: 1, title: 'Club event a', endedAt: '2026-09-12T20:00:00.000Z', attendance: 'absent', observedAt: '2026-09-12T20:00:00.000Z' });
});

test('unassigned players and small or truncated event samples are never scored as repeated absentees', () => {
  const raw = member(); raw.events = [event('a', 'absent'), event('b', 'absent')];
  let result = assessed(raw);
  assert.equal(result.events.repeatedAbsences, false); assert.equal(result.assessment.bucket, 'followup');
  raw.events.push(event('c')); raw.eventsTruncated = true;
  result = assessed(raw); assert.equal(result.events.repeatedAbsences, false); assert.ok(result.assessment.limitations.includes('events_truncated'));
  raw.events = []; raw.eventsTruncated = false;
  result = assessed(raw); assert.equal(result.events.absent, 0); assert.equal(result.events.knownSample, 0); assert.equal(result.events.sufficientSample, false);
});

test('pre-membership, grace and excused dates/events are excluded rather than counted as missed', () => {
  const raw = quiet(member()); raw.spell.startedAt = '2026-09-12T08:00:00Z'; raw.graceUntil = '2026-09-14T00:00:00Z';
  raw.days[5].absenceOverlap = true;
  raw.events = [event('before', 'absent', { startsAt: '2026-09-11T18:00:00Z', endsAt: '2026-09-11T20:00:00Z', observedAt: '2026-09-11T20:00:00Z' }), event('grace', 'absent')];
  const result = assessed(raw);
  assert.equal(result.events.assignedCompleted, 1); assert.equal(result.events.excused, 1); assert.equal(result.events.absent, 0);
  assert.equal(result.activity.eligibleCompletedDays, 2); assert.equal(result.activity.excusedDays, 2); assert.equal(result.activity.lowObservedActivity, false);
});

test('review ordering is deterministic, evidence-based and keeps protections fixed under all three orders', () => {
  const both = quiet(member('#BOTH')); both.events = [event('a', 'absent'), event('b', 'absent'), event('c')];
  const onlyActivity = quiet(member('#ACTIVITY'));
  const onlyAttendance = member('#EVENTS'); onlyAttendance.events = [event('a', 'absent'), event('b', 'absent'), event('c', 'absent')];
  const protectedMember = quiet(member('#LEADER')); protectedMember.role = 'president';
  const result = buildMemberComparison(snapshot([onlyActivity, onlyAttendance, protectedMember, both]));
  assert.equal(result.members[0].tag, '#BOTH'); assert.equal(result.members[0].assessment.priority, 'high');
  const original = JSON.stringify(result);
  for (const order of ['review', 'activity', 'attendance']) {
    const sorted = sortComparisonMembers(result.members, order);
    assert.equal(sorted.at(-1).tag, '#LEADER'); assert.equal(sorted.at(-1).assessment.position, null);
    assert.deepEqual(plain(sorted.slice(0, 3).map(row => row.assessment.position)), [1, 2, 3]);
  }
  assert.equal(sortComparisonMembers(result.members, 'attendance')[0].tag, '#EVENTS');
  assert.equal(JSON.stringify(result), original);
});

test('stale roster suppresses current replacement review even when historical concerns are known', () => {
  const result = buildMemberComparison(snapshot([quiet(member())], { rosterCheckedAt: ago(3), candidates: [candidate()] }));
  assert.equal(result.members[0].assessment.bucket, 'insufficient'); assert.ok(result.members[0].assessment.limitations.includes('stale_roster'));
  assert.equal(compareReplacement(result, '#ONE', { kind: 'candidate', tag: '#CANDIDATE' }).canEstimateReplacement, false);
});

test('equal activity counts on different dates and attendance on different event cohorts are not comparable', () => {
  const first = member('#ONE'), second = member('#TWO');
  first.days[0].battles = null; second.days[6].battles = null;
  first.events = [event('a'), event('b'), event('c')]; second.events = [event('a'), event('b'), event('other')];
  let data = buildMemberComparison(snapshot([first, second]));
  let result = compareMembers(data, { kind: 'member', tag: '#ONE' }, { kind: 'member', tag: '#TWO' });
  assert.equal(metric(result, 'activeDays').reason, 'different_exposure'); assert.equal(metric(result, 'activeDays').delta, null);
  assert.equal(metric(result, 'eventAttendance').reason, 'different_exposure');
  second.days = plain(first.days); second.events = plain(first.events).reverse();
  data = buildMemberComparison(snapshot([first, second])); result = compareMembers(data, { kind: 'member', tag: '#ONE' }, { kind: 'member', tag: '#TWO' });
  assert.equal(result.commitmentComparable, true); assert.equal(metric(result, 'eventAttendance').left, 100);
  second.events[0].version = 2;
  data = buildMemberComparison(snapshot([first, second])); result = compareMembers(data, { kind: 'member', tag: '#ONE' }, { kind: 'member', tag: '#TWO' });
  assert.equal(metric(result, 'eventAttendance').delta, null, 'An event revision is part of comparison evidence');
});

test('head-to-head activity distinguishes an unevaluable period from confirmed monitored zero', () => {
  const unknown = member('#UNKNOWN'), monitored = quiet(member('#MONITORED'));
  unknown.days.forEach(day => { day.battles = null; });
  const data = buildMemberComparison(snapshot([unknown, monitored]));
  assert.equal(data.members.find(row => row.tag === '#UNKNOWN').activity.evaluatedDays, 0);
  assert.equal(data.members.find(row => row.tag === '#MONITORED').activity.evaluatedDays, 7);
  const result = compareMembers(data, { kind: 'member', tag: '#UNKNOWN' }, { kind: 'member', tag: '#MONITORED' });
  assert.equal(metric(result, 'activeDays').left, null); assert.equal(metric(result, 'activeDays').right, 0);
  assert.equal(metric(result, 'activeDays').delta, null); assert.equal(metric(result, 'activeDays').comparable, false);
  const reverse = compareMembers(data, { kind: 'member', tag: '#MONITORED' }, { kind: 'member', tag: '#UNKNOWN' });
  assert.equal(metric(reverse, 'activeDays').left, 0); assert.equal(metric(reverse, 'activeDays').right, null);
});

test('candidate profile advantages never imply activity or attendance reliability; existing-member swaps have no additive roster impact', () => {
  const data = buildMemberComparison(snapshot([member(), member('#CURRENT')], { candidates: [candidate(), candidate('#CURRENT'), candidate('#OTHER')] }));
  let result = compareReplacement(data, '#ONE', { kind: 'candidate', tag: '#CANDIDATE' });
  assert.equal(result.commitmentComparable, false); assert.equal(metric(result, 'activeDays').right, null);
  assert.equal(metric(result, 'eventAttendance').reason, 'candidate_commitment_unknown');
  assert.deepEqual(plain(result.rosterImpact), { trophies: 10000, power11: 5 }); assert.equal(result.canEstimateReplacement, true);
  assert.ok(result.limitations.includes('candidate_commitment_unknown'));
  const reverse = compareMembers(data, { kind: 'candidate', tag: '#CANDIDATE' }, { kind: 'member', tag: '#ONE' });
  assert.deepEqual(plain(reverse.rosterImpact), { trophies: 10000, power11: 5 });
  assert.equal(metric(reverse, 'trophies').delta, -10000, 'Row differences remain right minus left');
  assert.equal(reverse.canEstimateReplacement, true, 'Candidate-first links retain the same scenario');
  for (const kind of ['member', 'candidate']) {
    result = compareReplacement(data, '#ONE', { kind, tag: '#CURRENT' });
    assert.equal(result.rosterImpact, null); assert.equal(result.canEstimateReplacement, false);
  }
  result = compareMembers(data, { kind: 'candidate', tag: '#CANDIDATE' }, { kind: 'candidate', tag: '#OTHER' });
  assert.equal(metric(result, 'power11').comparable, true); assert.equal(result.rosterImpact, null);
});

test('capability deltas require independently fresh timestamps; known zero is valid and unknown is never zero', () => {
  const prospect = candidate(); prospect.profile.power11 = 0; prospect.profile.trophies = 0;
  let data = buildMemberComparison(snapshot([member()], { candidates: [prospect] }));
  let result = compareReplacement(data, '#ONE', { kind: 'candidate', tag: prospect.tag });
  assert.equal(metric(result, 'trophies').delta, -50000); assert.equal(metric(result, 'power11').delta, -20);
  prospect.profile.profileCheckedAt = ago(3);
  data = buildMemberComparison(snapshot([member()], { candidates: [prospect] })); result = compareReplacement(data, '#ONE', { kind: 'candidate', tag: prospect.tag });
  assert.equal(metric(result, 'power11').reason, 'stale'); assert.equal(result.rosterImpact.power11, null); assert.equal(result.rosterImpact.trophies, -50000);
  prospect.profile.trophiesCheckedAt = ago(-1); prospect.profile.power11 = null;
  data = buildMemberComparison(snapshot([member()], { candidates: [prospect] })); result = compareReplacement(data, '#ONE', { kind: 'candidate', tag: prospect.tag });
  assert.equal(metric(result, 'trophies').delta, null); assert.equal(metric(result, 'power11').right, null); assert.equal(result.canEstimateReplacement, false);
});

test('Ranked points compare only fresh observations from the same known season, including legitimate zero', () => {
  const first = member('#ONE'), second = member('#TWO'); second.profile.rankedPoints = 0;
  const comparison = () => compareMembers(buildMemberComparison(snapshot([first, second])), { kind: 'member', tag: '#ONE' }, { kind: 'member', tag: '#TWO' });
  assert.equal(metric(comparison(), 'rankedPoints').delta, -4500);
  second.profile.rankedSeasonId = 43; assert.equal(metric(comparison(), 'rankedPoints').reason, 'different_season');
  second.profile.rankedSeasonId = null; assert.equal(metric(comparison(), 'rankedPoints').reason, 'unknown');
  second.profile.rankedSeasonId = 42; second.profile.rankedCheckedAt = ago(3); assert.equal(metric(comparison(), 'rankedPoints').reason, 'stale');
});

test('full thirty-member assessment is bounded, reproducible and leaves input snapshots intact', () => {
  const raw = snapshot(Array.from({ length: 30 }, (_, index) => quiet(member(`#PLAYER${String(index).padStart(2, '0')}`))));
  const original = JSON.stringify(raw), result = buildMemberComparison(raw);
  assert.equal(result.members.length, 30); assert.equal(result.groups.review, 30);
  const reversed = { ...raw, members: [...raw.members].reverse() };
  assert.deepEqual(plain(result), plain(buildMemberComparison(reversed))); assert.equal(JSON.stringify(raw), original);
  assert.equal(comparisonPolicy.version, 'activity-first-v1');
  for (const row of result.members) for (const reason of [...row.assessment.reasons, ...row.assessment.limitations]) assert.ok(comparisonReasonLabels[reason]);
  assert.throws(() => buildMemberComparison(snapshot([...raw.members, member('#EXTRA')])));
  const duplicate = member(); duplicate.days.push({ ...duplicate.days[0] }); assert.throws(() => assessed(duplicate));
  const repeated = member(); repeated.events = [event('same'), event('same')]; assert.throws(() => assessed(repeated));
});

function observedLegacy(raw = quiet(member()), observedSince = '2026-09-11T08:00:00Z') {
  raw.spell.source = 'reconstructed'; raw.spell.uncertain = true;
  raw.membershipObservation = { observedSince, checkedAt: ago(.05), source: 'roster_snapshot', graceUntil: null };
  return raw;
}

test('verified current roster observations let legacy members build evidence without rewriting their original join', () => {
  const raw = observedLegacy(), original = plain(raw.spell);
  raw.events = [event('before', 'absent', { startsAt: '2026-09-10T18:00:00Z', endsAt: '2026-09-10T20:00:00Z', observedAt: '2026-09-10T20:00:00Z' }),
    event('a', 'absent'), event('b', 'absent'), event('c')];
  const result = assessed(raw);
  assert.equal(result.assessment.bucket, 'review'); assert.equal(result.protection.active, false);
  assert.deepEqual(plain(result.activity.evaluatedDates), ['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16']);
  assert.equal(result.activity.eligibleCompletedDays, 5); assert.equal(result.events.assignedCompleted, 3);
  assert.equal(result.events.absent, 2, 'An event before verified presence is never attributed to this club spell');
  assert.equal(result.protection.observedSince, '2026-09-11T08:00:00.000Z');
  assert.equal(result.protection.observationSource, 'roster_snapshot');
  assert.equal(result.protection.spellSource, 'reconstructed'); assert.equal(result.protection.spellStartedAt, original.startedAt);
  assert.ok(result.assessment.limitations.includes('observed_membership_only'));
  assert.equal(comparisonReasonLabels.observed_membership_only, 'Original join date is unknown; assessment starts at verified club observation');
  assert.deepEqual(plain(raw.spell), original, 'Observation evidence never changes historical provenance');
  const active = assessed(observedLegacy(member()));
  assert.equal(active.assessment.bucket, 'noConcern', 'Future sufficient activity can clear the legacy member for this observed period');
});

test('uncertain members need a fresh ordered roster anchor; coverage alone or relabeled historical events cannot lift protection', () => {
  const variations = [
    row => { delete row.membershipObservation; },
    row => { row.membershipObservation.source = 'recorded_event'; },
    row => { row.membershipObservation.source = null; },
    row => { row.membershipObservation.observedSince = null; },
    row => { row.membershipObservation.observedSince = 'invalid'; },
    row => { row.membershipObservation.observedSince = ago(-1); },
    row => { row.membershipObservation.observedSince = ago(.01); },
    row => { row.membershipObservation.checkedAt = null; },
    row => { row.membershipObservation.checkedAt = ago(-1); },
    row => { row.membershipObservation.checkedAt = ago(2.001); },
    row => { row.membershipObservation.graceUntil = 'invalid'; },
    row => { row.membershipObservation.graceUntil = ago(1000); },
  ];
  for (const mutate of variations) {
    const raw = observedLegacy(); raw.lastActivityAt = null; raw.lastBattleAt = null;
    raw.events = [event('a', 'absent'), event('b', 'absent'), event('c')]; mutate(raw);
    const result = assessed(raw);
    assert.equal(result.assessment.bucket, 'protected', String(mutate));
    assert.equal(result.protection.observedSince, null); assert.equal(result.activity.eligibleCompletedDays, 0);
    assert.equal(result.events.knownSample, 0); assert.equal(result.activity.noRecentActivity, false);
  }
});

test('roster observation grace and absence preserve protections and exclude the exact trailing 48-hour window', () => {
  const raw = observedLegacy(member(), ago(49)); raw.days = []; raw.lastActivityAt = null; raw.lastBattleAt = null;
  let result = assessed(raw);
  assert.equal(result.activity.noRecentActivity, true); assert.equal(result.assessment.bucket, 'review');
  for (const mutate of [
    row => { row.membershipObservation.observedSince = ago(47); },
    row => { row.membershipObservation.graceUntil = ago(24); },
    row => { row.coverage.trailing48hExcused = true; },
    row => { row.coverage.trailing48hGap = true; },
    row => { row.coverage.baselineAt = ago(47); },
  ]) {
    const changed = plain(raw); mutate(changed); result = assessed(changed);
    assert.equal(result.activity.noRecentActivity, false, String(mutate));
  }
  for (const mutate of [
    row => { row.membershipObservation.graceUntil = ago(-1); },
    row => { row.absence = { startsAt: ago(1), endsAt: ago(-1) }; },
    row => { row.role = 'president'; },
  ]) {
    const changed = plain(raw); mutate(changed); assert.equal(assessed(changed).assessment.bucket, 'protected');
  }
  const withGrace = observedLegacy(); withGrace.membershipObservation.graceUntil = '2026-09-13T00:00:00Z';
  withGrace.events = [event('during', 'absent')]; result = assessed(withGrace);
  assert.equal(result.activity.eligibleCompletedDays, 4); assert.equal(result.activity.excusedDays, 1);
  assert.equal(result.events.excused, 1); assert.equal(result.events.absent, 0);
});

test('a valid recorded current spell stays preferred while a newly observed legacy roster is insufficient, not permanently protected', () => {
  const recorded = quiet(member()); const oldStart = recorded.spell.startedAt;
  recorded.membershipObservation = { observedSince: ago(1), checkedAt: ago(.05), source: 'roster_snapshot', graceUntil: ago(-24) };
  let result = assessed(recorded);
  assert.equal(result.protection.observedSince, oldStart); assert.equal(result.protection.observationSource, 'recorded_event');
  assert.equal(result.protection.graceUntil, null); assert.equal(result.assessment.bucket, 'review');
  assert.equal(result.assessment.limitations.includes('observed_membership_only'), false);
  const members = Array.from({ length: 30 }, (_, index) => observedLegacy(member(`#PLAYER${index}`), ago(4)));
  const data = buildMemberComparison(snapshot(members));
  assert.equal(data.groups.insufficient, 30); assert.equal(data.groups.protected, 0); assert.equal(data.groups.review, 0);
  for (result of data.members) assert.equal(result.activity.eligibleCompletedDays, 0, 'Partial observation day is not completed evidence');
});

test('a later roster contradiction invalidates a recorded spell until new verified inclusion establishes an anchor', () => {
  const raw = quiet(member()); raw.spell.uncertain = true;
  raw.membershipObservation = { observedSince: null, checkedAt: ago(.05), source: null, graceUntil: null };
  let result = assessed(raw);
  assert.equal(result.assessment.bucket, 'protected'); assert.equal(result.protection.observedSince, null);
  assert.equal(result.protection.spellSource, 'recorded', 'Original historical provenance is preserved despite the later contradiction');
  raw.membershipObservation = { observedSince: ago(4), checkedAt: ago(.05), source: 'roster_snapshot', graceUntil: null };
  result = assessed(raw);
  assert.equal(result.assessment.bucket, 'insufficient'); assert.equal(result.activity.eligibleCompletedDays, 0);
  assert.equal(result.protection.observedSince, ago(4)); assert.equal(result.protection.observationSource, 'roster_snapshot');
  assert.equal(result.activity.noRecentActivity, false, 'An old join cannot satisfy the new continuous 48-hour requirement');
});
