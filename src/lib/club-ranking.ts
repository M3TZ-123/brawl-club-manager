import { clubTagInput, type ClubRankObservation } from "@/lib/club-rivals-data";
import type { GameRegion } from "@/lib/game-data";

export type RecordedClubRank = {
  day: string;
  at: string;
  rank: number | null;
  state: "ranked" | "outside_top50" | "conflicting";
};

export type ClubRankingSummary = {
  history: RecordedClubRank[];
  latest: RecordedClubRank | null;
  previous: RecordedClubRank | null;
  placesGained: number | null;
  hasChart: boolean;
};

export function rankingTimestamp(value: unknown, now = Date.now()): string | null {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && Number.isFinite(now) && at <= now ? new Date(at).toISOString() : null;
}

/** Keep the last actual observation per UTC day; absence is not a rank. */
export function summarizeClubRanking(tag: string, region: GameRegion, observations: readonly ClubRankObservation[], now = Date.now()): ClubRankingSummary {
  const empty: ClubRankingSummary = { history: [], latest: null, previous: null, placesGained: null, hasChart: false };
  let expectedTag: string;
  try { expectedTag = clubTagInput(tag); } catch { return empty; }
  if (!Array.isArray(observations)) return empty;
  const days = new Map<string, RecordedClubRank>();
  for (const row of observations) {
    if (!row || row.region !== region) continue;
    try { if (clubTagInput(row.tag) !== expectedTag) continue; } catch { continue; }
    const at = rankingTimestamp(row.at, now);
    if (!at || row.rank !== null && (!Number.isInteger(row.rank) || row.rank < 1 || row.rank > 50)) continue;
    const day = at.slice(0, 10), previous = days.get(day);
    const next: RecordedClubRank = { day, at, rank: row.rank, state: row.rank === null ? "outside_top50" : "ranked" };
    if (!previous || at > previous.at) days.set(day, next);
    // Conflicting snapshots at the very same instant cannot establish a rank
    // or prove absence from the top 50. Do not choose by input array order.
    else if (at === previous.at && (previous.state === "conflicting" || row.rank !== previous.rank)) {
      days.set(day, { day, at, rank: null, state: "conflicting" });
    }
  }
  const history = [...days.values()].sort((left, right) => left.at.localeCompare(right.at));
  const latest = history.at(-1) || null, previous = history.at(-2) || null;
  const placesGained = latest?.state === "ranked" && previous?.state === "ranked" ? previous.rank! - latest.rank! : null;
  return { history, latest, previous, placesGained, hasChart: history.filter(row => row.state === "ranked").length >= 2 };
}
