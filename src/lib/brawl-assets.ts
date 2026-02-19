export const BRAWLIFY_CDN = "https://cdn.brawlify.com";

const RANK_NAME_TO_ID: Record<string, number> = {
  "bronze i": 58000000,
  "bronze ii": 58000001,
  "bronze iii": 58000002,
  "silver i": 58000003,
  "silver ii": 58000004,
  "silver iii": 58000005,
  "gold i": 58000006,
  "gold ii": 58000007,
  "gold iii": 58000008,
  "diamond i": 58000009,
  "diamond ii": 58000010,
  "diamond iii": 58000011,
  "mythic i": 58000012,
  "mythic ii": 58000013,
  "mythic iii": 58000014,
  "legendary i": 58000015,
  "legendary ii": 58000016,
  "legendary iii": 58000017,
  "masters i": 58000018,
  "masters ii": 58000019,
  "masters iii": 58000020,
  pro: 58000021,
};

export function getProfileIconUrl(iconId: number | null | undefined) {
  if (!iconId) return null;
  return `${BRAWLIFY_CDN}/profile-icons/regular/${iconId}.png`;
}

export function getFallbackInitial(name: string | null | undefined) {
  return name?.trim()?.slice(0, 1)?.toUpperCase() || "?";
}

export function normalizeBrawlerName(name: string | null | undefined) {
  if (!name) return "";
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function getBrawlerIconFromMap(
  brawlerName: string | null | undefined,
  iconMap: Record<string, string>
) {
  if (!brawlerName) return null;

  const exact = iconMap[brawlerName.toUpperCase()];
  if (exact) return exact;

  const normalized = iconMap[normalizeBrawlerName(brawlerName)];
  return normalized || null;
}

export function getRankIconUrl(rank: string | null | undefined) {
  if (!rank) return null;
  const rankId = RANK_NAME_TO_ID[rank.trim().toLowerCase()];
  if (!rankId) return null;
  return `${BRAWLIFY_CDN}/ranked/tiered/${rankId}.png`;
}