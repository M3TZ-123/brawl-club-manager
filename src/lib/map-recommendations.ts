import { normalizeBattleMode } from "@/lib/battle-catalog";
import type { GameEvent } from "@/lib/game-data";
import type { MapBrawlerStat, MapEnrichment } from "@/lib/map-data";

// A shared map name can occur in several formats. Never attach a different
// format's art or statistics to the official rotation by name alone.
export function matchEventMap(event: GameEvent, maps: MapEnrichment[]) {
  return maps.find(map => map.mapId === event.id && normalizeBattleMode(map.mode) === normalizeBattleMode(event.mode)) ?? null;
}

export function rankMapPicks(rows: MapBrawlerStat[]): MapBrawlerStat[] {
  // BrawlTools supplies a ranked shortlist, without per-brawler denominators.
  // Preserve tied source positions; do not invent a sample-size qualification.
  return rows.filter(row => typeof row.winRate === "number" && Number.isFinite(row.winRate)
    && row.winRate >= 0 && row.winRate <= 100)
    .sort((left, right) => right.winRate! - left.winRate!);
}
