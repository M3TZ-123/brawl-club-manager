import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    // Get current member tags from member_history (same logic as /api/members)
    const { data: currentMemberHistory } = await supabase
      .from("member_history")
      .select("player_tag")
      .eq("is_current_member", true);
    
    const currentMemberTags = currentMemberHistory?.map(h => h.player_tag) || [];

    // Only fetch members who are currently in the club
    const { data: members, error } = await supabase
      .from("members")
      .select("*")
      .in("player_tag", currentMemberTags.length > 0 ? currentMemberTags : [''])
      .order("trophies", { ascending: false });

    if (error) throw error;

    // Get activity logs from last 7 days
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const { data: activityLogs } = await supabase
      .from("activity_log")
      .select("*")
      .gte("recorded_at", new Date(weekAgo.getTime() - 24 * 60 * 60 * 1000).toISOString())
      .order("recorded_at", { ascending: true });

    const weekAgoDate = weekAgo.toISOString().slice(0, 10);
    const { data: weeklyStats } = await supabase
      .from("daily_stats")
      .select("player_tag, wins, battles")
      .in("player_tag", currentMemberTags.length > 0 ? currentMemberTags : [""])
      .gte("date", weekAgoDate);

    // Get events from last 7 days
    const { data: events } = await supabase
      .from("club_events")
      .select("*")
      .gte("event_time", weekAgo.toISOString());

    if (!members) {
      return NextResponse.json({ error: "No data available" }, { status: 404 });
    }

    // Calculate report data
    const totalTrophies = members.reduce((sum, m) => sum + m.trophies, 0);
    const activeCount = members.filter((m) => m.is_active).length;

    // Trophy changes by player (current members only), based on 7-day baseline snapshots
    // This matches /api/members logic and avoids drift from summing sync deltas.
    const currentMemberTagSet = new Set((members || []).map((m) => m.player_tag));
    const logsByPlayer = new Map<string, { player_tag: string; trophies: number; recorded_at: string }[]>();

    for (const log of activityLogs || []) {
      if (!currentMemberTagSet.has(log.player_tag)) continue;
      if (!logsByPlayer.has(log.player_tag)) {
        logsByPlayer.set(log.player_tag, []);
      }
      logsByPlayer.get(log.player_tag)!.push({
        player_tag: log.player_tag,
        trophies: log.trophies,
        recorded_at: log.recorded_at,
      });
    }

    const playerTrophyChanges: Record<string, number> = {};
    for (const member of members) {
      const playerLogs = logsByPlayer.get(member.player_tag) || [];
      if (playerLogs.length === 0) continue;

      const logsBefore7d = playerLogs.filter((log) => new Date(log.recorded_at) <= weekAgo);
      const baseline7d = logsBefore7d.length > 0 ? logsBefore7d[logsBefore7d.length - 1] : null;

      if (!baseline7d) continue;
      playerTrophyChanges[member.player_tag] = member.trophies - baseline7d.trophies;
    }

    // Top gainers (only players who actually gained trophies)
    const topGainers = Object.entries(playerTrophyChanges)
      .filter(([, change]) => change > 0)
      .map(([tag, change]) => {
        const member = members.find((m) => m.player_tag === tag);
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
        const member = members.find((m) => m.player_tag === tag);
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
      active: members.filter((m) => m.is_active).length,
      minimal: 0, // Would need more sophisticated tracking
      inactive: members.filter((m) => !m.is_active).length,
    };

    // Daily trophy totals - aggregate all members' trophies per day
    const dailyTrophies: Record<string, number> = {};
    
    // Group logs by date, then sum the latest trophy value for each player on that date
    const logsByDate: Record<string, Record<string, number>> = {};
    activityLogs?.forEach((log) => {
      const date = new Date(log.recorded_at).toISOString().slice(0, 10);
      if (!logsByDate[date]) {
        logsByDate[date] = {};
      }
      // Keep the latest trophy value for each player on each day
      logsByDate[date][log.player_tag] = log.trophies;
    });

    // Sum up all players' trophies for each day
    Object.entries(logsByDate).forEach(([date, playerTrophies]) => {
      dailyTrophies[date] = Object.values(playerTrophies).reduce((sum, t) => sum + t, 0);
    });

    // Add today's total from current members if not already present
    const today = new Date().toISOString().slice(0, 10);
    if (!dailyTrophies[today] && members.length > 0) {
      dailyTrophies[today] = totalTrophies;
    }

    const report = {
      generatedAt: new Date().toISOString(),
      period: {
        start: weekAgo.toISOString(),
        end: new Date().toISOString(),
      },
      summary: {
        totalMembers: members.length,
        totalTrophies,
        avgTrophies: Math.round(totalTrophies / members.length),
        activeMembers: activeCount,
        activityRate: Math.round((activeCount / members.length) * 100),
        weeklyWins,
        weeklyBattles,
        weeklyWinRate,
      },
      topGainers,
      topLosers,
      topLosersMode: hasRealLosses ? "losses" : "lowest_progress",
      activityDistribution,
      recentEvents: events?.slice(0, 10) || [],
      trophyTrend: Object.entries(dailyTrophies)
        .map(([date, trophies]) => ({
          date,
          trophies,
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };

    return NextResponse.json(report);
  } catch (error) {
    console.error("Error generating report:", error);
    return NextResponse.json(
      { error: "Failed to generate report" },
      { status: 500 }
    );
  }
}
