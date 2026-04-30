import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { aggregateDailyBattleStats, type DailyBattleStatsRow } from "@/lib/battle-tracking-stats";
import { appendMemberActivityMetrics } from "@/lib/member-activity-metrics";

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_CONFIG = {
  "24h": { label: "last 24h", durationMs: DAY_MS, minWinRateBattles: 3, activeDayCap: 1 },
  "3d": { label: "last 3 days", durationMs: 3 * DAY_MS, minWinRateBattles: 5, activeDayCap: 3 },
  "7d": { label: "last 7 days", durationMs: 7 * DAY_MS, minWinRateBattles: 10, activeDayCap: 7 },
  "30d": { label: "last 30 days", durationMs: 30 * DAY_MS, minWinRateBattles: 20, activeDayCap: 30 },
} as const;

type RangeKey = keyof typeof RANGE_CONFIG;

type TrackingRow = {
  player_tag: string;
  total_battles: number | null;
  total_wins: number | null;
  total_losses: number | null;
  star_player_count: number | null;
  trophies_gained: number | null;
  trophies_lost: number | null;
  active_days: number | null;
  current_streak: number | null;
  best_streak: number | null;
  peak_day_battles: number | null;
};

type BattleRangeRow = {
  player_tag: string;
  battle_time: string;
  result: string | null;
  trophy_change: number | null;
  is_star_player: boolean | null;
};

type RangeStats = {
  battles: number;
  wins: number;
  losses: number;
  starPlayer: number;
  trophiesGained: number;
  trophiesLost: number;
  activeDays: number;
  winRate: number;
  netTrophies: number;
};

function parseRange(value: string | null): RangeKey {
  return value === "24h" || value === "3d" || value === "30d" ? value : "7d";
}

function normalizeTimestamp(value: string | null | undefined) {
  const timestamp = value?.trim();
  if (!timestamp) return null;

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString();
}

async function fetchDailyStatsRows(playerTags: string[]): Promise<DailyBattleStatsRow[]> {
  if (playerTags.length === 0) return [];

  const pageSize = 1000;
  const rows: DailyBattleStatsRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("daily_stats")
      .select("player_tag, date, battles, wins, losses, star_player, trophies_gained, trophies_lost")
      .in("player_tag", playerTags)
      .order("date", { ascending: true })
      .order("player_tag", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows.push(...((data || []) as DailyBattleStatsRow[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function fetchTrackingRows(playerTags: string[]): Promise<TrackingRow[]> {
  if (playerTags.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("player_tracking")
    .select("player_tag, total_battles, total_wins, total_losses, star_player_count, trophies_gained, trophies_lost, active_days, current_streak, best_streak, peak_day_battles")
    .in("player_tag", playerTags);

  if (error) throw error;
  return (data || []) as TrackingRow[];
}

async function fetchBattleRangeRows(playerTags: string[], sinceISO: string): Promise<BattleRangeRow[]> {
  if (playerTags.length === 0) return [];

  const pageSize = 1000;
  const rows: BattleRangeRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("battle_history")
      .select("player_tag, battle_time, result, trophy_change, is_star_player")
      .in("player_tag", playerTags)
      .gte("battle_time", sinceISO)
      .order("battle_time", { ascending: true })
      .order("player_tag", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows.push(...((data || []) as BattleRangeRow[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

function buildRangeStats(playerTags: string[], rows: BattleRangeRow[], activeDayCap: number) {
  const stats = new Map<string, RangeStats & { activeDateSet: Set<string> }>();

  for (const playerTag of playerTags) {
    stats.set(playerTag, {
      battles: 0,
      wins: 0,
      losses: 0,
      starPlayer: 0,
      trophiesGained: 0,
      trophiesLost: 0,
      activeDays: 0,
      winRate: 0,
      netTrophies: 0,
      activeDateSet: new Set<string>(),
    });
  }

  for (const row of rows) {
    const playerStats = stats.get(row.player_tag);
    if (!playerStats) continue;

    const trophyChange = row.trophy_change || 0;
    playerStats.battles += 1;
    if (row.result === "victory") playerStats.wins += 1;
    if (row.result === "defeat") playerStats.losses += 1;
    if (row.is_star_player) playerStats.starPlayer += 1;
    if (trophyChange > 0) playerStats.trophiesGained += trophyChange;
    if (trophyChange < 0) playerStats.trophiesLost += Math.abs(trophyChange);
    playerStats.netTrophies += trophyChange;
    playerStats.activeDateSet.add(row.battle_time.slice(0, 10));
  }

  const result = new Map<string, RangeStats>();
  for (const [playerTag, playerStats] of stats) {
    result.set(playerTag, {
      battles: playerStats.battles,
      wins: playerStats.wins,
      losses: playerStats.losses,
      starPlayer: playerStats.starPlayer,
      trophiesGained: playerStats.trophiesGained,
      trophiesLost: playerStats.trophiesLost,
      activeDays: Math.min(playerStats.activeDateSet.size, activeDayCap),
      winRate: playerStats.battles > 0 ? Math.round((playerStats.wins / playerStats.battles) * 100) : 0,
      netTrophies: playerStats.netTrophies,
    });
  }

  return result;
}

function getRangeProgress(
  rangeKey: RangeKey,
  metrics: Awaited<ReturnType<typeof appendMemberActivityMetrics>>[number] | undefined,
  rangeStats: RangeStats | undefined
) {
  if (rangeKey === "24h") return metrics?.trophies_24h ?? (rangeStats?.battles ? rangeStats.netTrophies : null);
  if (rangeKey === "3d") return metrics?.trophies_3d ?? (rangeStats?.battles ? rangeStats.netTrophies : null);
  if (rangeKey === "7d") return metrics?.trophies_7d ?? (rangeStats?.battles ? rangeStats.netTrophies : null);
  return rangeStats?.battles ? rangeStats.netTrophies : null;
}

export async function GET(request: NextRequest) {
  try {
    const now = new Date();
    const rangeKey = parseRange(request.nextUrl.searchParams.get("range"));
    const rangeConfig = RANGE_CONFIG[rangeKey];
    const rangeStart = new Date(now.getTime() - rangeConfig.durationMs);
    const [membersRes, currentMembersRes, settingsRes] = await Promise.all([
      supabaseAdmin
        .from("members")
        .select("player_tag, player_name, trophies, highest_trophies, role, win_rate, solo_victories, duo_victories, trio_victories, brawlers_count, rank_current, rank_highest, exp_level"),
      supabaseAdmin
        .from("member_history")
        .select("player_tag")
        .eq("is_current_member", true),
      supabaseAdmin
        .from("settings")
        .select("key, value")
        .in("key", ["last_sync_time"]),
    ]);

    if (membersRes.error) throw membersRes.error;
    if (currentMembersRes.error) throw currentMembersRes.error;
    if (settingsRes.error) throw settingsRes.error;

    const currentTags = new Set((currentMembersRes.data || []).map((m) => m.player_tag));
    const currentTagList = [...currentTags];
    const members = (membersRes.data || []).filter((m) => currentTags.has(m.player_tag));

    const [dailyStatsRows, trackingRows, battleRangeRows] = await Promise.all([
      fetchDailyStatsRows(currentTagList),
      fetchTrackingRows(currentTagList),
      fetchBattleRangeRows(currentTagList, rangeStart.toISOString()),
    ]);
    const membersWithMetrics = await appendMemberActivityMetrics(members, now);
    const memberMetricsByTag = new Map(
      membersWithMetrics.map((member) => [member.player_tag, member])
    );

    const trackingMap = new Map(trackingRows.map((row) => [row.player_tag, row]));
    const trackedStatsMap = aggregateDailyBattleStats(dailyStatsRows, currentTagList, now);
    const rangeStatsMap = buildRangeStats(currentTagList, battleRangeRows, rangeConfig.activeDayCap);

    const enriched = members.map((m) => {
      const tracking = trackingMap.get(m.player_tag);
      const trackedStats = trackedStatsMap.get(m.player_tag);
      const metrics = memberMetricsByTag.get(m.player_tag);
      const rangeStats = rangeStatsMap.get(m.player_tag);
      const totalVictories = (m.solo_victories || 0) + (m.duo_victories || 0) + (m.trio_victories || 0);

      return {
        tag: m.player_tag,
        name: m.player_name,
        role: m.role,
        trophies: m.trophies || 0,
        highestTrophies: m.highest_trophies || 0,
        winRate: m.win_rate ?? null,
        totalVictories,
        brawlersCount: m.brawlers_count || 0,
        expLevel: m.exp_level || 1,
        rankCurrent: m.rank_current,
        rankHighest: m.rank_highest,
        activityStatus: metrics?.activity_status || "inactive",
        lastBattleAt: metrics?.last_battle_at || null,
        allTime: {
          battles: trackedStats?.battles || tracking?.total_battles || 0,
          wins: trackedStats?.wins || tracking?.total_wins || 0,
          losses: trackedStats?.losses || tracking?.total_losses || 0,
          starPlayer: trackedStats?.starPlayer || tracking?.star_player_count || 0,
          trophiesGained: trackedStats?.trophiesGained || tracking?.trophies_gained || 0,
          trophiesLost: trackedStats?.trophiesLost || tracking?.trophies_lost || 0,
          activeDays: trackedStats?.activeDays || tracking?.active_days || 0,
          currentStreak: trackedStats?.currentStreak || tracking?.current_streak || 0,
          bestStreak: trackedStats?.bestStreak || tracking?.best_streak || 0,
          peakDayBattles: trackedStats?.peakDayBattles || tracking?.peak_day_battles || 0,
        },
        weekly: {
          battles: rangeStats?.battles || 0,
          wins: rangeStats?.wins || 0,
          losses: rangeStats?.losses || 0,
          starPlayer: rangeStats?.starPlayer || 0,
          trophiesGained: rangeStats?.trophiesGained || 0,
          trophiesLost: rangeStats?.trophiesLost || 0,
          activeDays: rangeStats?.activeDays || 0,
          winRate: rangeStats?.winRate || 0,
          netTrophies: getRangeProgress(rangeKey, metrics, rangeStats),
        },
      };
    });

    const leaderboards = {
      trophyLeaders: [...enriched].sort((a, b) => b.trophies - a.trophies).slice(0, 30),
      weeklyBattlers: [...enriched]
        .filter((m) => m.weekly.battles > 0)
        .sort((a, b) => b.weekly.battles - a.weekly.battles)
        .slice(0, 30),
      weeklyWinRate: [...enriched]
        .filter((m) => m.weekly.battles >= rangeConfig.minWinRateBattles)
        .sort((a, b) => b.weekly.winRate - a.weekly.winRate)
        .slice(0, 30),
      weeklyTrophyGainers: [...enriched]
        .filter((m) => m.weekly.netTrophies != null && m.weekly.netTrophies !== 0)
        .sort((a, b) => (b.weekly.netTrophies || 0) - (a.weekly.netTrophies || 0))
        .slice(0, 30),
      weeklyStarPlayers: [...enriched]
        .filter((m) => m.weekly.starPlayer > 0)
        .sort((a, b) => b.weekly.starPlayer - a.weekly.starPlayer)
        .slice(0, 30),
      mostActive: [...enriched]
        .filter((m) => m.weekly.activeDays > 0)
        .sort((a, b) => b.weekly.activeDays - a.weekly.activeDays || b.weekly.battles - a.weekly.battles)
        .slice(0, 30),
      allTimeBattlers: [...enriched]
        .filter((m) => m.allTime.battles > 0)
        .sort((a, b) => b.allTime.battles - a.allTime.battles)
        .slice(0, 30),
    };

    const settings = new Map(
      (settingsRes.data || []).map((setting) => [setting.key, setting.value])
    );

    return NextResponse.json({
      leaderboards,
      memberCount: enriched.length,
      range: {
        key: rangeKey,
        label: rangeConfig.label,
        minWinRateBattles: rangeConfig.minWinRateBattles,
      },
      generatedAt: now.toISOString(),
      lastSyncTime: normalizeTimestamp(settings.get("last_sync_time")),
    });
  } catch (error) {
    console.error("Error fetching leaderboard:", error);
    return NextResponse.json({ error: "Failed to fetch leaderboard" }, { status: 500 });
  }
}
