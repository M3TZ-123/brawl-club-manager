import type { AnalysisPair, AnalysisResponse } from "@/lib/club-analysis-types";

export const TEAMMATE_PAGE_SIZE = 12;
export const TEAMMATE_COMPARISON_MINIMUM = 10;
export type TeammateSort = "matches" | "win_rate";

export const teammateDecidedResults = (pair: AnalysisPair) => pair.wins + pair.losses;
export function teammateWinRate(pair: AnalysisPair) {
  return teammateDecidedResults(pair) > 0 && pair.winRate != null && Number.isFinite(pair.winRate) && pair.winRate >= 0 && pair.winRate <= 100
    ? pair.winRate : null;
}

export const teammatePairKey = (pair: AnalysisPair) => `${pair.context.key}:${pair.player1.tag}:${pair.player2.tag}`;
const sharedOrder = (left: AnalysisPair, right: AnalysisPair) => right.matches - left.matches
  || teammateDecidedResults(right) - teammateDecidedResults(left)
  || teammatePairKey(left).localeCompare(teammatePairKey(right));

export function selectTeammatePairs(pairs: AnalysisPair[], { query, minimumMatches, sort }: { query: string; minimumMatches: number; sort: TeammateSort }) {
  const search = query.trim().toLocaleLowerCase();
  const filtered = pairs.filter(pair => pair.matches >= minimumMatches
    && (!search || [pair.player1.name, pair.player1.tag, pair.player2.name, pair.player2.tag].some(value => value.toLocaleLowerCase().includes(search))));
  return filtered.sort((left, right) => {
    if (sort === "matches") return sharedOrder(left, right);
    const leftRate = teammateWinRate(left), rightRate = teammateWinRate(right);
    const bucket = (pair: AnalysisPair, rate: number | null) => rate == null ? 2 : teammateDecidedResults(pair) >= TEAMMATE_COMPARISON_MINIMUM ? 0 : 1;
    const leftBucket = bucket(left, leftRate), rightBucket = bucket(right, rightRate);
    return leftBucket - rightBucket || (leftBucket === 0 ? rightRate! - leftRate! : 0) || sharedOrder(left, right);
  });
}

/** Pagination follows visible pair data, not object identity or a refresh timestamp. */
export function teammateDataKey(data: AnalysisResponse) {
  return JSON.stringify([data.period.key, data.filters.context, data.filters.mode, data.filters.map, data.filters.brawler,
    data.pairs.map(pair => [pair.context.key, pair.context.label, pair.player1.tag, pair.player1.name, pair.player2.tag, pair.player2.name,
      pair.matches, pair.wins, pair.losses, pair.draws, pair.unknownResults, pair.winRate])]);
}
