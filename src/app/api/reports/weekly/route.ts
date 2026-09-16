import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { appendMemberActivityMetrics } from "@/lib/member-activity-metrics";
import { getReportingPeriod, reportingPeriodMetadata } from "@/lib/reporting-period";
import { fetchDailyStats, fetchAccountTrophyTrend } from "@/lib/reporting-data";
import { parseTimeRange, TIME_RANGES } from "@/lib/time-range";

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
  try {
    // Get current member tags from member_history (same logic as /api/members)
    const { data: currentMemberHistory, error: currentMemberError } = await supabaseAdmin
      .from("member_history")
      .select("player_tag")
      .eq("is_current_member", true);

    if (currentMemberError) throw currentMemberError;
    
    const currentMemberTags = currentMemberHistory?.map(h => h.player_tag) || [];

    const now = new Date();
    const range = parseTimeRange(request ? new URL(request.url).searchParams.get("range") : null);
    const period = getReportingPeriod(range, now);
    const metric = TIME_RANGES[range].metric;
    const weekAgoDate = period.dates[0];
    const currentMemberFilter = currentMemberTags.length > 0 ? currentMemberTags : [""];

    const [membersRes, weeklyStats, eventsRes, trophyTrend] = await Promise.all([
      supabaseAdmin
        .from("members")
        .select("player_tag, player_name, trophies, is_active")
        .in("player_tag", currentMemberFilter)
        .order("trophies", { ascending: false }),
      fetchDailyStats(currentMemberTags, weekAgoDate, period.dates.at(-1)!),
      supabaseAdmin
        .from("club_events")
        .select("event_type, player_name, event_time")
        .gte("event_time", period.start.toISOString())
        .lte("event_time", period.end.toISOString())
        .order("event_time", { ascending: false })
        .limit(10),
      fetchAccountTrophyTrend(currentMemberTags, period.days, now),
    ]);

    if (membersRes.error) throw membersRes.error;
    if (eventsRes.error) throw eventsRes.error;

    const members = membersRes.data || [];
    const events = eventsRes.data || [];

    // Calculate report data
    const totalTrophies = members.reduce((sum, m) => sum + m.trophies, 0);
    const membersWithActivity = await appendMemberActivityMetrics(members, now);
    const activeCount = membersWithActivity.filter((member) => member.activity_status === "active").length;

    // Account progress requires an account balance baseline, not a partial battle sum.
    const allChanges = membersWithActivity.flatMap(member => member[metric] == null ? [] : [{
      playerTag: member.player_tag,
      playerName: member.player_name,
      trophyChange: member[metric] as number,
    }]).sort((a, b) => a.trophyChange - b.trophyChange);
    const topGainers = allChanges
      .filter(member => member.trophyChange > 0)
      .sort((a, b) => b.trophyChange - a.trophyChange)
      .slice(0, 5);

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

    const report = {
      generatedAt: now.toISOString(),
      period: reportingPeriodMetadata(period),
      trophyTrendBasis: "observed_current_member_account_balances",
      summary: {
        totalMembers: members.length,
        totalTrophies,
        avgTrophies: members.length > 0 ? Math.round(totalTrophies / members.length) : 0,
        activeMembers: activeCount,
        activityRate: members.length > 0 ? Math.round((activeCount / members.length) * 100) : 0,
        weeklyWins,
        weeklyBattles,
        weeklyWinRate,
        trophyProgressKnownMembers: allChanges.length,
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
