import type {
  ComparisonBucket, ComparisonCandidate, ComparisonMember, ComparisonMetric, ComparisonPolicy, ComparisonProfile,
  ComparisonReason, ComparisonSubject, MemberComparisonResponse, MemberHeadToHead, RawComparisonMember, RawMemberComparison,
} from "./member-comparison-types";

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const comparisonPolicy: ComparisonPolicy = {
  version: "activity-first-v1", minEvaluatedDays: 5, minEvaluatedFraction: 0.8,
  targetActiveDaysPerWeek: 3, minKnownEvents: 3, repeatedAbsences: 2,
  inactivityHours: 48, monitoringFreshMinutes: 35, profileFreshHours: 2, gapHistoryDays: 28,
};
export const comparisonReasonLabels: Record<ComparisonReason, string> = {
  leadership: "Leadership needs manual review",
  declared_absence: "Currently on a declared absence",
  new_member_grace: "New-member grace period",
  uncertain_membership: "Current membership dates are uncertain",
  low_observed_activity: "Low observed activity across the evaluated days",
  no_recent_activity: "No activity recorded in the last 48 hours",
  repeated_event_absences: "Repeated recorded absences from completed events",
  event_absence_followup: "A recorded event absence needs follow-up",
  limited_activity_history: "Not enough comparable activity history",
  battle_history_gap: "Possible gaps affect battle history",
  stale_battle_observation: "Battle observations need an update",
  old_gap_history: "Older dates exceed the gap-audit window",
  incomplete_event_records: "Some completed events have no final attendance record",
  limited_event_sample: "Fewer than three known event outcomes",
  events_truncated: "Event history is limited",
  stale_profile: "Profile figures need an update before comparison",
  stale_roster: "The club roster needs an update before review",
  candidate_commitment_unknown: "Candidate activity and club commitment are unknown",
  observed_membership_only: "Original join date is unknown; assessment starts at verified club observation",
};

function timestamp(value: string | null | undefined, latest = Infinity): number | null {
  const parsed = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed <= latest ? parsed : null;
}
function iso(value: string | null | undefined, latest = Infinity): string | null {
  const at = timestamp(value, latest); return at === null ? null : new Date(at).toISOString();
}
function count(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function fresh(value: string | null, now: number, age = comparisonPolicy.profileFreshHours * HOUR): boolean {
  const at = timestamp(value, now); return at !== null && at >= now - age;
}
function profile(value: ComparisonProfile, now: number): ComparisonProfile {
  return {
    trophies: count(value.trophies), trophiesCheckedAt: iso(value.trophiesCheckedAt, now),
    power11: count(value.power11), profileCheckedAt: iso(value.profileCheckedAt, now),
    rank: typeof value.rank === "string" && value.rank.trim() ? value.rank : null,
    rankedPoints: count(value.rankedPoints), rankedSeasonId: count(value.rankedSeasonId), rankedCheckedAt: iso(value.rankedCheckedAt, now),
  };
}
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
const bucketOrder: Record<ComparisonBucket, number> = { review: 0, followup: 1, noConcern: 2, protected: 3, insufficient: 4 };
export type ComparisonOrder = "review" | "activity" | "attendance";

/** Sorts within fixed evidence/protection groups. It never changes the assessment. */
export function sortComparisonMembers(members: ComparisonMember[], order: ComparisonOrder = "review"): ComparisonMember[] {
  const active = (member: ComparisonMember) => member.activity.eligibleCompletedDays
    ? (member.activity.observedActiveDays + member.activity.unknownDays) / member.activity.eligibleCompletedDays : Infinity;
  const missed = (member: ComparisonMember) => member.events.knownSample ? member.events.absent / member.events.knownSample : -1;
  const concerns = (member: ComparisonMember) => Number(member.activity.lowObservedActivity || member.activity.noRecentActivity) + Number(member.events.repeatedAbsences);
  const sorted = [...members].sort((left, right) => {
    const group = bucketOrder[left.assessment.bucket] - bucketOrder[right.assessment.bucket];
    if (group) return group;
    if (["protected", "insufficient"].includes(left.assessment.bucket)) return left.tag.localeCompare(right.tag);
    if (order === "review") {
      const both = concerns(right) - concerns(left);
      if (both) return both;
      const recent = Number(right.activity.noRecentActivity) - Number(left.activity.noRecentActivity);
      if (recent) return recent;
    }
    const activityOrder = active(left) - active(right);
    const eventOrder = missed(right) - missed(left);
    return (order === "attendance" ? eventOrder || activityOrder : activityOrder || eventOrder) || left.tag.localeCompare(right.tag);
  });
  let position = 0;
  return sorted.map(member => ({ ...member, assessment: { ...member.assessment,
    position: member.assessment.bucket === "review" ? ++position : null } }));
}

function assessMember(raw: RawComparisonMember, dates: string[], now: number, start: number, end: number, rosterFresh: boolean): ComparisonMember {
  if (raw.days.length > 90 || raw.events.length > 100 || new Set(raw.days.map(day => day.date)).size !== raw.days.length
    || new Set(raw.events.map(event => event.id)).size !== raw.events.length) throw new Error("Invalid comparison evidence");
  const values = profile(raw.profile, now);
  const baseline = timestamp(raw.coverage.baselineAt, now), checked = timestamp(raw.coverage.checkedAt, now);
  const originalStarted = timestamp(raw.spell.startedAt, now);
  const recordedSpell = !raw.spell.uncertain && raw.spell.source === "recorded"
    && ["join", "initial_seen"].includes(raw.spell.kind) && originalStarted !== null;
  const observation = raw.membershipObservation;
  const observedSince = timestamp(observation?.observedSince, now), observationChecked = timestamp(observation?.checkedAt, now);
  const observationGrace = timestamp(observation?.graceUntil);
  // SQL establishes current-club continuity from accepted roster observations.
  // Keep that evidence separate from the original, possibly reconstructed join.
  const fallback = !recordedSpell && observation?.source === "roster_snapshot" && observedSince !== null
    && observationChecked !== null && observedSince <= observationChecked && fresh(observation.checkedAt, now)
    && (observation.graceUntil === null || (observationGrace !== null && observationGrace >= observedSince));
  const started = recordedSpell ? originalStarted : fallback ? observedSince : null;
  const grace = recordedSpell ? timestamp(raw.graceUntil) : fallback ? observationGrace : null;
  const uncertain = started === null;
  const observationSource = recordedSpell ? "recorded_event" : fallback ? "roster_snapshot" : null;
  const absenceStart = timestamp(raw.absence?.startsAt), absenceEnd = timestamp(raw.absence?.endsAt);
  const activeAbsence = absenceStart !== null && absenceEnd !== null && absenceStart <= now && absenceEnd > now;
  const leadership = ["president", "vicepresident"].includes((raw.role || "").toLowerCase().replace(/[ _]/g, ""));
  const newMember = grace !== null && grace > now;
  const reasons: ComparisonReason[] = [], limitations: ComparisonReason[] = [];
  if (leadership) reasons.push("leadership");
  if (activeAbsence) reasons.push("declared_absence");
  if (newMember) reasons.push("new_member_grace");
  if (uncertain) reasons.push("uncertain_membership");
  if (fallback) limitations.push("observed_membership_only");
  const protectedMember = leadership || activeAbsence || newMember || uncertain;
  const dayRows = new Map(raw.days.map(day => [day.date, day]));
  const evaluatedDates: string[] = [];
  let observedActiveDays = 0, eligibleCompletedDays = 0, unknownDays = 0, excusedDays = 0, possibleGap = false, rangeLimited = false;
  for (const date of dates) {
    const dayStart = Date.parse(date), dayEnd = dayStart + DAY, row = dayRows.get(date);
    if (started === null || started > dayStart) continue;
    if (row?.absenceOverlap || (grace !== null && grace > dayStart)) { excusedDays++; continue; }
    eligibleCompletedDays++;
    const battles = count(row?.battles);
    const gap = row?.possibleGap === true; possibleGap ||= gap;
    const older = dayStart < now - comparisonPolicy.gapHistoryDays * DAY; rangeLimited ||= older;
    // A recorded battle proves participation even with partial coverage. A zero
    // needs an explicit daily observation plus a monitored, gap-free date.
    const monitored = baseline !== null && baseline <= dayStart && checked !== null && checked >= dayEnd && !gap && !older;
    if (battles !== null && (battles > 0 || monitored)) {
      evaluatedDates.push(date); if (battles > 0) observedActiveDays++;
    } else unknownDays++;
  }
  const evaluatedDays = evaluatedDates.length;
  const sufficientActivity = evaluatedDays >= comparisonPolicy.minEvaluatedDays && eligibleCompletedDays > 0
    && evaluatedDays / eligibleCompletedDays >= comparisonPolicy.minEvaluatedFraction;
  const expected = Math.ceil(eligibleCompletedDays * comparisonPolicy.targetActiveDaysPerWeek / 7);
  // Give every unknown day the benefit of possible participation. Missing data
  // can never make the member cross the low-activity threshold by itself.
  const lowObservedActivity = sufficientActivity && observedActiveDays + unknownDays < expected;
  const actual = [timestamp(raw.lastActivityAt, now), timestamp(raw.lastBattleAt, now)].filter((value): value is number => value !== null);
  const activityTimestampsValid = [raw.lastActivityAt, raw.lastBattleAt].every(value => value == null || timestamp(value, now) !== null);
  const lastActivity = actual.length ? Math.max(...actual) : null;
  const cutoff = now - comparisonPolicy.inactivityHours * HOUR;
  const monitoringFresh = checked !== null && checked >= now - comparisonPolicy.monitoringFreshMinutes * 60_000;
  const noRecentActivity = activityTimestampsValid && !uncertain && started !== null && started <= cutoff && baseline !== null && baseline <= cutoff
    && monitoringFresh && raw.coverage.lastStatus === "observed" && raw.coverage.trailing48hGap === false
    && raw.coverage.trailing48hExcused === false && (grace === null || grace <= cutoff)
    && (lastActivity === null || lastActivity <= cutoff);
  if (!sufficientActivity) limitations.push("limited_activity_history");
  if (possibleGap || raw.coverage.trailing48hGap) limitations.push("battle_history_gap");
  if (!monitoringFresh) limitations.push("stale_battle_observation");
  if (rangeLimited) limitations.push("old_gap_history");

  let assignedCompleted = 0, present = 0, absent = 0, unresolved = 0, excused = 0;
  const evidence: ComparisonMember["events"]["evidence"] = [];
  for (const event of raw.events) {
    const eventStart = timestamp(event.startsAt, now), eventEnd = timestamp(event.endsAt, now);
    if (event.status !== "completed" || eventStart === null || eventEnd === null || eventEnd <= eventStart || eventEnd <= start || eventEnd > end) continue;
    if (started === null || eventStart < started) continue;
    assignedCompleted++;
    if (event.absenceOverlap || (grace !== null && eventStart < grace)) { excused++; continue; }
    const at = timestamp(event.observedAt, now);
    if (!["present", "absent"].includes(event.attendance || "") || at === null || at < eventStart || at > eventEnd) { unresolved++; continue; }
    const attendance = event.attendance as "present" | "absent";
    if (attendance === "present") present++; else absent++;
    evidence.push({ eventId: event.id, version: event.version, title: event.title, endedAt: new Date(eventEnd).toISOString(), attendance, observedAt: new Date(at).toISOString() });
  }
  const knownSample = present + absent;
  const sufficientEvents = !raw.eventsTruncated && knownSample >= comparisonPolicy.minKnownEvents;
  const repeatedAbsences = sufficientEvents && absent >= comparisonPolicy.repeatedAbsences;
  if (unresolved) limitations.push("incomplete_event_records");
  if (!sufficientEvents) limitations.push("limited_event_sample");
  if (raw.eventsTruncated) limitations.push("events_truncated");
  if (!fresh(values.profileCheckedAt, now)) limitations.push("stale_profile");
  if (!rosterFresh) limitations.push("stale_roster");
  let bucket: ComparisonBucket;
  if (protectedMember) bucket = "protected";
  else if (!rosterFresh) bucket = "insufficient";
  else if (lowObservedActivity || noRecentActivity || repeatedAbsences) bucket = "review";
  else if (absent > 0) bucket = "followup";
  else if (sufficientActivity || sufficientEvents) bucket = "noConcern";
  else bucket = "insufficient";
  if (lowObservedActivity) reasons.push("low_observed_activity");
  if (noRecentActivity) reasons.push("no_recent_activity");
  if (repeatedAbsences) reasons.push("repeated_event_absences");
  else if (absent > 0) reasons.push("event_absence_followup");
  const bothConcerns = (lowObservedActivity || noRecentActivity) && repeatedAbsences;
  return {
    kind: "member", tag: raw.tag, name: raw.name, role: raw.role, profile: values,
    activity: { observedActiveDays, evaluatedDays, eligibleCompletedDays, unknownDays, excusedDays,
      minimumExpectedActiveDays: expected, sufficientSample: sufficientActivity, lowObservedActivity, noRecentActivity,
      baselineAt: iso(raw.coverage.baselineAt, now), checkedAt: iso(raw.coverage.checkedAt, now),
      lastActivityAt: lastActivity === null ? null : new Date(lastActivity).toISOString(), possibleGap, rangeLimited, evaluatedDates },
    events: { assignedCompleted, present, absent, unresolved, excused, knownSample, sufficientSample: sufficientEvents, repeatedAbsences, evidence },
    protection: { active: protectedMember, leadership, activeAbsence, absenceUntil: activeAbsence ? iso(raw.absence?.endsAt) : null,
      graceUntil: grace === null ? null : new Date(grace).toISOString(), spellStartedAt: iso(raw.spell.startedAt, now), spellSource: raw.spell.source,
      observedSince: started === null ? null : new Date(started).toISOString(), observationSource,
      observationCheckedAt: observationSource !== null && observationChecked !== null && started !== null && observationChecked >= started
        ? new Date(observationChecked).toISOString() : null },
    assessment: { bucket, priority: bucket === "review" ? bothConcerns ? "high" : "normal" : null, position: null,
      reasons: unique(reasons), limitations: unique(limitations), confidence: bucket === "protected" || !rosterFresh ? "insufficient"
        : sufficientActivity && sufficientEvents && !unknownDays && !unresolved && !possibleGap ? "sufficient"
          : sufficientActivity || sufficientEvents || noRecentActivity ? "limited" : "insufficient" },
  };
}

export function buildMemberComparison(raw: RawMemberComparison): MemberComparisonResponse {
  const now = timestamp(raw.generatedAt);
  if (now === null || !["7d", "30d", "90d"].includes(raw.range) || raw.members.length > 30 || raw.candidates.length > 100
    || new Set(raw.members.map(member => member.tag)).size !== raw.members.length
    || new Set(raw.candidates.map(candidate => candidate.tag)).size !== raw.candidates.length) throw new Error("Invalid comparison snapshot");
  const days = Number.parseInt(raw.range, 10), end = Date.parse(new Date(now).toISOString().slice(0, 10)), start = end - days * DAY;
  const dates = Array.from({ length: days }, (_, index) => new Date(start + index * DAY).toISOString().slice(0, 10));
  const members = sortComparisonMembers(raw.members.map(member => assessMember(member, dates, now, start, end, fresh(raw.rosterCheckedAt, now))));
  const groups: Record<ComparisonBucket, number> = { review: 0, followup: 0, noConcern: 0, protected: 0, insufficient: 0 };
  members.forEach(member => groups[member.assessment.bucket]++);
  return { clubTag: raw.clubTag, generatedAt: new Date(now).toISOString(), rosterCheckedAt: iso(raw.rosterCheckedAt, now),
    period: { key: raw.range, days, start: new Date(start).toISOString(), end: new Date(end).toISOString(), timezone: "UTC", completedDaysOnly: true },
    policy: { ...comparisonPolicy }, members, candidates: raw.candidates.map(candidate => ({ kind: "candidate", tag: candidate.tag, name: candidate.name,
      status: candidate.status, profile: profile(candidate.profile, now), commitment: "unknown" })), groups };
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every(value => right.includes(value));
}
export function compareMembers(data: MemberComparisonResponse, left: ComparisonSubject, right: ComparisonSubject): MemberHeadToHead {
  const find = (subject: ComparisonSubject): ComparisonMember | ComparisonCandidate => {
    const row = (subject.kind === "member" ? data.members : data.candidates).find(row => row.tag === subject.tag);
    if (!row) throw new Error("Comparison subject is unavailable"); return row;
  };
  const a = find(left), b = find(right), now = timestamp(data.generatedAt);
  if (now === null) throw new Error("Invalid comparison timestamp");
  const capability = (key: "trophies" | "power11" | "rankedPoints", stamp: keyof ComparisonProfile): ComparisonMetric => {
    const first = a.profile[key], second = b.profile[key], firstAt = a.profile[stamp] as string | null, secondAt = b.profile[stamp] as string | null;
    const known = first !== null && second !== null && firstAt !== null && secondAt !== null;
    let reason: ComparisonMetric["reason"] = !known ? "unknown" : !fresh(firstAt, now) || !fresh(secondAt, now) ? "stale" : "comparable";
    if (reason === "comparable" && key === "rankedPoints") {
      if (a.profile.rankedSeasonId === null || b.profile.rankedSeasonId === null) reason = "unknown";
      else if (a.profile.rankedSeasonId !== b.profile.rankedSeasonId) reason = "different_season";
    }
    return { key, left: first, right: second, delta: reason === "comparable" ? second! - first! : null,
      comparable: reason === "comparable", reason, leftCheckedAt: firstAt, rightCheckedAt: secondAt };
  };
  const isMembers = a.kind === "member" && b.kind === "member";
  const activityComparable = isMembers && a.activity.sufficientSample && b.activity.sufficientSample
    && sameSet(a.activity.evaluatedDates, b.activity.evaluatedDates);
  const eventComparable = isMembers && a.events.sufficientSample && b.events.sufficientSample
    && sameSet(a.events.evidence.map(event => `${event.eventId}:${event.version}`), b.events.evidence.map(event => `${event.eventId}:${event.version}`));
  const behavior = (key: "activeDays" | "eventAttendance", comparable: boolean): ComparisonMetric => {
    const value = (row: ComparisonMember | ComparisonCandidate) => row.kind === "candidate" ? null : key === "activeDays"
      ? row.activity.evaluatedDays > 0 ? row.activity.observedActiveDays : null
      : row.events.knownSample ? row.events.present * 100 / row.events.knownSample : null;
    const first = value(a), second = value(b);
    return { key, left: first, right: second, delta: comparable ? second! - first! : null, comparable,
      reason: !isMembers ? "candidate_commitment_unknown" : comparable ? "comparable" : "different_exposure",
      leftCheckedAt: a.kind === "member" ? key === "activeDays" ? a.activity.checkedAt : a.events.evidence.map(event => event.observedAt).sort().at(-1) ?? null : null,
      rightCheckedAt: b.kind === "member" ? key === "activeDays" ? b.activity.checkedAt : b.events.evidence.map(event => event.observedAt).sort().at(-1) ?? null : null };
  };
  const metrics = [behavior("activeDays", activityComparable), behavior("eventAttendance", eventComparable),
    capability("trophies", "trophiesCheckedAt"), capability("power11", "profileCheckedAt"), capability("rankedPoints", "rankedCheckedAt")];
  const currentMember = a.kind === "member" ? a : b.kind === "member" ? b : null;
  const prospect = a.kind === "candidate" ? a : b.kind === "candidate" ? b : null;
  const existing = isMembers || (prospect !== null && data.members.some(member => member.tag === prospect.tag));
  const outside = currentMember !== null && prospect !== null && !existing && fresh(data.rosterCheckedAt, now);
  const candidateDelta = (key: "trophies" | "power11") => {
    const delta = metrics.find(metric => metric.key === key)!.delta;
    return delta === null ? null : delta * (b.kind === "candidate" ? 1 : -1);
  };
  const trophies = candidateDelta("trophies"), power11 = candidateDelta("power11");
  const limitations: MemberHeadToHead["limitations"] = [];
  if (!isMembers) limitations.push("candidate_commitment_unknown", "profile_only");
  if ((a.kind === "member" && a.protection.active) || (b.kind === "member" && b.protection.active)) limitations.push("protected_member");
  if (existing) limitations.push("existing_member");
  if (!activityComparable || !eventComparable) limitations.push("insufficient_evidence");
  return { left: { ...left }, right: { ...right }, metrics, rosterImpact: outside ? { trophies, power11 } : null,
    commitmentComparable: isMembers && activityComparable && eventComparable,
    canEstimateReplacement: outside && (trophies !== null || power11 !== null), limitations };
}
export function compareReplacement(data: MemberComparisonResponse, memberTag: string, other: ComparisonSubject): MemberHeadToHead {
  return compareMembers(data, { kind: "member", tag: memberTag }, other);
}
