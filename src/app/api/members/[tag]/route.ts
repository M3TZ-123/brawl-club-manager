import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { aggregateDailyBattleStats } from "@/lib/battle-tracking-stats";
import { appendMemberActivityMetrics } from "@/lib/member-activity-metrics";
import { parseTimeRange, TIME_RANGES } from "@/lib/time-range";
import { getReportingPeriod, reportingPeriodMetadata } from "@/lib/reporting-period";
import { fetchDailyStats } from "@/lib/reporting-data";
import { executeSync, SyncError } from "@/lib/sync-service";
import { rejectUnauthorizedAdminMutation } from "@/lib/admin-auth";
import { PUBLIC_MEMBER_COLUMNS, publicMemberSnapshot, publicAuditSnapshot } from "@/lib/sync-public-snapshots";

type RecentMatch = {
  battle_time: string;
  mode: string | null;
  map: string | null;
  result: string | null;
  trophy_change: number;
  is_star_player: boolean;
  brawler_name: string | null;
  brawler_power: number | null;
};

type ActivityHistoryRow = {
  id: number;
  player_tag: string;
  trophies: number;
  trophy_change: number;
  activity_type: string;
  recorded_at: string;
};

async function fetchActivityHistory(playerTag: string, days: number, now: Date): Promise<ActivityHistoryRow[]> {
  const { data, error } = await supabaseAdmin.rpc("report_member_activity_history", {
    p_player_tag: playerTag, p_days: days, p_now: now.toISOString(),
  });
  if (error) throw error;
  return ((data || []) as ActivityHistoryRow[]).map(({ id, player_tag, trophies, trophy_change, activity_type, recorded_at }) => ({
    id, player_tag, trophies, trophy_change, activity_type, recorded_at,
  }));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tag: string }> }
) {
  try {
    const { tag } = await params;
    const playerTag = decodeURIComponent(tag);

    const now = new Date();
    const range = parseTimeRange(new URL(request.url).searchParams.get("range"));
    const period = getReportingPeriod(range, now);

    const [
      memberRes,
      activityHistory,
      firstActivityRowsRes,
      recentMatchesRes,
      memberHistoryRes,
      dailyStats,
      playerTrackingRes,
      snapshotRowsRes,
    ] = await Promise.all([
      supabaseAdmin
        .from("members")
        .select(PUBLIC_MEMBER_COLUMNS)
        .eq("player_tag", playerTag)
        .single(),
      fetchActivityHistory(playerTag, period.days, now),
      supabaseAdmin
        .from("activity_log")
        .select("recorded_at")
        .eq("player_tag", playerTag).lte("recorded_at", now.toISOString())
        .order("recorded_at", { ascending: true })
        .limit(1),
      supabaseAdmin
        .from("battle_history")
        .select("battle_time, mode, map, result, trophy_change, is_star_player, brawler_name, brawler_power")
        .eq("player_tag", playerTag)
        .gte("battle_time", period.start.toISOString()).lte("battle_time", now.toISOString())
        .order("battle_time", { ascending: false })
        .limit(25),
      supabaseAdmin
        .from("member_history")
        .select("player_tag,player_name,first_seen,last_seen,last_left_at,times_joined,times_left,is_current_member,role_at_leave,trophies_at_leave")
        .eq("player_tag", playerTag)
        .maybeSingle(),
      fetchDailyStats([playerTag], period.dates[0], period.dates.at(-1)!),
      supabaseAdmin
        .from("player_tracking")
        .select("player_tag,total_battles,total_wins,total_losses,star_player_count,trophies_gained,trophies_lost,active_days,current_streak,best_streak,peak_day_battles,last_battle_date,power_ups,unlocks,tracking_started,last_updated")
        .eq("player_tag", playerTag)
        .maybeSingle(),
      supabaseAdmin
        .from("brawler_snapshots")
        .select("brawler_id, brawler_name, power_level, trophies, rank, recorded_at")
        .eq("player_tag", playerTag)
        .order("recorded_at", { ascending: false })
        .limit(500),
    ]);

    const { data: member, error } = memberRes;

    if (error || !member) {
      return NextResponse.json(
        { error: "Member not found" },
        { status: 404 }
      );
    }

    if (firstActivityRowsRes.error) throw firstActivityRowsRes.error;
    if (recentMatchesRes.error) throw recentMatchesRes.error;
    if (memberHistoryRes.error) throw memberHistoryRes.error;
    if (playerTrackingRes.error) throw playerTrackingRes.error;
    if (snapshotRowsRes.error) throw snapshotRowsRes.error;

    const firstActivityRows = firstActivityRowsRes.data;
    const recentMatches = recentMatchesRes.data || [];
    const memberHistory = memberHistoryRes.data;
    const playerTracking = playerTrackingRes.data;
    const snapshotRows = snapshotRowsRes.data || [];

    const [memberMetrics] = await appendMemberActivityMetrics([member], now);
    const lastBattleTime = memberMetrics.last_battle_at;
    const dailyRows = dailyStats;
    const aggregate = aggregateDailyBattleStats(dailyRows, [playerTag], now).get(playerTag)!;
    const enhancedStats = dailyRows.length ? {
      totalBattles: aggregate.battles, totalWins: aggregate.wins, totalLosses: aggregate.losses,
      winRate: aggregate.battles ? Math.round(aggregate.wins / aggregate.battles * 100) : 0,
      starPlayerCount: aggregate.starPlayer, trophiesGained: aggregate.trophiesGained,
      trophiesLost: aggregate.trophiesLost, netTrophies: memberMetrics[TIME_RANGES[range].metric],
      activeDays: aggregate.activeDays, totalDays: period.days, currentStreak: aggregate.currentStreak,
      bestStreak: aggregate.bestStreak, peakDayBattles: aggregate.peakDayBattles,
      powerUps: playerTracking?.power_ups || 0, unlocks: playerTracking?.unlocks || 0,
      brawlerChangesScope: "tracked_history", trackedDays: 1,
    } : null;
    const totalBattles = dailyRows.reduce((sum, stat) => sum + (stat.battles || 0), 0);
    const totalWins = dailyRows.reduce((sum, stat) => sum + (stat.wins || 0), 0);
    const totalLosses = dailyRows.reduce((sum, stat) => sum + (stat.losses || 0), 0);
    const starPlayerCount = dailyRows.reduce((sum, stat) => sum + (stat.star_player || 0), 0);
    const trophiesGained = dailyRows.reduce((sum, stat) => sum + (stat.trophies_gained || 0), 0);
    const trophiesLost = dailyRows.reduce((sum, stat) => sum + (stat.trophies_lost || 0), 0);
    const activeDays = dailyRows.filter((stat) => (stat.battles || 0) > 0).length;
    const battleStats = dailyRows.length > 0
      ? {
          battles: totalBattles,
          wins: totalWins,
          losses: totalLosses,
          winRate: totalBattles > 0 ? Math.round((totalWins / totalBattles) * 100) : 0,
          starPlayer: starPlayerCount,
          trophyChange: trophiesGained - trophiesLost,
          activeDays,
          battlesByDay: Object.fromEntries(
            dailyRows
              .filter((stat) => (stat.battles || 0) > 0)
              .map((stat) => [stat.date, stat.battles || 0])
          ),
        }
      : null;

    let powerDistribution = null;
    let topBrawlers: Array<{
      id: number;
      name: string;
      trophies: number;
      highestTrophies: number;
      power: number;
      rank: number;
      icon_url: string;
    }> = [];
    const playerTags: string[] = [];

    // Build calendar data from daily_stats (more reliable than battle log)
    const calendarBattlesByDay: Record<string, number> = {};
    if (dailyStats) {
      for (const stat of dailyStats) {
        if ((stat.battles || 0) > 0) {
          calendarBattlesByDay[stat.date] = stat.battles || 0;
        }
      }
    }

    // Calculate tracked days from first activity log or member creation
    let trackedDays = 1;
    const firstActivity = firstActivityRows?.[0];
    if (firstActivity) {
      const firstDate = new Date(firstActivity.recorded_at);
      trackedDays = Math.max(1, Math.floor((Date.now() - firstDate.getTime()) / (24 * 60 * 60 * 1000)));
    }

    // Override tracked days in enhanced stats if we have better data
    if (enhancedStats) {
      enhancedStats.trackedDays = trackedDays;
    }

    const latestByBrawler = new Map<number, {
      brawler_id: number;
      brawler_name: string;
      power_level: number;
      trophies: number;
      rank: number;
      max_trophies: number;
    }>();

    for (const row of snapshotRows || []) {
      const existing = latestByBrawler.get(row.brawler_id);
      if (!existing) {
        latestByBrawler.set(row.brawler_id, {
          brawler_id: row.brawler_id,
          brawler_name: row.brawler_name,
          power_level: row.power_level,
          trophies: row.trophies,
          rank: row.rank,
          max_trophies: row.trophies,
        });
      } else if (row.trophies > existing.max_trophies) {
        existing.max_trophies = row.trophies;
      }
    }

    const latestBrawlers = Array.from(latestByBrawler.values());
    if (latestBrawlers.length > 0) {
      const distribution = Array(11).fill(0);
      let totalPower = 0;
      let maxedCount = 0;

      for (const brawler of latestBrawlers) {
        const power = Math.min(Math.max(brawler.power_level || 1, 1), 11);
        distribution[power - 1]++;
        totalPower += power;
        if (power === 11) maxedCount++;
      }

      powerDistribution = {
        distribution,
        avgPower: totalPower / latestBrawlers.length,
        maxedCount,
      };

      topBrawlers = latestBrawlers
        .sort((a, b) => b.trophies - a.trophies)
        .slice(0, 5)
        .map((brawler) => ({
          id: brawler.brawler_id,
          name: brawler.brawler_name,
          trophies: brawler.trophies,
          highestTrophies: brawler.max_trophies,
          power: brawler.power_level,
          rank: brawler.rank,
          icon_url: `https://cdn.brawlify.com/brawlers/borders/${brawler.brawler_id}.png`,
        }));
    }

    return NextResponse.json({
      period: reportingPeriodMetadata(period),
      activityHistoryResolution: period.days === 1 ? "hourly" : period.days === 3 ? "three_hourly" : period.days === 7 ? "six_hourly" : "daily",
      member: { ...publicMemberSnapshot(member), activity_status: memberMetrics.activity_status,
        last_battle_at: memberMetrics.last_battle_at,
        trophies_24h: memberMetrics.trophies_24h, trophies_3d: memberMetrics.trophies_3d,
        trophies_7d: memberMetrics.trophies_7d, trophies_30d: memberMetrics.trophies_30d,
        trophies_90d: memberMetrics.trophies_90d, trophy_baselines: memberMetrics.trophy_baselines },
      activityHistory: activityHistory || [],
      memberHistory: publicAuditSnapshot(memberHistory),
      lastBattleTime,
      battleStats,
      enhancedStats,
      powerDistribution,
      brawlers: null,
      topBrawlers,
      recentMatches: (recentMatches || []) as RecentMatch[],
      playerTags,
      calendarBattlesByDay,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Error fetching member:", error);
    return NextResponse.json(
      { error: "Failed to fetch member details" },
      { status: 500 }
    );
  }
}

// The member refresh shares the club lease and transactional persistence.
export async function POST(request: NextRequest, { params }: { params: Promise<{ tag: string }> }) {
  try {
    const denied = rejectUnauthorizedAdminMutation(request); if (denied) return denied;
    const { tag } = await params;
    return NextResponse.json(await executeSync({ source: "member", playerTag: decodeURIComponent(tag),
      idempotencyKey: request.headers.get("idempotency-key") }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof SyncError ? error.message : "Failed to refresh member data",
      code: error instanceof SyncError ? error.code : "sync_failed" }, { status: error instanceof SyncError ? error.status : 500 });
  }
}
