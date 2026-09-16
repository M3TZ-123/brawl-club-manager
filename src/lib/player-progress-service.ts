import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getReportingPeriod, reportingPeriodMetadata } from "@/lib/reporting-period";
import { parseTimeRange } from "@/lib/time-range";
import { normalizeReportedEquipment, optionalProgressInteger, type PlayerProgressResponse } from "@/lib/player-progress";
import { publicRankedProvenance } from "@/lib/sync-public-snapshots";

type Row = Record<string, unknown>;
export class ProgressQueryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const PROFILE_COLUMNS = "exp_points,total_prestige_level,fame,fame_tier_name,observed_at,field_checked_at";
const COLLECTION_COLUMNS = "brawler_id,brawler_name,power_level,trophies,rank,highest_trophies,prestige_level,current_win_streak,max_win_streak,skin,gadgets,star_powers,gears,hyper_charges,buffies,observed_at,field_checked_at";
const RANK_COLUMNS = "id,observed_at,kind,season_id,current_rank,points,season_best,season_best_points,all_time_best,all_time_best_points,source,provenance";
const BRAWLER_HISTORY_COLUMNS = "recorded_at,power_level,trophies,rank,gadgets_count,star_powers_count,gears_count";
const FIELD_NAMES: Record<string, string> = {
  highest_trophies: "highestTrophies", exp_points: "expPoints", total_prestige_level: "totalPrestigeLevel", fame: "fame", fame_tier_name: "fameTierName",
  prestige_level: "prestigeLevel", current_win_streak: "currentWinStreak", max_win_streak: "maxWinStreak", skin: "skin", gadgets: "gadgets",
  star_powers: "starPowers", gears: "gears", hyper_charges: "hyperCharges", buffies: "buffies",
};
function record(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function integer(value: unknown): number | null { return optionalProgressInteger(value) ?? null; }
function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function checkedFields(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([key, value]) => {
    const at = timestamp(value); return FIELD_NAMES[key] && at ? [[FIELD_NAMES[key], at]] : [];
  }));
}
function numericParam(params: URLSearchParams, key: string, fallback: number, maximum: number) {
  const raw = params.get(key); if (raw === null) return fallback;
  if (!/^\d{1,10}$/.test(raw) || Number(raw) > maximum || Number(raw) < 1) throw new ProgressQueryError(`Invalid ${key}`);
  return Number(raw);
}
function rankCursor(params: URLSearchParams): string | null {
  const raw = params.get("rankCursor"); if (!raw) return null;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(raw)) throw new ProgressQueryError("Invalid rankCursor");
  const id = Buffer.from(raw, "base64url").toString("utf8");
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > BigInt("9223372036854775807") || Buffer.from(id).toString("base64url") !== raw) throw new ProgressQueryError("Invalid rankCursor");
  return id;
}

export async function getPlayerProgress(playerTag: string, params: URLSearchParams, now = new Date()): Promise<PlayerProgressResponse> {
  if (!/^#[A-Z0-9]{2,20}$/.test(playerTag)) throw new ProgressQueryError("Invalid player tag");
  const period = getReportingPeriod(parseTimeRange(params.get("range")), now);
  const collectionLimit = numericParam(params, "collectionLimit", 50, 100);
  const collectionCursor = params.has("collectionCursor") ? numericParam(params, "collectionCursor", 0, 2147483647) : null;
  const rankLimit = numericParam(params, "rankLimit", 100, 200); const cursor = rankCursor(params);
  const brawlerId = params.has("brawlerId") ? numericParam(params, "brawlerId", 0, 2147483647) : null;
  const search = (params.get("collectionSearch") || "").trim();
  if (search.length > 80) throw new ProgressQueryError("Collection search is too long");
  const memberResult = await supabaseAdmin.from("members").select("player_tag,highest_trophies").eq("player_tag", playerTag).maybeSingle();
  if (memberResult.error) throw new Error("Failed to read player progress");
  if (!memberResult.data) throw new ProgressQueryError("Member not found", 404);
  const collectionQuery = (head = false) => {
    let query = supabaseAdmin.from("player_brawler_details").select(COLLECTION_COLUMNS, { count: "exact", head }).eq("player_tag", playerTag);
    if (search) query = /^\d+$/.test(search) ? query.eq("brawler_id", Number(search) <= 2147483647 ? Number(search) : -1)
      : query.ilike("brawler_name", `%${search.replace(/[\\%_]/g, "\\$&")}%`);
    return query;
  };
  let collection = collectionQuery().order("brawler_id", { ascending: true }).limit(collectionLimit + 1);
  if (collectionCursor !== null) collection = collection.gt("brawler_id", collectionCursor);
  let ranked = supabaseAdmin.from("player_ranked_history").select(RANK_COLUMNS).eq("player_tag", playerTag)
    .gte("observed_at", period.start.toISOString()).lte("observed_at", now.toISOString()).order("id", { ascending: false }).limit(rankLimit + 1);
  if (cursor) ranked = ranked.lt("id", cursor);
  const rankBoundary = (ascending: boolean) => supabaseAdmin.from("player_ranked_history").select("observed_at").eq("player_tag", playerTag)
    .gte("observed_at", new Date(now.getTime() - 90 * 86400000).toISOString()).lte("observed_at", now.toISOString()).order("observed_at", { ascending }).limit(1);
  const brawlerBoundary = (ascending: boolean) => brawlerId === null ? Promise.resolve({ data: [], error: null })
    : supabaseAdmin.from("brawler_snapshots").select("recorded_at").eq("player_tag", playerTag).eq("brawler_id", brawlerId)
      .gte("recorded_at", new Date(now.getTime() - 90 * 86400000).toISOString()).lte("recorded_at", now.toISOString()).order("recorded_at", { ascending }).limit(1);
  const results = await Promise.all([
    supabaseAdmin.from("player_profile_details").select(PROFILE_COLUMNS).eq("player_tag", playerTag).maybeSingle(),
    collection, collectionQuery(true), ranked, rankBoundary(true), rankBoundary(false),
    brawlerId === null ? Promise.resolve({ data: [], error: null }) : supabaseAdmin.from("brawler_snapshots").select(BRAWLER_HISTORY_COLUMNS)
      .eq("player_tag", playerTag).eq("brawler_id", brawlerId).gte("recorded_at", period.start.toISOString()).lte("recorded_at", now.toISOString())
      .order("recorded_at", { ascending: true }).limit(91), brawlerBoundary(true), brawlerBoundary(false),
  ]);
  if (results.some(result => result.error)) throw new Error("Failed to read player progress");
  const profile = record(results[0].data);
  const rows = (index: number) => (results[index].data || []) as unknown as Row[];
  const allCollection = rows(1); const allRanks = rows(3);
  const collectionItems: PlayerProgressResponse["collection"]["items"] = allCollection.slice(0, collectionLimit).map(row => {
    const buffies = record(row.buffies);
    return {
      id: Number(row.brawler_id), name: String(row.brawler_name), power: Number(row.power_level), trophies: Number(row.trophies), rank: integer(row.rank),
      highestTrophies: integer(row.highest_trophies), prestigeLevel: integer(row.prestige_level), currentWinStreak: integer(row.current_win_streak), maxWinStreak: integer(row.max_win_streak),
      skin: normalizeReportedEquipment([row.skin])?.[0] ?? null, gadgets: normalizeReportedEquipment(row.gadgets) ?? null,
      starPowers: normalizeReportedEquipment(row.star_powers) ?? null, gears: normalizeReportedEquipment(row.gears) ?? null,
      hyperCharges: normalizeReportedEquipment(row.hyper_charges) ?? null,
      buffies: row.buffies === null || row.buffies === undefined ? null : {
        gadget: typeof buffies.gadget === "boolean" ? buffies.gadget : null,
        starPower: typeof buffies.starPower === "boolean" ? buffies.starPower : null,
        hyperCharge: typeof buffies.hyperCharge === "boolean" ? buffies.hyperCharge : null,
      },
      lastCheckedAt: timestamp(row.observed_at)!, fieldCheckedAt: checkedFields(row.field_checked_at),
    };
  });
  const rankedItems: PlayerProgressResponse["rankedHistory"]["items"] = allRanks.slice(0, rankLimit).map(row => ({
    id: String(row.id), observedAt: timestamp(row.observed_at)!, kind: row.kind as "initial" | "change" | "season_reset",
    seasonId: integer(row.season_id), currentRank: typeof row.current_rank === "string" ? row.current_rank : null, points: integer(row.points),
    seasonBest: typeof row.season_best === "string" ? row.season_best : null, seasonBestPoints: integer(row.season_best_points),
    allTimeBest: typeof row.all_time_best === "string" ? row.all_time_best : null, allTimeBestPoints: integer(row.all_time_best_points),
    source: ["profile", "rnt", "mixed"].includes(String(row.source)) ? String(row.source) : null, provenance: publicRankedProvenance(row.provenance),
  }));
  return {
    playerTag, period: reportingPeriodMetadata(period),
    profile: { highestTrophies: integer(memberResult.data.highest_trophies), expPoints: integer(profile.exp_points), totalPrestigeLevel: integer(profile.total_prestige_level),
      fame: integer(profile.fame), fameTierName: typeof profile.fame_tier_name === "string" ? profile.fame_tier_name : null,
      lastCheckedAt: timestamp(profile.observed_at), fieldCheckedAt: checkedFields(profile.field_checked_at) },
    collection: { items: collectionItems, total: Number("count" in results[2] ? results[2].count : 0),
      nextCursor: allCollection.length > collectionLimit ? collectionItems.at(-1)!.id : null, lastCheckedAt: timestamp(profile.observed_at) },
    rankedHistory: { items: rankedItems, nextCursor: allRanks.length > rankLimit ? Buffer.from(rankedItems.at(-1)!.id).toString("base64url") : null,
      coverageStart: timestamp(rows(4)[0]?.observed_at), coverageEnd: timestamp(rows(5)[0]?.observed_at),
      retention: { detailedDays: 7, dailyDays: 90, olderAggregation: "latest_per_utc_day_and_season" } },
    brawlerHistory: { brawlerId, items: rows(6).map(row => ({ recordedAt: timestamp(row.recorded_at)!, power: Number(row.power_level),
      trophies: Number(row.trophies), rank: integer(row.rank), gadgetsCount: integer(row.gadgets_count), starPowersCount: integer(row.star_powers_count), gearsCount: integer(row.gears_count) })),
      coverageStart: timestamp(rows(7)[0]?.recorded_at), coverageEnd: timestamp(rows(8)[0]?.recorded_at) },
  };
}
