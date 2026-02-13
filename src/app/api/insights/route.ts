import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const prevWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const todayStr = now.toISOString().split("T")[0];
    const weekAgoStr = sevenDaysAgo.toISOString().split("T")[0];
    const prevWeekStr = prevWeekStart.toISOString().split("T")[0];
    const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    // Parallel data fetches
    const [membersRes, thisWeekStatsRes, prevWeekStatsRes, recentBattlesRes, eventBattlesRes] = await Promise.all([
      supabase.from("members").select("player_tag, player_name, trophies, is_active, last_seen"),
      supabase.from("daily_stats").select("player_tag, date, battles, wins, trophies_gained, trophies_lost").gte("date", weekAgoStr),
      supabase.from("daily_stats").select("player_tag, battles").gte("date", prevWeekStr).lt("date", weekAgoStr),
      supabase.from("battle_history").select("player_tag, battle_time").gte("battle_time", fortyEightHoursAgo),
      supabase.from("battle_history").select("mode, battle_time").gte("battle_time", sevenDaysAgo.toISOString()).not("mode", "is", null),
    ]);

    const members = membersRes.data || [];
    const thisWeekStats = thisWeekStatsRes.data || [];
    const prevWeekStats = prevWeekStatsRes.data || [];
    const recentBattles = recentBattlesRes.data || [];
    const eventBattles = eventBattlesRes.data || [];

    // ============================
    // 1. EVENT STATUS — Club League / ranked modes activity
    // ============================
    const rankedModes = ["clubLeague", "soloRanked", "teamRanked", "duels", "ranked"];
    const eventModeBattles = eventBattles.filter((b) =>
      rankedModes.some((rm) => (b.mode || "").toLowerCase().includes(rm.toLowerCase()))
    );
    const totalEventBattles = eventModeBattles.length;
    const eventPlayers = new Set(eventModeBattles.map((b) => b.mode)).size; // unique modes played
    const totalBattlesThisWeek = eventBattles.length;
    const eventRate = totalBattlesThisWeek > 0
      ? Math.round((totalEventBattles / totalBattlesThisWeek) * 100)
      : 0;

    let eventLabel: string;
    let eventStatus: "good" | "warning" | "bad";
    if (totalEventBattles > 0) {
      eventLabel = `${totalEventBattles} competitive`;
      eventStatus = totalEventBattles >= 20 ? "good" : "warning";
    } else {
      eventLabel = "No ranked games";
      eventStatus = "bad";
    }

    // ============================
    // 2. KICK LIST — Members with 0 battles in last 48h
    // ============================
    const recentActiveTags = new Set(recentBattles.map((b) => b.player_tag));
    const kickCandidates = members
      .filter((m) => !recentActiveTags.has(m.player_tag))
      .map((m) => ({ tag: m.player_tag, name: m.player_name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // ============================
    // 3. ACTIVITY TREND — This week vs last week total battles
    // ============================
    const thisWeekTotal = thisWeekStats.reduce((sum, s) => sum + (s.battles || 0), 0);
    const prevWeekTotal = prevWeekStats.reduce((sum, s) => sum + (s.battles || 0), 0);
    const trendDiff = prevWeekTotal > 0
      ? Math.round(((thisWeekTotal - prevWeekTotal) / prevWeekTotal) * 100)
      : thisWeekTotal > 0 ? 100 : 0;
    const trendDirection: "up" | "down" | "flat" = trendDiff > 5 ? "up" : trendDiff < -5 ? "down" : "flat";

    // ============================
    // 4. MVP OF THE WEEK — Most trophies gained this week
    // ============================
    const trophyGainByPlayer = new Map<string, number>();
    for (const s of thisWeekStats) {
      trophyGainByPlayer.set(
        s.player_tag,
        (trophyGainByPlayer.get(s.player_tag) || 0) + (s.trophies_gained || 0)
      );
    }

    let mvpTag = "";
    let mvpTrophies = 0;
    for (const [tag, trophies] of trophyGainByPlayer) {
      if (trophies > mvpTrophies) {
        mvpTag = tag;
        mvpTrophies = trophies;
      }
    }

    const mvpMember = members.find((m) => m.player_tag === mvpTag);
    const mvpName = mvpMember?.player_name || mvpTag || null;

    return NextResponse.json({
      insights: {
        // Event Status
        eventLabel,
        eventStatus,
        totalEventBattles,
        eventRate,
        // Kick List
        kickList: kickCandidates,
        kickCount: kickCandidates.length,
        // Activity Trend
        thisWeekTotal,
        prevWeekTotal,
        trendDiff,
        trendDirection,
        // MVP
        mvpName,
        mvpTrophies,
      },
    });
  } catch (error) {
    console.error("Error fetching club insights:", error);
    return NextResponse.json({ error: "Failed to fetch insights" }, { status: 500 });
  }
}
