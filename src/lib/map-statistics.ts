import brawlerIds from "./brawler-ids.json";
import { battleModeAliases, normalizeBattleMode } from "./battle-catalog";
import { getBrawlerPortraitUrl } from "./brawl-assets";
import { mapMinTrophies, validMapId, type MapBrawlerStat, type MapEnrichment, type MapSource, type MapTrophyRange } from "./map-data";

export type MapTarget = { mapId: number; mode: string; name: string };
export type MapStatistics = Pick<MapEnrichment, "mapId" | "mode" | "minTrophies" | "statsUpdatedAt" | "statsPeriod" | "sampleSize" | "sampleUnit" | "brawlers" | "winRateKind">;
export const MAP_STATS_SOURCE: MapSource = { name: "Brawl Time Ninja", url: "https://brawltime.ninja", official: false };
export const MAP_STATS_LIMIT = 20_000;
const ids = new Map(Object.entries(brawlerIds).map(([name, id]) => [name.toUpperCase(), { name, id }]));
const resultModes = new Set(["gemGrab", "heist", "bounty", "brawlBall", "hotZone", "knockout", "wipeout", "duels", "basketBrawl", "volleyBrawl", "brawlHockey", "paintBrawl", "payload", "brawlArena",
  "gemGrab5v5", "brawlBall5v5", "wipeout5v5", "knockout5v5", "brawlHockey5v5", "gemGrab2v2", "brawlBall2v2", "hotZone2v2", "knockout2v2", "basketBrawl2v2", "brawlHockey2v2"]);

/** Ninja groups by its own 14-day trophy period, not a game Ranked season. */
export function mapStatisticsPeriod(now: number) {
  const origin = Date.parse("2020-07-13T08:00:00Z"), duration = 14 * 86_400_000;
  const end = origin + Math.ceil((now - origin) / duration) * duration;
  return { start: new Date(end - duration).toISOString(), end: new Date(end).toISOString() };
}
export function mapStatisticsQuery(targets: MapTarget[], period: { start: string; end: string }, trophyRange: MapTrophyRange = "1000") {
  const minTrophies = mapMinTrophies(trophyRange);
  if (!targets.length || targets.length > 100 || targets.some(row => !validMapId(row.mapId) || typeof row.mode !== "string" || row.mode.length > 80
    || typeof row.name !== "string" || !row.name || row.name.length > 160)) throw new Error("Invalid map targets");
  return { measures: ["map.picks_measure", "map.winRate_measure", "map.winRateAdj_measure", "map.rank1Rate_measure", "map.timestamp_measure", "map.eventId_measure"],
    dimensions: ["map.brawler_dimension", "map.mode_dimension", "map.map_dimension"],
    filters: [{ or: targets.map(row => ({ and: [
      { member: "map.map_dimension", operator: "equals", values: [row.name] },
      { member: "map.mode_dimension", operator: "equals", values: [...new Set([row.mode, ...Object.keys(battleModeAliases).filter(alias => battleModeAliases[alias] === row.mode)]
        .flatMap(mode => [mode, mode.replace(/(\d)v(\d)/g, "$1V$2")]))] },
    ] })) }, { member: "map.season_dimension", operator: "equals", values: [period.end.slice(0, 10)] },
    { member: "map.powerplay_dimension", operator: "equals", values: ["0"] },
    // Verified Ninja buckets are individual-brawler trophies / 100, not account trophies.
    ...(minTrophies === null ? [] : [{ member: "map.trophyRange_dimension", operator: "gte", values: [String(minTrophies / 100)] }])],
    order: { "map.picks_measure": "desc" }, limit: MAP_STATS_LIMIT };
}
const count = (value: unknown): number | null => (typeof value === "number" || typeof value === "string" && /^\d+$/.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const percent = (value: unknown): number | null => (typeof value === "number" || typeof value === "string" && /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
  && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1 ? Number(value) * 100 : null;

export function normalizeMapStatistics(value: unknown, targets: MapTarget[], period: { start: string; end: string }, now: number, trophyRange: MapTrophyRange = "1000"): MapStatistics[] {
  const minTrophies = mapMinTrophies(trophyRange);
  const rows = value && typeof value === "object" ? (value as { data?: unknown }).data : null;
  if (!Array.isArray(rows) || rows.length >= MAP_STATS_LIMIT) throw new Error("Incomplete map statistics");
  const groups = new Map(targets.map(target => [`${target.mapId}:${target.mode}`, { target, identityConflict: false, seen: new Set<string>(), latest: null as string | null, total: 0, brawlers: [] as MapBrawlerStat[] }]));
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("Invalid map statistics");
    const mapId = count(row["map.eventId_measure"]), rawMode = row["map.mode_dimension"], name = row["map.brawler_dimension"], picks = count(row["map.picks_measure"]);
    if (!validMapId(mapId) || typeof rawMode !== "string" || typeof name !== "string" || !name.trim() || name.length > 100 || picks === null) throw new Error("Invalid map statistics");
    const mode = normalizeBattleMode(rawMode), group = groups.get(`${mapId}:${mode}`);
    // Ninja aggregates by name/mode and exposes any(event ID), not an ID
    // dimension. A conflicting ID invalidates this target's whole denominator;
    // dropping only those brawlers would inflate every remaining pick share.
    for (const candidate of groups.values()) {
      if (candidate.target.mode === mode && candidate.target.name === row["map.map_dimension"] && candidate.target.mapId !== mapId) candidate.identityConflict = true;
    }
    if (!group || row["map.map_dimension"] !== group.target.name) continue;
    const normalized = name.trim().toUpperCase();
    if (group.seen.has(normalized)) throw new Error("Duplicate map statistics");
    group.seen.add(normalized);
    const known = ids.get(normalized), showdown = mode.toLowerCase().includes("showdown");
    const winRate = showdown ? percent(row["map.rank1Rate_measure"]) : resultModes.has(mode) ? percent(row["map.winRate_measure"]) : null;
    const observed = typeof row["map.timestamp_measure"] === "string" ? Date.parse(row["map.timestamp_measure"]) : NaN;
    if (Number.isFinite(observed) && observed >= Date.parse(period.start) && observed <= Math.min(now, Date.parse(period.end))) {
      const at = new Date(observed).toISOString();
      if (group.latest === null || at > group.latest) group.latest = at;
    }
    group.total += picks;
    if (!Number.isSafeInteger(group.total)) throw new Error("Invalid map sample count");
    group.brawlers.push({ id: known?.id ?? null, name: known?.name ?? name.trim(), imageUrl: getBrawlerPortraitUrl(known?.id, "borders"),
      winRate, adjustedWinRate: !showdown && resultModes.has(mode) ? percent(row["map.winRateAdj_measure"]) : null, pickRate: null, sampleSize: picks });
  }
  return [...groups.values()].filter(group => !group.identityConflict).map(group => ({ mapId: group.target.mapId, mode: group.target.mode, minTrophies, statsUpdatedAt: group.latest, statsPeriod: period,
    sampleSize: group.brawlers.length ? group.total : null, sampleUnit: "player_results", winRateKind: group.target.mode.toLowerCase().includes("showdown") ? "first_place" : resultModes.has(group.target.mode) ? "victory" : null,
    brawlers: group.brawlers.map(row => ({ ...row, pickRate: group.total > 0 ? row.sampleSize! / group.total * 100 : null })) }));
}
