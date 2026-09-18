import { normalizeBattleMode } from "@/lib/battle-catalog";
import type { GameEvent } from "@/lib/game-data";
import type { MapBrawlerStat, MapEnrichment } from "@/lib/map-data";

export type MapPickOrder = "winRate" | "pickRate";
export const MIN_MAP_PICK_SAMPLE = 100;
export const MIN_MAP_WIN_SAMPLE = 500;

// A shared map name can occur in several formats. Never attach a different
// format's art or statistics to the official rotation by name alone.
export function matchEventMap(event: GameEvent, maps: MapEnrichment[]) {
  return maps.find(map => map.mapId === event.id && normalizeBattleMode(map.mode) === normalizeBattleMode(event.mode)) ?? null;
}

export function rankMapPicks(rows: MapBrawlerStat[], order: MapPickOrder): MapBrawlerStat[] {
  const minimum = order === "winRate" ? MIN_MAP_WIN_SAMPLE : MIN_MAP_PICK_SAMPLE;
  return rows.filter(row => row.sampleSize !== null && row.sampleSize >= minimum
    && row[order] !== null && Number.isFinite(row[order]))
    .slice().sort((left, right) => (right[order]! - left[order]!)
      || (right.sampleSize! - left.sampleSize!) || left.name.localeCompare(right.name));
}
