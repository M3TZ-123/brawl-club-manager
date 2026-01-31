import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    // Get settings to find club tag
    const { data: settings } = await supabase
      .from("settings")
      .select("club_tag")
      .single();

    const clubTag = settings?.club_tag;

    // Get only current members by joining with member_history
    let membersQuery = supabase
      .from("members")
      .select("*")
      .order("trophies", { ascending: false });

    // If we have a club tag, filter to only current members
    let members = null;
    if (clubTag) {
      const { data: currentMemberTags } = await supabase
        .from("member_history")
        .select("player_tag")
        .eq("club_tag", clubTag)
        .eq("is_current_member", true);

      if (currentMemberTags && currentMemberTags.length > 0) {
        const tags = currentMemberTags.map((m) => m.player_tag);
        const { data } = await supabase
          .from("members")
          .select("*")
          .in("player_tag", tags)
          .order("trophies", { ascending: false });
        members = data;
      }
    }

    // Fallback to all members if no member_history data
    if (!members || members.length === 0) {
      const { data } = await membersQuery;
      members = data;
    }

    // Get activity logs from last 7 days
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const { data: activityLogs } = await supabase
      .from("activity_log")
      .select("*")
      .gte("recorded_at", weekAgo.toISOString())
      .order("recorded_at", { ascending: true });

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

    // Trophy changes by player
    const playerTrophyChanges: Record<string, number> = {};
    activityLogs?.forEach((log) => {
      if (!playerTrophyChanges[log.player_tag]) {
        playerTrophyChanges[log.player_tag] = 0;
      }
      playerTrophyChanges[log.player_tag] += log.trophy_change;
    });

    // Top gainers
    const topGainers = Object.entries(playerTrophyChanges)
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

    // Biggest losers
    const topLosers = Object.entries(playerTrophyChanges)
      .map(([tag, change]) => {
        const member = members.find((m) => m.player_tag === tag);
        return {
          playerTag: tag,
          playerName: member?.player_name || "Unknown",
          trophyChange: change,
        };
      })
      .sort((a, b) => a.trophyChange - b.trophyChange)
      .slice(0, 5);

    // Activity distribution
    const activityDistribution = {
      active: members.filter((m) => m.is_active).length,
      minimal: 0, // Would need more sophisticated tracking
      inactive: members.filter((m) => !m.is_active).length,
    };

    // Daily trophy totals
    const dailyTrophies: Record<string, number> = {};
    activityLogs?.forEach((log) => {
      const date = new Date(log.recorded_at).toLocaleDateString();
      dailyTrophies[date] = log.trophies; // Last recorded value for that day
    });

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
      },
      topGainers,
      topLosers,
      activityDistribution,
      recentEvents: events?.slice(0, 10) || [],
      trophyTrend: Object.entries(dailyTrophies).map(([date, trophies]) => ({
        date,
        trophies,
      })),
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
