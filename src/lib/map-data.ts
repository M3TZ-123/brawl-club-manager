import modes from "./battle-modes.json";

export type MapSource = { name: string; url: string; official: false };
export const MAP_TROPHY_RANGES = ["all", "600", "1000"] as const;
export type MapTrophyRange = typeof MAP_TROPHY_RANGES[number];
export function parseMapTrophyRange(value: unknown): MapTrophyRange | null {
  if (value === null || value === undefined) return "1000";
  return typeof value === "string" && MAP_TROPHY_RANGES.includes(value as MapTrophyRange) ? value as MapTrophyRange : null;
}
export function mapMinTrophies(range: MapTrophyRange): number | null {
  if (!MAP_TROPHY_RANGES.includes(range)) throw new Error("Invalid trophy range");
  return range === "all" ? null : Number(range);
}
export type MapBrawlerStat = {
  id: number | null;
  name: string;
  imageUrl: string | null;
  /** Percent values, never fractions. Raw and adjusted rates stay distinct. */
  winRate: number | null;
  pickRate: number | null;
  adjustedWinRate: number | null;
  sampleSize: number | null;
};
export type MapEnrichment = {
  mapId: number;
  mode: string;
  name: string;
  minTrophies: number | null;
  imageUrl: string | null;
  sourceUrl: string | null;
  statsSource: MapSource | null;
  statsStatus: "available" | "unavailable" | "stale";
  winRateKind: "victory" | "first_place" | null;
  /** Provider observation time, not our retrieval time. */
  statsUpdatedAt: string | null;
  statsFetchedAt: string | null;
  statsPeriod: { start: string; end: string } | null;
  sampleSize: number | null;
  sampleUnit: "player_results" | "battles" | null;
  brawlers: MapBrawlerStat[];
};
export type MapSnapshot = {
  data: MapEnrichment[] | null;
  trophyRange: MapTrophyRange;
  minTrophies: number | null;
  fetchedAt: string | null;
  stale: boolean;
  refreshing: boolean;
  source: MapSource;
};

export const MAP_CATALOG_SOURCE: MapSource = { name: "Brawlify", url: "https://brawlify.com", official: false };
const modeKeys = new Map(modes.map(mode => [mode.id, mode.key]));
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
export const validMapId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 15_000_000 && Number(value) < 16_000_000;

function exactUrl(value: unknown, expected: string): string | null {
  return value === expected ? expected : null;
}

/** The static catalog contains artwork/identity only; it is not an event rotation. */
export function normalizeMapCatalog(value: unknown): MapEnrichment[] {
  const rows = object(value)?.list;
  if (!Array.isArray(rows) || rows.length > 3000) throw new Error("Invalid map catalog");
  const seen = new Set<number>();
  const maps: MapEnrichment[] = [];
  for (const value of rows) {
    const row = object(value), gameMode = object(row?.gameMode);
    if (!row || !validMapId(row.id) || seen.has(row.id) || typeof row.name !== "string" || !row.name.trim() || row.name.length > 160
      || !Number.isSafeInteger(gameMode?.id)) throw new Error("Invalid map catalog");
    seen.add(row.id);
    const mode = modeKeys.get(Number(gameMode!.id));
    // Unknown future IDs cannot safely be joined to a different official mode.
    if (!mode) continue;
    maps.push({ mapId: row.id, mode, name: row.name.trim(), minTrophies: null,
      imageUrl: exactUrl(row.imageUrl, `https://cdn.brawlify.com/maps/regular/${row.id}.png`),
      sourceUrl: exactUrl(row.link, `https://brawlify.com/maps/${row.id}`),
      statsSource: null, statsStatus: "unavailable", winRateKind: null, statsUpdatedAt: null, statsFetchedAt: null, statsPeriod: null,
      sampleSize: null, sampleUnit: null, brawlers: [] });
  }
  return maps;
}
