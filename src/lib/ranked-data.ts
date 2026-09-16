// Profile fields are preferred independently: a partial response must not erase
// another known value or turn missing data into Bronze I/Unranked.
const tiers = ["Unranked", "Bronze I", "Bronze II", "Bronze III", "Silver I", "Silver II", "Silver III", "Gold I", "Gold II", "Gold III", "Diamond I", "Diamond II", "Diamond III", "Mythic I", "Mythic II", "Mythic III", "Legendary I", "Legendary II", "Legendary III", "Masters I", "Masters II", "Masters III", "Pro"];
const names = new Map(tiers.map(name => [name.toUpperCase(), name]));
names.set("NONE", "Unranked");
names.set("MASTERS", "Masters"); // Historical rank before the Masters divisions.

export type RankedSource = "profile" | "rnt" | "mixed";
export type RankedFields = {
  rank_current?: string; rank_highest?: string; ranked_points?: number;
  ranked_season_id?: number; ranked_season_best?: string;
  ranked_season_best_points?: number; ranked_all_time_best_points?: number;
};
type Field = keyof RankedFields;
export type RankedObservation = { fields: RankedFields; sources: Partial<Record<Field, "profile" | "rnt">> };
export type RankedFallback = { currentRank: string; highestRank: string; currentPoints: number; highestPoints: number; available?: boolean };

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : undefined;
}
function tier(name: unknown, rank: unknown): string | undefined {
  if (typeof name === "string" && name.trim()) return names.get(name.trim().replace(/\s+/g, " ").toUpperCase());
  // The named profile fields are authoritative; nonzero numeric enums can
  // change between API versions. Do not infer a future tier from an unknown ID.
  return rank === 0 ? "Unranked" : undefined;
}

export function readProfileRankedData(player: object): RankedObservation {
  const p = player as Record<string, unknown>;
  const fields: RankedFields = {
    rank_current: tier(p.rankedRankName, p.rankedRank),
    rank_highest: tier(p.highestAllTimeRankedRankName, p.highestAllTimeRankedRank),
    ranked_points: nonnegativeInteger(p.rankedElo),
    ranked_all_time_best_points: nonnegativeInteger(p.highestAllTimeRankedElo),
    ranked_season_id: nonnegativeInteger(p.rankedSeasonId),
    ranked_season_best: tier(p.highestSeasonRankedRankName, p.highestSeasonRankedRank),
    ranked_season_best_points: nonnegativeInteger(p.highestSeasonRankedElo),
  };
  // A season-best observation without its season cannot safely replace a value
  // belonging to a known season, especially across resets.
  if (fields.ranked_season_id === undefined) {
    delete fields.ranked_season_best;
    delete fields.ranked_season_best_points;
  }
  const result: RankedObservation = { fields: {}, sources: {} };
  for (const key of Object.keys(fields) as Field[]) {
    if (fields[key] !== undefined) {
      Object.assign(result.fields, { [key]: fields[key] });
      result.sources[key] = "profile";
    }
  }
  return result;
}

export function rankedCoreComplete(observation: RankedObservation): boolean {
  return ["rank_current", "rank_highest", "ranked_points", "ranked_all_time_best_points"]
    .every(key => observation.fields[key as Field] !== undefined);
}

export function mergeRankedFallback(profile: RankedObservation, fallback?: RankedFallback | null): RankedObservation {
  const result = { fields: { ...profile.fields }, sources: { ...profile.sources } };
  if (fallback?.available !== true) return result;
  const extra: RankedFields = {
    rank_current: tier(fallback.currentRank, undefined), rank_highest: tier(fallback.highestRank, undefined),
    ranked_points: nonnegativeInteger(fallback.currentPoints), ranked_all_time_best_points: nonnegativeInteger(fallback.highestPoints),
  };
  for (const key of Object.keys(extra) as Field[]) {
    if (result.fields[key] === undefined && extra[key] !== undefined) {
      Object.assign(result.fields, { [key]: extra[key] });
      result.sources[key] = "rnt";
    }
  }
  return result;
}

export function rankedSnapshot(observation: RankedObservation, checkedAt: string) {
  const complete = rankedCoreComplete(observation);
  const sourceSet = new Set(Object.values(observation.sources));
  const source: RankedSource = sourceSet.size > 1 ? "mixed" : sourceSet.has("rnt") ? "rnt" : "profile";
  return {
    ...observation.fields, ranked_profile_version: 1, rank_available: complete,
    ...(complete ? { ranked_checked_at: checkedAt, ranked_source: source } : {}),
    ranked_provenance: Object.fromEntries(Object.entries(observation.sources).map(([field, value]) => [field, { source: value, checked_at: checkedAt }])),
  };
}
