import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { battleContextOptions, getBattleModeInfo, normalizeBattleMode } from "@/lib/battle-catalog";
import { parseTimeRange, TIME_RANGES } from "@/lib/time-range";
import type { AnalysisContext, AnalysisResponse, AnalysisStats, ReadinessResponse, ReadinessRow, ReportedEquipment } from "@/lib/club-analysis-types";

type Row = Record<string, unknown>;
export class AnalysisInputError extends Error {}
const object = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid analysis response");
  return value as Row;
};
const array = (value: unknown, max = 2000): Row[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid analysis response");
  return value.map(object);
};
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid analysis count");
  return value;
};
const text = (value: unknown, max = 200): string => {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid analysis text");
  return value;
};
const nonnegative = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = (value: unknown, now: Date): string | null => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= now.getTime() ? new Date(at).toISOString() : null;
};
const context = (value: unknown): AnalysisContext => {
  const found = battleContextOptions.find(item => item.key === value);
  return found ? { key: found.key, label: found.label } : { key: "unknown", label: "Unclassified" };
};
const mode = (value: unknown) => {
  const found = getBattleModeInfo(text(value, 100));
  return { key: found.key, label: found.label };
};
const stats = (row: Row): AnalysisStats => ({
  observations: count(row.observations), wins: count(row.wins), losses: count(row.losses), draws: count(row.draws),
  unknownResults: count(row.unknownResults), winRate: nonnegative(row.winRate), durationObservations: count(row.durationObservations),
  recordedDurationSeconds: count(row.recordedDurationSeconds), averageDurationSeconds: nonnegative(row.averageDurationSeconds),
});
const optionalFilter = (params: URLSearchParams, key: string, max: number): string | null => {
  const value = params.get(key)?.trim() || null;
  if (value && (value.length > max || /[\u0000-\u001f]/.test(value))) throw new AnalysisInputError("Invalid analysis filter");
  return value;
};
const integerFilter = (params: URLSearchParams, key: string, fallback: number | null, min: number, max: number): number | null => {
  const value = params.get(key);
  if (value == null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new AnalysisInputError("Invalid numeric filter");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new AnalysisInputError("Invalid numeric filter");
  return parsed;
};

export async function readClubAnalysis(params: URLSearchParams, now = new Date()): Promise<AnalysisResponse> {
  const range = params.get("range");
  if (range && !Object.hasOwn(TIME_RANGES, range)) throw new AnalysisInputError("Invalid analysis range");
  const key = parseTimeRange(range), days = TIME_RANGES[key].days;
  const filters = {
    context: optionalFilter(params, "context", 30), mode: optionalFilter(params, "mode", 100),
    map: optionalFilter(params, "map", 100), brawler: optionalFilter(params, "brawler", 50),
  };
  if (filters.context && !battleContextOptions.some(item => item.key === filters.context)) throw new AnalysisInputError("Invalid battle context");
  if (filters.mode) filters.mode = normalizeBattleMode(filters.mode);
  const { data, error } = await supabaseAdmin.rpc("club_analysis_read", {
    p_days: days, p_now: now.toISOString(), p_context: filters.context, p_mode: filters.mode, p_map: filters.map, p_brawler: filters.brawler,
  });
  if (error) throw new Error("Analysis database read failed");
  const body = object(data), facets = object(body.facets), coverage = object(body.coverage), limits = object(body.limits);
  const groupCounts = object(limits.groupCounts), facetCounts = object(limits.facetCounts);
  const plainFacet = (rows: unknown) => array(rows).map(row => ({ key: text(row.key), count: count(row.count) }));
  return {
    period: { key, days, start: new Date(now.getTime() - days * 86_400_000).toISOString(), end: now.toISOString(), aggregation: "rolling" },
    filters, summary: stats(object(body.summary)),
    modes: array(body.modes, 200).map(row => ({ ...stats(row), context: context(row.context), mode: mode(row.mode) })),
    maps: array(body.maps, 200).map(row => ({ ...stats(row), context: context(row.context), mode: mode(row.mode), map: text(row.map) })),
    brawlers: array(body.brawlers, 200).map(row => ({ ...stats(row), context: context(row.context), brawler: text(row.brawler) })),
    pairs: array(body.pairs, 200).map(row => {
      const first = object(row.player1), second = object(row.player2);
      return { player1: { tag: text(first.tag, 30), name: text(first.name) }, player2: { tag: text(second.tag, 30), name: text(second.name) },
        context: context(row.context), matches: count(row.matches), wins: count(row.wins), losses: count(row.losses), draws: count(row.draws),
        unknownResults: count(row.unknownResults), winRate: nonnegative(row.winRate) };
    }),
    hourly: array(body.hourly, 24).map(row => ({ hour: count(row.hour), ...stats(row) })),
    facets: {
      contexts: battleContextOptions.map(item => ({ ...item, count: count(array(facets.contexts, 7).find(row => row.key === item.key)?.count ?? 0) })),
      modes: array(facets.modes).map(row => ({ ...mode(row.key), count: count(row.count) })),
      maps: plainFacet(facets.maps), brawlers: plainFacet(facets.brawlers),
    },
    coverage: {
      status: coverage.status === "observed" || coverage.status === "possible_gap" ? coverage.status : "unknown",
      currentPlayers: count(coverage.currentPlayers), monitoredPlayers: count(coverage.monitoredPlayers), affectedPlayers: count(coverage.affectedPlayers),
      baselineAt: timestamp(coverage.baselineAt, now), lastCheckedAt: timestamp(coverage.lastCheckedAt, now),
      earliestBattleAt: timestamp(coverage.earliestBattleAt, now), latestBattleAt: timestamp(coverage.latestBattleAt, now),
      possibleGapCount: count(coverage.possibleGapCount), retainedGapWindowDays: count(coverage.retainedGapWindowDays), requestedDays: days,
      fullPeriodMonitoredPlayers: count(coverage.fullPeriodMonitoredPlayers), stalePlayers: count(coverage.stalePlayers),
      teamObservations: count(coverage.teamObservations), pairEligibleObservations: count(coverage.pairEligibleObservations),
      truncated: coverage.truncated === true, completeHistory: false,
    },
    limits: {
      observationLimit: count(limits.observationLimit), groupLimit: count(limits.groupLimit), facetLimit: count(limits.facetLimit), truncated: limits.truncated === true,
      groupCounts: { modes: count(groupCounts.modes), maps: count(groupCounts.maps), brawlers: count(groupCounts.brawlers), pairs: count(groupCounts.pairs) },
      facetCounts: { modes: count(facetCounts.modes), maps: count(facetCounts.maps), brawlers: count(facetCounts.brawlers) },
    }, generatedAt: now.toISOString(),
  };
}

const equipment = (value: unknown): ReportedEquipment[] | null => {
  if (!Array.isArray(value) || value.length > 200) return null;
  if (value.some(item => !item || typeof item !== "object" || !Number.isSafeInteger(item.id) || item.id < 0)) return null;
  return value.map(item => ({ id: item.id, name: typeof item.name === "string" ? item.name.slice(0, 200) : null,
    ...(Object.hasOwn(item, "level") ? { level: nonnegative(item.level) } : {}) }));
};
const checkedFields = new Set(["brawler_name", "power_level", "trophies", "rank", "highest_trophies", "prestige_level", "current_win_streak", "max_win_streak", "skin", "gadgets", "star_powers", "gears", "hyper_charges", "buffies"]);
function readinessRow(row: Row, now: Date): ReadinessRow {
  const player = object(row.player), brawler = object(row.brawler);
  const flags = row.buffies && typeof row.buffies === "object" && !Array.isArray(row.buffies) ? row.buffies as Row : null;
  const boolean = (value: unknown) => typeof value === "boolean" ? value : null;
  const checked = row.fieldCheckedAt && typeof row.fieldCheckedAt === "object" && !Array.isArray(row.fieldCheckedAt) ? row.fieldCheckedAt as Row : {};
  return {
    player: { tag: text(player.tag, 30), name: text(player.name) }, brawler: { id: count(brawler.id), name: text(brawler.name) },
    powerLevel: typeof row.powerLevel === "number" && Number.isInteger(row.powerLevel) && row.powerLevel >= 1 && row.powerLevel <= 11 ? row.powerLevel : null,
    trophies: nonnegative(row.trophies), highestTrophies: nonnegative(row.highestTrophies), rank: nonnegative(row.rank),
    prestigeLevel: nonnegative(row.prestigeLevel), currentWinStreak: nonnegative(row.currentWinStreak), maxWinStreak: nonnegative(row.maxWinStreak),
    gadgets: equipment(row.gadgets), starPowers: equipment(row.starPowers), gears: equipment(row.gears), hyperCharges: equipment(row.hyperCharges),
    buffies: flags ? { gadget: boolean(flags.gadget), starPower: boolean(flags.starPower), hyperCharge: boolean(flags.hyperCharge) } : null,
    observedAt: timestamp(row.observedAt, now), fieldCheckedAt: Object.fromEntries(Object.entries(checked)
      .filter(([key, value]) => checkedFields.has(key) && timestamp(value, now) !== null).map(([key, value]) => [key, timestamp(value, now)!])),
  };
}

export async function readClubReadiness(params: URLSearchParams, now = new Date()): Promise<ReadinessResponse> {
  const brawler = integerFilter(params, "brawler", null, 0, 2_147_483_647);
  const minPower = integerFilter(params, "minPower", 0, 0, 11), offset = integerFilter(params, "offset", 0, 0, 100000)!;
  const limit = integerFilter(params, "limit", 100, 1, 200), search = optionalFilter(params, "search", 100);
  const { data, error } = await supabaseAdmin.rpc("club_readiness_read", {
    p_now: now.toISOString(), p_brawler: brawler, p_min_power: minPower, p_search: search, p_offset: offset, p_limit: limit,
  });
  if (error) throw new Error("Readiness database read failed");
  const body = object(data), total = count(body.total), rows = array(body.rows, 200).map(row => readinessRow(row, now));
  const hasMore = offset + rows.length < total;
  if (hasMore && rows.length === 0) throw new Error("Invalid readiness page");
  return {
    members: array(body.members, 100).map(row => ({ tag: text(row.tag, 30), name: text(row.name), brawlersObserved: count(row.brawlersObserved),
      power9Plus: count(row.power9Plus), power10Plus: count(row.power10Plus), power11: count(row.power11), observedAt: timestamp(row.observedAt, now) })),
    brawlers: array(body.brawlers, 2000).map(row => ({ id: count(row.id), name: text(row.name), playersObserved: count(row.playersObserved) })),
    rows, total, hasMore, nextOffset: hasMore ? offset + rows.length : null, generatedAt: now.toISOString(),
  };
}
