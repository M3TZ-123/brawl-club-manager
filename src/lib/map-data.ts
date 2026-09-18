import modes from "./battle-modes.json";

export type MapSource = { name: string; url: string; official: false };
export const MAP_STATS_BANDS = ["high", "low"] as const;
export type MapStatsBand = typeof MAP_STATS_BANDS[number];
export function parseMapStatsBand(value: unknown): MapStatsBand | null {
  if (value === null || value === undefined) return "high";
  return typeof value === "string" && MAP_STATS_BANDS.includes(value as MapStatsBand) ? value as MapStatsBand : null;
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
  statsBand: MapStatsBand;
  imageUrl: string | null;
  sourceUrl: string | null;
  statsSource: MapSource | null;
  statsStatus: "available" | "unavailable" | "stale";
  winRateKind: "provider" | null;
  /** Provider response snapshot time; not a last-battle observation time. */
  statsUpdatedAt: string | null;
  statsFetchedAt: string | null;
  statsPeriod: { start: string; end: string } | null;
  /** Provider map-level total; never a per-brawler or per-band sample. */
  mapTotalMatches: number | null;
  sampleSize: number | null;
  sampleUnit: "player_results" | "battles" | null;
  brawlers: MapBrawlerStat[];
};
export type MapSnapshot = {
  data: MapEnrichment[] | null;
  statsBand: MapStatsBand;
  fetchedAt: string | null;
  stale: boolean;
  refreshing: boolean;
  source: MapSource;
};
export type MapArtwork = Pick<MapEnrichment, "mapId" | "mode" | "name" | "imageUrl" | "sourceUrl">;

export const MAP_CATALOG_SOURCE: MapSource = { name: "Brawlify", url: "https://brawlify.com", official: false };
const modeKeys = new Map(modes.map(mode => [mode.id, mode.key]));
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
export const validMapId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 15_000_000 && Number(value) < 16_000_000;

function exactUrl(value: unknown, expected: string): string | null {
  return value === expected ? expected : null;
}

/** The static catalog contains artwork/identity only; it is not an event rotation. */
export function normalizeMapCatalog(value: unknown): MapArtwork[] {
  const rows = object(value)?.list;
  if (!Array.isArray(rows) || rows.length > 3000) throw new Error("Invalid map catalog");
  const seen = new Set<number>();
  const maps: MapArtwork[] = [];
  for (const value of rows) {
    const row = object(value), gameMode = object(row?.gameMode);
    if (!row || !validMapId(row.id) || seen.has(row.id) || typeof row.name !== "string" || !row.name.trim() || row.name.length > 160
      || !Number.isSafeInteger(gameMode?.id)) throw new Error("Invalid map catalog");
    seen.add(row.id);
    const mode = modeKeys.get(Number(gameMode!.id));
    // Unknown future IDs cannot safely be joined to a different official mode.
    if (!mode) continue;
    maps.push({ mapId: row.id, mode, name: row.name.trim(),
      imageUrl: exactUrl(row.imageUrl, `https://cdn.brawlify.com/maps/regular/${row.id}.png`),
      sourceUrl: exactUrl(row.link, `https://brawlify.com/maps/${row.id}`) });
  }
  return maps;
}
