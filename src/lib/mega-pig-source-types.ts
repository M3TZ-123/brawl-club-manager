/** Third-party reported counters; the provider does not identify their cycle or update time. */
export type MegaPigSourceMember = {
  playerTag: string; playerName: string; reportedWins: number | null; reportedTicketsRemaining: number | null;
};
export type MegaPigSourceName = "BrawlAce" | "BrawlTools";
export type MegaPigSourcePayload = {
  clubTag: string; source: MegaPigSourceName; totalWins: number;
  reportedPlayersPlayed: number | null; reportedBattlesPlayed: number | null; members: MegaPigSourceMember[];
};
export type MegaPigSourceResponse = {
  clubTag: string;
  source: { name: MegaPigSourceName; url: string; official: false; cycleVerified: false; updatedAt: null };
  status: "available" | "stale" | "unavailable" | "pending";
  fetchedAt: string | null; lastAttemptAt: string | null; nextCheckAt: string | null;
  changedAt: string | null; updating: boolean;
  totalWins: number | null; reportedPlayersPlayed: number | null; reportedBattlesPlayed: number | null;
  matchedMembers: number; sourceMembers: number; rosterMembers: number;
  members: Array<{
    playerTag: string; playerName: string;
    reportedWins: number | null; reportedTicketsRemaining: number | null;
  }>;
};
