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

      // For 24h: Find the oldest log within the last 24 hours, or the most recent log before that
      const logsLast24h = playerLogs.filter(
        (log) => new Date(log.recorded_at) >= twentyFourHoursAgo
      );
      const logsBefore24h = playerLogs.filter(
        (log) => new Date(log.recorded_at) < twentyFourHoursAgo
      );
      // Use the oldest log from last 24h, or if none, use the most recent log before 24h
      const baseline24h = logsLast24h.length > 0 
        ? logsLast24h[0]  // First (oldest) log in last 24h
        : logsBefore24h.length > 0 
          ? logsBefore24h[logsBefore24h.length - 1]  // Most recent log before 24h
          : null;
      
      // For 7 days: Find the oldest log within the last 7 days, or the most recent log before that
      const logsLast7d = playerLogs.filter(
        (log) => new Date(log.recorded_at) >= sevenDaysAgo
      );
      const logsBefore7d = playerLogs.filter(
        (log) => new Date(log.recorded_at) < sevenDaysAgo
      );
      // Use the oldest log from last 7 days, or if none, use the most recent log before 7 days
      const baseline7d = logsLast7d.length > 0 
        ? logsLast7d[0]  // First (oldest) log in last 7 days
        : logsBefore7d.length > 0 
          ? logsBefore7d[logsBefore7d.length - 1]  // Most recent log before 7 days
          : null;

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
