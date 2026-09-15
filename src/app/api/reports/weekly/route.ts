import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { appendMemberActivityMetrics } from "@/lib/member-activity-metrics";
import { getWeeklyReportingPeriod } from "@/lib/reporting-period";

export const dynamic = "force-dynamic";

type WeeklyStatsRow = {
  player_tag: string;
  date: string;
  wins: number | null;
  battles: number | null;
  trophies_gained: number | null;
  trophies_lost: number | null;
};

export async function GET() {
  try {
    // Get current member tags from member_history (same logic as /api/members)
    const { data: currentMemberHistory, error: currentMemberError } = await supabaseAdmin
      .from("member_history")
      .select("player_tag")
      .eq("is_current_member", true);

    if (currentMemberError) throw currentMemberError;
    
    const currentMemberTags = currentMemberHistory?.map(h => h.player_tag) || [];

    const now = new Date();
    const period = getWeeklyReportingPeriod(now);
    const weekAgoDate = period.dates[0];
    const currentMemberFilter = currentMemberTags.length > 0 ? currentMemberTags : [""];

    const [membersRes, weeklyStatsRes, eventsRes] = await Promise.all([
      supabaseAdmin
        .from("members")
        .select("player_tag, player_name, trophies, is_active")
        .in("player_tag", currentMemberFilter)
        .order("trophies", { ascending: false }),
      supabaseAdmin
        .from("daily_stats")
        .select("player_tag, date, wins, battles, trophies_gained, trophies_lost")
        .in("player_tag", currentMemberFilter)
        .gte("date", weekAgoDate)
        .lte("date", period.dates[6]),
      supabaseAdmin
        .from("club_events")
        .select("event_type, player_name, event_time")
        .gte("event_time", period.start.toISOString())
        .lte("event_time", period.end.toISOString())
        .order("event_time", { ascending: false })
        .limit(10),
    ]);

    if (membersRes.error) throw membersRes.error;
    if (weeklyStatsRes.error) throw weeklyStatsRes.error;
    if (eventsRes.error) throw eventsRes.error;

    const members = membersRes.data || [];
    const weeklyStats = weeklyStatsRes.data || [];
    const events = eventsRes.data || [];

    // Calculate report data
    const totalTrophies = members.reduce((sum, m) => sum + m.trophies, 0);
    const membersWithActivity = await appendMemberActivityMetrics(members, now);
    const activeCount = membersWithActivity.filter((member) => member.activity_status === "active").length;

    // Trophy changes by player from pre-aggregated daily stats.
    const playerTrophyChanges: Record<string, number> = {};
    const memberByTag = new Map(members.map((member) => [member.player_tag, member]));
    const netByDate = new Map<string, number>();
    for (const row of weeklyStats as WeeklyStatsRow[]) {
      const net = (row.trophies_gained || 0) - (row.trophies_lost || 0);
      playerTrophyChanges[row.player_tag] = (playerTrophyChanges[row.player_tag] || 0) + net;
      netByDate.set(row.date, (netByDate.get(row.date) || 0) + net);
    }

    // Top gainers (only players who actually gained trophies)
    const topGainers = Object.entries(playerTrophyChanges)
      .filter(([, change]) => change > 0)
      .map(([tag, change]) => {
        const member = memberByTag.get(tag);
        return {
          playerTag: tag,
          playerName: member?.player_name || "Unknown",
          trophyChange: change,
        };
      })
      .sort((a, b) => b.trophyChange - a.trophyChange)
      .slice(0, 5);

    const allChanges = Object.entries(playerTrophyChanges)
      .map(([tag, change]) => {
        const member = memberByTag.get(tag);
        return {
          playerTag: tag,
          playerName: member?.player_name || "Unknown",
          trophyChange: change,
        };
      })
      .sort((a, b) => a.trophyChange - b.trophyChange);

    // Worst trophy drops (negative only). If none, fallback to lowest progress.
    const negativeLosers = allChanges.filter((item) => item.trophyChange < 0).slice(0, 5);
    const hasRealLosses = negativeLosers.length > 0;
    const topLosers = hasRealLosses ? negativeLosers : allChanges.slice(0, 5);

    const weeklyWins = (weeklyStats || []).reduce((sum, row) => sum + (row.wins || 0), 0);
    const weeklyBattles = (weeklyStats || []).reduce((sum, row) => sum + (row.battles || 0), 0);
    const weeklyWinRate = weeklyBattles > 0
      ? Math.round((weeklyWins / weeklyBattles) * 100)
      : 0;

    // Activity distribution
    const activityDistribution = {
      active: activeCount,
      minimal: membersWithActivity.filter((member) => member.activity_status === "minimal").length,
      inactive: membersWithActivity.filter((member) => member.activity_status === "inactive").length,
    };

    const trophyTrend: { date: string; trophies: number }[] = [];
    const trendDates = period.dates;

    for (const date of trendDates) {
      const futureNet = trendDates
        .filter((candidate) => candidate > date)
        .reduce((sum, candidate) => sum + (netByDate.get(candidate) || 0), 0);
      trophyTrend.push({
        date,
        trophies: totalTrophies - futureNet,
      });
    }

    const report = {
      generatedAt: now.toISOString(),
      period: {
        start: period.start.toISOString(),
        end: period.end.toISOString(),
      },
      summary: {
        totalMembers: members.length,
        totalTrophies,
        avgTrophies: members.length > 0 ? Math.round(totalTrophies / members.length) : 0,
        activeMembers: activeCount,
        activityRate: members.length > 0 ? Math.round((activeCount / members.length) * 100) : 0,
        weeklyWins,
        weeklyBattles,
        weeklyWinRate,
      },
      topGainers,
      topLosers,
      topLosersMode: hasRealLosses ? "losses" : "lowest_progress",
      activityDistribution,
      recentEvents: events?.slice(0, 10) || [],
      trophyTrend,
    };

    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Error generating report:", error);
    return NextResponse.json(
      { error: "Failed to generate report" },
      { status: 500 }
    );
  }
}
