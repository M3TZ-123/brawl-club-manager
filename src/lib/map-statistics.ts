import modes from "./battle-modes.json";
import { normalizeBattleMode } from "./battle-catalog";
import { getBrawlerPortraitUrl } from "./brawl-assets";
import { validMapId, type MapBrawlerStat, type MapSource, type MapStatsBand } from "./map-data";

export const MAP_STATS_SOURCE: MapSource = { name: "BrawlTools", url: "https://api.brawltools.net/docs", official: false };
type SourceBrawler = { id: number; name: string; winRate: number | null };
export type SourceMap = { mapId: number; name: string; mode: string | null; mapTotalMatches: number | null; high: SourceBrawler[] | null; low: SourceBrawler[] | null };
export type MapStatistics = { maps: SourceMap[]; sourceTimestamp: string | null };
const modeKeys = new Map(modes.map(mode => [mode.id, mode.key]));
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const percent = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;

function brawlers(value: unknown): SourceBrawler[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 10) return null;
  const seen = new Set<number>(), duplicates = new Set<number>();
  const rows = value.flatMap(value => {
    const row = object(value), id = count(row?.brawlerId);
    if (!row || id === null || id < 16_000_000 || id >= 17_000_000 || typeof row.brawlerName !== "string" || !row.brawlerName.trim() || row.brawlerName.length > 100) return [];
    if (seen.has(id)) { duplicates.add(id); return []; }
    seen.add(id);
    return [{ id, name: row.brawlerName.trim(), winRate: percent(row.winRate) }];
  });
  return rows.filter(row => !duplicates.has(row.id));
}

/** A compact projection keeps the single shared all-map cache below its size limit. */
export function normalizeMapStatistics(value: unknown, now: number): MapStatistics {
  const payload = object(value), rows = payload?.data;
  if (!Array.isArray(rows) || rows.length > 3000) throw new Error("Invalid map statistics");
  const timestamp = count(payload?.timestamp);
  const sourceTimestamp = timestamp !== null && timestamp > 0 && timestamp * 1000 <= now ? new Date(timestamp * 1000).toISOString() : null;
  const seen = new Set<number>(), duplicates = new Set<number>();
  const maps = rows.flatMap(value => {
    const row = object(value), metadata = object(row?.gameMode);
    if (!row || !validMapId(row.id)) return [];
    if (seen.has(row.id)) { duplicates.add(row.id); return []; }
    seen.add(row.id);
    if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 160) return [];
    const hasId = metadata !== null && Object.hasOwn(metadata, "scId"), hasHash = metadata !== null && Object.hasOwn(metadata, "scHash");
    const byId = typeof metadata?.scId === "number" ? modeKeys.get(metadata.scId) : undefined;
    const byHash = typeof metadata?.scHash === "string" && metadata.scHash.trim() && metadata.scHash.length <= 80 ? normalizeBattleMode(metadata.scHash) : null;
    // A contradictory explicit mode must never be repaired by an artwork match.
    const mode = hasId && !byId || hasHash && !byHash || byId && byHash && byId !== byHash ? "!conflicting-mode" : byId ?? byHash;
    return [{ mapId: row.id, name: row.name.trim(), mode, mapTotalMatches: count(row.totalMatches), high: brawlers(row.winRateHigh), low: brawlers(row.winRateLow) }];
  });
  // Legacy malformed rows are isolated. Rates are source-provided, so removing
  // an invalid identity never changes any other brawler's rate/denominator.
  const result = { maps: maps.filter(row => !duplicates.has(row.mapId)), sourceTimestamp };
  if (!result.maps.length) throw new Error("Map statistics temporarily empty");
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 1_500_000) throw new Error("Map statistics cache too large");
  return result;
}

export function mapBandBrawlers(row: SourceMap, band: MapStatsBand): MapBrawlerStat[] | null {
  if (band !== "high" && band !== "low") throw new Error("Invalid statistics band");
  const values = row[band];
  if (values === null) return null;
  return values.map(value => ({ ...value, imageUrl: getBrawlerPortraitUrl(value.id, "borders"), pickRate: null, adjustedWinRate: null, sampleSize: null }));
}
