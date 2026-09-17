/** Private comparison DTOs. No notes, absence reasons or upstream requests. */
export type MemberComparisonRange = "7d" | "30d" | "90d";
export type ComparisonBucket = "review" | "followup" | "noConcern" | "protected" | "insufficient";
export type ComparisonReason = "leadership" | "declared_absence" | "new_member_grace" | "uncertain_membership"
  | "low_observed_activity" | "no_recent_activity" | "repeated_event_absences" | "event_absence_followup"
  | "limited_activity_history" | "battle_history_gap" | "stale_battle_observation" | "old_gap_history"
  | "incomplete_event_records" | "limited_event_sample" | "events_truncated" | "stale_profile" | "stale_roster"
  | "candidate_commitment_unknown" | "observed_membership_only";

export type ComparisonProfile = {
  trophies: number | null; trophiesCheckedAt: string | null;
  power11: number | null; profileCheckedAt: string | null;
  rank: string | null; rankedPoints: number | null; rankedSeasonId: number | null; rankedCheckedAt: string | null;
};
export type RawComparisonDay = {
  date: string; battles: number | null; possibleGap: boolean; absenceOverlap: boolean;
};
export type RawComparisonEvent = {
  id: string; version: number; title: string; kind: string; startsAt: string; endsAt: string;
  status: "planned" | "completed" | "cancelled";
  attendance: "invited" | "confirmed" | "present" | "absent" | null;
  observedAt: string | null; absenceOverlap: boolean;
};
export type ComparisonMembershipObservation = {
  /** Start of the verified current observation period, never a reconstructed join date. */
  observedSince: string | null; checkedAt: string | null;
  source: "recorded_event" | "roster_snapshot" | null;
  graceUntil: string | null;
};
export type RawComparisonMember = {
  tag: string; name: string; role: string | null; profile: ComparisonProfile;
  lastActivityAt: string | null; lastBattleAt: string | null;
  spell: { startedAt: string | null; source: "recorded" | "reconstructed" | "unknown";
    kind: "join" | "initial_seen" | "unknown"; uncertain: boolean };
  graceUntil: string | null;
  /** Optional only for compatibility with snapshots predating the observation fallback. */
  membershipObservation?: ComparisonMembershipObservation;
  absence: { startsAt: string; endsAt: string } | null;
  coverage: { baselineAt: string | null; checkedAt: string | null; lastStatus: string;
    /** Any retained possible gap overlapping the trailing 48 hours. */
    trailing48hGap: boolean;
    /** Any declared absence or membership-grace overlap, including now-expired intervals. */
    trailing48hExcused: boolean };
  /** Exactly the requested completed UTC dates; missing rows remain unknown. */
  days: RawComparisonDay[];
  /** Assigned events only. SQL excludes unassigned members instead of inventing absence. */
  events: RawComparisonEvent[];
  eventsTruncated: boolean;
};
export type ComparisonCandidate = {
  kind: "candidate"; tag: string; name: string; profile: ComparisonProfile;
  status: string; commitment: "unknown";
};
export type RawMemberComparison = {
  clubTag: string; generatedAt: string; range: MemberComparisonRange;
  rosterCheckedAt: string | null; members: RawComparisonMember[]; candidates: ComparisonCandidate[];
};
export type ComparisonPolicy = {
  version: "activity-first-v1"; minEvaluatedDays: 5; minEvaluatedFraction: 0.8;
  targetActiveDaysPerWeek: 3; minKnownEvents: 3; repeatedAbsences: 2;
  inactivityHours: 48; monitoringFreshMinutes: 35; profileFreshHours: 2; gapHistoryDays: 28;
};
export type ComparisonMember = {
  kind: "member"; tag: string; name: string; role: string | null; profile: ComparisonProfile;
  activity: {
    observedActiveDays: number; evaluatedDays: number; eligibleCompletedDays: number;
    unknownDays: number; excusedDays: number; minimumExpectedActiveDays: number;
    sufficientSample: boolean; lowObservedActivity: boolean; noRecentActivity: boolean;
    baselineAt: string | null; checkedAt: string | null; lastActivityAt: string | null;
    possibleGap: boolean; rangeLimited: boolean; evaluatedDates: string[];
  };
  events: {
    assignedCompleted: number; present: number; absent: number; unresolved: number;
    excused: number; knownSample: number; sufficientSample: boolean; repeatedAbsences: boolean;
    evidence: Array<{ eventId: string; version: number; title: string; endedAt: string; attendance: "present" | "absent"; observedAt: string }>;
  };
  protection: {
    active: boolean; leadership: boolean; activeAbsence: boolean; absenceUntil: string | null;
    graceUntil: string | null; spellStartedAt: string | null; spellSource: RawComparisonMember["spell"]["source"];
    observedSince: string | null; observationSource: ComparisonMembershipObservation["source"];
    observationCheckedAt: string | null;
  };
  assessment: {
    bucket: ComparisonBucket; priority: "high" | "normal" | null; position: number | null;
    reasons: ComparisonReason[]; limitations: ComparisonReason[];
    confidence: "sufficient" | "limited" | "insufficient";
  };
};
export type MemberComparisonResponse = {
  clubTag: string; generatedAt: string; rosterCheckedAt: string | null;
  period: { key: MemberComparisonRange; days: number; start: string; end: string; timezone: "UTC"; completedDaysOnly: true };
  policy: ComparisonPolicy; members: ComparisonMember[]; candidates: ComparisonCandidate[];
  groups: Record<ComparisonBucket, number>;
};
export type ComparisonSubject = { kind: "member" | "candidate"; tag: string };
export type ComparisonMetric = {
  key: "activeDays" | "eventAttendance" | "trophies" | "power11" | "rankedPoints";
  left: number | null; right: number | null; delta: number | null;
  comparable: boolean; reason: "comparable" | "unknown" | "stale" | "different_season" | "different_exposure" | "candidate_commitment_unknown";
  leftCheckedAt: string | null; rightCheckedAt: string | null;
};
export type MemberHeadToHead = {
  left: ComparisonSubject; right: ComparisonSubject; metrics: ComparisonMetric[];
  rosterImpact: { trophies: number | null; power11: number | null } | null;
  /** Profile differences never establish future attendance or club commitment. */
  commitmentComparable: boolean; canEstimateReplacement: boolean;
  limitations: Array<"candidate_commitment_unknown" | "protected_member" | "existing_member" | "profile_only" | "insufficient_evidence">;
};
