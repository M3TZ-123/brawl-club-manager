import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { aggregateDailyBattleStats } from "@/lib/battle-tracking-stats";
import { appendMemberActivityMetrics } from "@/lib/member-activity-metrics";

import { parseTimeRange, TIME_RANGES } from "@/lib/time-range";
import { getReportingPeriod, reportingPeriodMetadata } from "@/lib/reporting-period";
import { fetchDailyStats } from "@/lib/reporting-data";

const MIN_WIN_RATE_BATTLES = { "24h": 3, "3d": 5, "7d": 10, "30d": 20, "90d": 30 } as const;

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

function normalizeTimestamp(value: string | null | undefined) {
  const timestamp = value?.trim();
  if (!timestamp) return null;

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString();
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

export async function GET(request: NextRequest) {
  try {
    const now = new Date();
    const rangeKey = parseTimeRange(request.nextUrl.searchParams.get("range"));
    const period = getReportingPeriod(rangeKey, now);
    const metric = TIME_RANGES[rangeKey].metric;
    const minWinRateBattles = MIN_WIN_RATE_BATTLES[rangeKey];
    const [currentMembersRes, settingsRes] = await Promise.all([
      supabaseAdmin
        .from("member_history")
        .select("player_tag")
        .eq("is_current_member", true),
      supabaseAdmin
        .from("settings")
        .select("key, value")
        .in("key", ["last_sync_time"]),
    ]);

    if (currentMembersRes.error) throw currentMembersRes.error;
    if (settingsRes.error) throw settingsRes.error;

    const currentTags = new Set((currentMembersRes.data || []).map((m) => m.player_tag));
    const currentTagList = [...currentTags];
    const [membersRes, dailyStatsRows, trackingRows] = await Promise.all([
      supabaseAdmin.from("members")
        .select("player_tag, player_name, trophies, highest_trophies, role, win_rate, solo_victories, duo_victories, trio_victories, brawlers_count, rank_current, rank_highest, exp_level")
        .in("player_tag", currentTagList.length ? currentTagList : [""]),
      fetchDailyStats(currentTagList, new Date(now.getTime() - 364 * 86_400_000).toISOString().slice(0, 10), period.dates.at(-1)!),
      fetchTrackingRows(currentTagList),
    ]);
    if (membersRes.error) throw membersRes.error;
    const members = membersRes.data || [];
    const membersWithMetrics = await appendMemberActivityMetrics(members, now);
    const memberMetricsByTag = new Map(
      membersWithMetrics.map((member) => [member.player_tag, member])
    );

    const trackingMap = new Map(trackingRows.map((row) => [row.player_tag, row]));
    const trackedStatsMap = aggregateDailyBattleStats(dailyStatsRows, currentTagList, now);
    const rangeStatsMap = aggregateDailyBattleStats(dailyStatsRows.filter(row => row.date >= period.dates[0]), currentTagList, now);

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
          winRate: rangeStats?.battles ? Math.round(rangeStats.wins / rangeStats.battles * 100) : 0,
          netTrophies: metrics?.[metric] ?? null,
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
        .filter((m) => m.weekly.battles >= minWinRateBattles)
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
      period: reportingPeriodMetadata(period),
      range: {
        key: rangeKey,
        label: TIME_RANGES[rangeKey].label,
        minWinRateBattles: minWinRateBattles,
      },
      generatedAt: now.toISOString(),
      lastSyncTime: normalizeTimestamp(settings.get("last_sync_time")),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Error fetching leaderboard:", error);
    return NextResponse.json({ error: "Failed to fetch leaderboard" }, { status: 500 });
  }
}
