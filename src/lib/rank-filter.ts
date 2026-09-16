export type RankFilter = "all" | "pro" | "masters" | "legendary" | "mythic" | "diamond" | "gold" | "lower" | "unranked" | "unknown";

export function rankMatches(rank: string | null | undefined, filter: RankFilter) {
  if (filter === "all") return true;
  const value = rank?.trim().toLowerCase() || "";
  if (filter === "unknown") return value === "";
  if (filter === "unranked") return value === "unranked";
  if (filter === "lower") return value.includes("silver") || value.includes("bronze");
  if (filter === "pro") return value === "pro";
  return value.includes(filter);
}
