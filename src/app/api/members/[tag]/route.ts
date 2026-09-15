import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { calculateEnhancedStats } from "@/lib/brawl-api";
import { executeSync, SyncError } from "@/lib/sync-service";
import { rejectUnauthorizedAdminMutation } from "@/lib/admin-auth";
import { classifyActivity, normalizeInactivityThreshold } from "@/lib/activity-status";
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

async function fetchActivityHistorySince(playerTag: string, sinceISO: string): Promise<ActivityHistoryRow[]> {
  const pageSize = 1000;
  const rows: ActivityHistoryRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("activity_log")
      .select("id,player_tag,trophies,trophy_change,activity_type,recorded_at")
      .eq("player_tag", playerTag)
      .gte("recorded_at", sinceISO)
      .order("recorded_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows.push(...((data || []) as ActivityHistoryRow[]).map(({ id, player_tag, trophies, trophy_change, activity_type, recorded_at }) => ({ id, player_tag, trophies, trophy_change, activity_type, recorded_at })));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function getInactivityThresholdHours(): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("value")
    .eq("key", "inactivity_threshold")
    .maybeSingle();

  if (error) throw error;
  return normalizeInactivityThreshold(data?.value);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ tag: string }> }
) {
  try {
    const { tag } = await params;
    const playerTag = decodeURIComponent(tag);

    const activitySince = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString();
    const twentyEightDaysAgo = new Date();
    twentyEightDaysAgo.setDate(twentyEightDaysAgo.getDate() - 28);

    const [
      memberRes,
      activityHistory,
      firstActivityRowsRes,
      recentMatchesRes,
      memberHistoryRes,
      dailyStatsRes,
      playerTrackingRes,
      snapshotRowsRes,
      inactivityThreshold,
    ] = await Promise.all([
      supabaseAdmin
        .from("members")
        .select(PUBLIC_MEMBER_COLUMNS)
        .eq("player_tag", playerTag)
        .single(),
      fetchActivityHistorySince(playerTag, activitySince),
      supabaseAdmin
        .from("activity_log")
        .select("recorded_at")
        .eq("player_tag", playerTag)
        .order("recorded_at", { ascending: true })
        .limit(1),
      supabaseAdmin
        .from("battle_history")
        .select("battle_time, mode, map, result, trophy_change, is_star_player, brawler_name, brawler_power")
        .eq("player_tag", playerTag)
        .lte("battle_time", new Date(Date.now() + 60_000).toISOString())
        .order("battle_time", { ascending: false })
        .limit(25),
      supabaseAdmin
        .from("member_history")
        .select("player_tag,player_name,first_seen,last_seen,last_left_at,times_joined,times_left,is_current_member,role_at_leave,trophies_at_leave")
        .eq("player_tag", playerTag)
        .maybeSingle(),
      supabaseAdmin
        .from("daily_stats")
        .select("id,player_tag,date,battles,wins,losses,star_player,trophies_gained,trophies_lost")
        .eq("player_tag", playerTag)
        .gte("date", twentyEightDaysAgo.toISOString().slice(0, 10))
        .order("date", { ascending: true }),
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
      getInactivityThresholdHours(),
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
    if (dailyStatsRes.error) throw dailyStatsRes.error;
    if (playerTrackingRes.error) throw playerTrackingRes.error;
    if (snapshotRowsRes.error) throw snapshotRowsRes.error;

    const firstActivityRows = firstActivityRowsRes.data;
    const recentMatches = recentMatchesRes.data || [];
    const memberHistory = memberHistoryRes.data;
    const dailyStats = dailyStatsRes.data || [];
    const playerTracking = playerTrackingRes.data;
    const snapshotRows = snapshotRowsRes.data || [];

    // Calculate enhanced stats from stored data
    let enhancedStats = null;
    if (dailyStats && dailyStats.length > 0) {
      enhancedStats = calculateEnhancedStats(dailyStats, playerTracking);
    }

    const dailyRows = dailyStats || [];
    const now = new Date();
    const trackingBattleTime = playerTracking?.last_battle_date
      ? new Date(`${playerTracking.last_battle_date}T00:00:00.000Z`)
      : null;
    const validTrackingTime = trackingBattleTime && Number.isFinite(trackingBattleTime.getTime())
      && trackingBattleTime.getTime() <= now.getTime() + 60_000;
    const lastBattleTime = recentMatches?.[0]?.battle_time
      || (validTrackingTime ? trackingBattleTime.toISOString() : null);
    let lastActivityAt = lastBattleTime ? new Date(lastBattleTime) : null;
    for (const activity of activityHistory) {
      const recordedAt = new Date(activity.recorded_at);
      if (typeof activity.trophy_change === "number" && activity.trophy_change !== 0 && recordedAt <= now && (!lastActivityAt || recordedAt > lastActivityAt)) {
        lastActivityAt = recordedAt;
      }
    }
    const activityStatus = classifyActivity(lastActivityAt, now, inactivityThreshold);
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
        if (stat.battles > 0) {
          calendarBattlesByDay[stat.date] = stat.battles;
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
      member: { ...publicMemberSnapshot(member), activity_status: activityStatus },
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
    });
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
