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
    todayMidnight.setHours(0, 0, 0, 0);
    
    const sevenDaysAgo = new Date(todayMidnight);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Get activity logs for trophy calculations
    const { data: activityLogs } = await supabase
      .from("activity_log")
      .select("player_tag, trophies, recorded_at")
      .gte("recorded_at", sevenDaysAgo.toISOString())
      .order("recorded_at", { ascending: true });

    // Calculate gains for each member
    const membersWithGains = (members || []).map((member) => {
      const playerLogs = activityLogs?.filter(
        (log) => log.player_tag === member.player_tag
      ) || [];

      // Find the first log from today (after midnight)
      const todayLogs = playerLogs.filter(
        (log) => new Date(log.recorded_at) >= todayMidnight
      );
      const firstTodayLog = todayLogs[0];
      
      // Find the first log from 7 days ago
      const firstLog = playerLogs[0];

      // Calculate 24h gain (from midnight today) - null if no data
      const trophies24h = firstTodayLog
        ? member.trophies - firstTodayLog.trophies
        : null;

      // Calculate 7-day gain - null if no data
      const trophies7d = firstLog
        ? member.trophies - firstLog.trophies
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
