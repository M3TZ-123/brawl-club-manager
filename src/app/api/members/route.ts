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
    
    const yesterdayMidnight = new Date(todayMidnight);
    yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);
    
    const sevenDaysAgo = new Date(todayMidnight);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Get activity logs for trophy calculations (get older data too)
    const { data: activityLogs } = await supabase
      .from("activity_log")
      .select("player_tag, trophies, recorded_at")
      .order("recorded_at", { ascending: true });

    // Calculate gains for each member
    const membersWithGains = (members || []).map((member) => {
      const playerLogs = activityLogs?.filter(
        (log) => log.player_tag === member.player_tag
      ) || [];

      // For 24h: Find the LAST log from BEFORE today (yesterday's last sync)
      // This gives us the baseline at end of yesterday / start of today
      const logsBeforeToday = playerLogs.filter(
        (log) => new Date(log.recorded_at) < todayMidnight
      );
      const lastLogBeforeToday = logsBeforeToday[logsBeforeToday.length - 1];
      
      // For 7 days: Find the first log from 7+ days ago
      const logsFrom7DaysAgo = playerLogs.filter(
        (log) => new Date(log.recorded_at) <= sevenDaysAgo
      );
      const baselineLog7d = logsFrom7DaysAgo[logsFrom7DaysAgo.length - 1];

      // Calculate 24h gain (from last night / start of today) - null if no yesterday data
      const trophies24h = lastLogBeforeToday
        ? member.trophies - lastLogBeforeToday.trophies
        : null;

      // Calculate 7-day gain - null if no data from 7 days ago
      const trophies7d = baselineLog7d
        ? member.trophies - baselineLog7d.trophies
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
