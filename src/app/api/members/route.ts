import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    const { data: members, error } = await supabase
      .from("members")
      .select("*")
      .order("trophies", { ascending: false });

    if (error) throw error;

    // Calculate trophy gains for each member
    const now = new Date();
    const todayMidnight = new Date(now);
    todayMidnight.setUTCHours(0, 0, 0, 0);
    
    const sevenDaysAgo = new Date(todayMidnight);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Get all activity logs for trophy calculations
    const { data: activityLogs } = await supabase
      .from("activity_log")
      .select("player_tag, trophies, recorded_at")
      .order("recorded_at", { ascending: true });

    // Calculate gains for each member
    const membersWithGains = (members || []).map((member) => {
      const playerLogs = activityLogs?.filter(
        (log) => log.player_tag === member.player_tag
      ) || [];

      if (playerLogs.length === 0) {
        return {
          ...member,
          trophies_24h: null,
          trophies_7d: null,
        };
      }

      // For 24h: Use first log from today as baseline
      const todayLogs = playerLogs.filter(
        (log) => new Date(log.recorded_at) >= todayMidnight
      );
      const firstTodayLog = todayLogs[0];
      
      // For 7 days: Use oldest log (or log from 7 days ago if available)
      const logsFrom7DaysAgo = playerLogs.filter(
        (log) => new Date(log.recorded_at) <= sevenDaysAgo
      );
      // Use the log from 7 days ago if available, otherwise use the oldest log
      const baseline7d = logsFrom7DaysAgo.length > 0 
        ? logsFrom7DaysAgo[logsFrom7DaysAgo.length - 1]
        : playerLogs[0];

      // Calculate 24h gain (from first sync today)
      const trophies24h = firstTodayLog
        ? member.trophies - firstTodayLog.trophies
        : null;

      // Calculate 7-day gain (from 7 days ago or oldest available)
      const trophies7d = baseline7d
        ? member.trophies - baseline7d.trophies
        : null;

      return {
        ...member,
        trophies_24h: trophies24h,
        trophies_7d: trophies7d,
      };
    });

    return NextResponse.json({ members: membersWithGains });
  } catch (error) {
    console.error("Error fetching members:", error);
    return NextResponse.json(
      { error: "Failed to fetch members" },
      { status: 500 }
    );
  }
}
