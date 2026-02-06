import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    // Get current member tags from member_history
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

    // Calculate trophy gains for each member
    const now = new Date();
    
    // For 24h: look back exactly 24 hours
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    // For 7 days: look back exactly 7 days
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Get today's date and yesterday's date for daily_stats queries
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const sevenDaysAgoDate = sevenDaysAgo.toISOString().slice(0, 10);

    // Get daily stats for trophy calculations (more accurate than activity_log)
    const { data: dailyStats } = await supabase
      .from("daily_stats")
      .select("player_tag, date, trophies_gained, trophies_lost")
      .gte("date", sevenDaysAgoDate)
      .order("date", { ascending: true });

    // Get all activity logs as fallback for trophy calculations
    const { data: activityLogs } = await supabase
      .from("activity_log")
      .select("player_tag, trophies, recorded_at")
      .order("recorded_at", { ascending: true });

    // Calculate gains for each member
    const membersWithGains = (members || []).map((member) => {
      // First try to calculate from daily_stats (more accurate - from battle history)
      const playerDailyStats = dailyStats?.filter(
        (stat) => stat.player_tag === member.player_tag
      ) || [];
      
      if (playerDailyStats.length > 0) {
        // Calculate net trophies from daily stats
        let trophies24h = 0;
        let trophies7d = 0;
        
        for (const stat of playerDailyStats) {
          const netTrophies = (stat.trophies_gained || 0) - (stat.trophies_lost || 0);
          trophies7d += netTrophies;
          
          // Only include today's stats for 24h (daily stats are per day)
          if (stat.date === today || stat.date === yesterday) {
            trophies24h += netTrophies;
          }
        }
        
        return {
          ...member,
          trophies_24h: trophies24h,
          trophies_7d: trophies7d,
        };
      }
      
      // Fallback to activity_log if no daily stats
      const playerLogs = activityLogs?.filter(
        (log) => log.player_tag === member.player_tag
      ) || [];

      // If no activity logs exist, show 0 (member exists but no historical data yet)
      if (playerLogs.length === 0) {
        return {
          ...member,
          trophies_24h: 0,
          trophies_7d: 0,
        };
      }

      // Get the oldest log available (first log since tracking started)
      const oldestLog = playerLogs[0];
      
      // For 24h: Find the most recent log that is AT LEAST 24 hours old
      const logsBefore24h = playerLogs.filter(
        (log) => new Date(log.recorded_at) <= twentyFourHoursAgo
      );
      // Use the most recent log that is at least 24h old, or fall back to oldest log for new members
      const baseline24h = logsBefore24h.length > 0 
        ? logsBefore24h[logsBefore24h.length - 1]  // Most recent log that is ≥24h old
        : oldestLog;  // For new members: use oldest available log
      
      // For 7 days: Find the most recent log that is AT LEAST 7 days old
      const logsBefore7d = playerLogs.filter(
        (log) => new Date(log.recorded_at) <= sevenDaysAgo
      );
      // Use the most recent log that is at least 7 days old, or fall back to oldest log for new members
      const baseline7d = logsBefore7d.length > 0 
        ? logsBefore7d[logsBefore7d.length - 1]  // Most recent log that is ≥7d old
        : oldestLog;  // For new members: use oldest available log

      // Calculate 24h gain
      const trophies24h = baseline24h
        ? member.trophies - baseline24h.trophies
        : null;

      // Calculate 7-day gain
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
