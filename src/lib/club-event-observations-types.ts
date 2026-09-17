/** Saved battle observations, not attendance, ticket use or official club credits. */
export type ClubEventCoverageStatus = "unknown" | "baseline" | "observed" | "possible_gap" | "failed" | "empty" | "regressing";
export type ClubEventObservedMember = {
  playerTag: string; playerName: string;
  /** Lower bounds on saved player-battle rows during this event's time window. */
  observedBattles: number; lastObservedBattleAt: string | null;
  /** Only an explicit battle.type=megaPig marker; not proof of club contribution. */
  explicitMegaPigBattles: number; lastExplicitMegaPigBattleAt: string | null;
  authoritativeWins: null; ticketsRemaining: null;
  coverage: { baselineAt: string | null; checkedAt: string | null; status: ClubEventCoverageStatus; possibleGap: boolean };
};
export type ClubEventObservationsResponse = {
  clubTag: string; eventId: string; eventVersion: number;
  status: "planned" | "completed" | "cancelled";
  startsAt: string; endsAt: string; observedUntil: string; generatedAt: string; hasStarted: boolean;
  historyLimited: true; classification: "explicit_battle_type_only";
  /** Stale refers to the last complete battle-log refresh, not roster-only checks. */
  sync: { lastFullSyncAt: string | null; lastBattleSyncAt: string | null; stale: boolean };
  members: ClubEventObservedMember[];
};
export type ClubEventObservations = ClubEventObservationsResponse;
