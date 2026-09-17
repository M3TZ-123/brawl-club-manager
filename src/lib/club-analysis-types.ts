import type { BattleContextKey } from "@/lib/battle-catalog";
import type { TimeRangeKey } from "@/lib/time-range";

export type AnalysisStats = {
  observations: number; wins: number; losses: number; draws: number; unknownResults: number;
  winRate: number | null; durationObservations: number; recordedDurationSeconds: number;
  averageDurationSeconds: number | null;
};
export type AnalysisContext = { key: BattleContextKey; label: string };
export type AnalysisMode = { key: string; label: string };
export type AnalysisGroup = AnalysisStats & { context: AnalysisContext; mode?: AnalysisMode; map?: string; brawler?: string };
export type AnalysisPair = {
  player1: { tag: string; name: string }; player2: { tag: string; name: string }; context: AnalysisContext;
  matches: number; wins: number; losses: number; draws: number; unknownResults: number; winRate: number | null;
};
export type AnalysisResponse = {
  timeZone?: string;
  period: { key: TimeRangeKey; days: number; start: string; end: string; aggregation: "rolling" };
  filters: { context: string | null; mode: string | null; map: string | null; brawler: string | null };
  summary: AnalysisStats;
  modes: AnalysisGroup[]; maps: AnalysisGroup[]; brawlers: AnalysisGroup[]; pairs: AnalysisPair[];
  hourly: Array<AnalysisStats & { hour: number; uniquePlayers?: number; activeDays?: number }>;
  facets: {
    contexts: Array<AnalysisContext & { count: number }>;
    modes: Array<AnalysisMode & { count: number }>;
    maps: Array<{ key: string; count: number }>; brawlers: Array<{ key: string; count: number }>;
  };
  coverage: {
    status: "unknown" | "observed" | "possible_gap"; currentPlayers: number; monitoredPlayers: number;
    affectedPlayers: number; baselineAt: string | null; lastCheckedAt: string | null;
    earliestBattleAt: string | null; latestBattleAt: string | null; possibleGapCount: number;
    retainedGapWindowDays: number; requestedDays: number; fullPeriodMonitoredPlayers: number;
    stalePlayers: number; teamObservations: number; pairEligibleObservations: number;
    truncated: boolean; completeHistory: false;
  };
  limits: { observationLimit: number; groupLimit: number; facetLimit: number; truncated: boolean;
    groupCounts: { modes: number; maps: number; brawlers: number; pairs: number };
    facetCounts: { modes: number; maps: number; brawlers: number } };
  generatedAt: string;
};

export type ReportedEquipment = { id: number; name: string | null; level?: number | null };
export type ReadinessRow = {
  player: { tag: string; name: string }; brawler: { id: number; name: string };
  powerLevel: number | null; trophies: number | null; highestTrophies: number | null; rank: number | null;
  prestigeLevel: number | null; currentWinStreak: number | null; maxWinStreak: number | null;
  gadgets: ReportedEquipment[] | null; starPowers: ReportedEquipment[] | null;
  gears: ReportedEquipment[] | null; hyperCharges: ReportedEquipment[] | null;
  buffies: { gadget: boolean | null; starPower: boolean | null; hyperCharge: boolean | null } | null;
  observedAt: string | null; fieldCheckedAt: Record<string, string>;
};
export type ReadinessResponse = {
  members: Array<{ tag: string; name: string; brawlersObserved: number; power9Plus: number;
    power10Plus: number; power11: number; observedAt: string | null }>;
  brawlers: Array<{ id: number; name: string; playersObserved: number }>;
  rows: ReadinessRow[]; total: number; nextOffset: number | null; hasMore: boolean; generatedAt: string;
};
