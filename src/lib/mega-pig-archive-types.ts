import type { MegaPigSourceMember } from "@/lib/mega-pig-source-types";

export type MegaPigRewardStatus = "unknown" | "received" | "not_received";
export type MegaPigArchiveCycle = {
  id: string; title: string; startsAt: string; endsAt: string;
  milestones: number[] | null; version: number; createdAt: string; updatedAt: string;
  captureEnabled: boolean; capturePausedReason: "counters_decreased" | null; initialObservationId: string | null;
  lastCapturedAt: string | null; reportedTotalWins: number | null; reportedPlayersPlayed: number | null;
  finalTotalWins: number | null; confirmedStage: number | null;
  rewardStatus: MegaPigRewardStatus; finalizedAt: string | null; notes: string;
};
export type MegaPigArchiveMember = {
  playerTag: string; playerName: string; isCurrentMember: boolean;
  firstObservedAt: string | null; lastObservedAt: string | null;
  wins: number | null; ticketsRemaining: number | null;
  winsObservedAt: string | null; ticketsObservedAt: string | null;
  latestWinsUnknown: boolean; latestTicketsUnknown: boolean;
};
export type MegaPigObservationSummary = {
  id: string; firstFetchedAt: string | null; lastFetchedAt: string | null;
  totalWins: number; reportedPlayersPlayed: number; sourceMembers: number; unknownMembers: number;
};
export type MegaPigArchiveResponse = {
  clubTag: string; cycles?: MegaPigArchiveCycle[]; nextOffset?: number | null;
  observationCount?: number; latestObservation?: MegaPigObservationSummary | null;
  observations?: MegaPigObservationSummary[];
  cycle?: MegaPigArchiveCycle; members?: MegaPigArchiveMember[];
  observation?: MegaPigObservationSummary & { members: MegaPigSourceMember[] };
  playerTag?: string; history?: Array<{ cycle: MegaPigArchiveCycle; member: MegaPigArchiveMember }>;
  playerReadings?: Array<{ observation: MegaPigObservationSummary; member: MegaPigSourceMember }>;
};
export type MegaPigCycleInput = {
  title: string; startsAt: string; endsAt: string; milestones: number[] | null;
  captureEnabled: boolean; initialObservationId: string | null; notes: string;
};
export type MegaPigArchiveMutation =
  | { action: "save_cycle"; id: string | null; version: number; requestId: string; cycle: MegaPigCycleInput }
  | { action: "finalize_cycle"; id: string; version: number; finalTotalWins: number | null; confirmedStage: number | null; rewardStatus: MegaPigRewardStatus; notes: string }
  | { action: "reopen_cycle"; id: string; version: number; reason: string };
export type MegaPigCycleProgress = {
  lifecycle: "scheduled" | "active" | "ended" | "finalized";
  stage: number | null; stages: number | null; totalWins: number | null;
  target: number | null; remainingWins: number | null;
  goal: "unknown" | "in_progress" | "achieved" | "missed";
  basis: "confirmed" | "observed" | "unknown";
};
