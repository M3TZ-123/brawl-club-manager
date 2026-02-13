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
    const [membersRes, thisWeekStatsRes, prevWeekStatsRes, recentBattlesRes] = await Promise.all([
      supabase.from("members").select("player_tag, player_name, trophies, is_active, last_seen"),
      supabase.from("daily_stats").select("player_tag, date, battles, wins, trophies_gained, trophies_lost").gte("date", weekAgoStr),
      supabase.from("daily_stats").select("player_tag, battles").gte("date", prevWeekStr).lt("date", weekAgoStr),
      supabase.from("battle_history").select("player_tag, battle_time").gte("battle_time", fortyEightHoursAgo),
    ]);

    const members = membersRes.data || [];
    // Build name lookup — normalize tags to handle any format differences
    const nameMap = new Map<string, string>();
    for (const m of members) {
      nameMap.set(m.player_tag, m.player_name);
      nameMap.set(m.player_tag.replace("#", ""), m.player_name);
      if (!m.player_tag.startsWith("#")) nameMap.set(`#${m.player_tag}`, m.player_name);
    }
    const thisWeekStats = thisWeekStatsRes.data || [];
    const prevWeekStats = prevWeekStatsRes.data || [];
    const recentBattles = recentBattlesRes.data || [];

    // ============================
    // 1. WIN RATE — Club win percentage this week
    // ============================
    const totalWins = thisWeekStats.reduce((sum, s) => sum + (s.wins || 0), 0);
    const totalBattlesThisWeek = thisWeekStats.reduce((sum, s) => sum + (s.battles || 0), 0);
    const winRate = totalBattlesThisWeek > 0
      ? Math.round((totalWins / totalBattlesThisWeek) * 100)
      : 0;

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

    // Try all possible tag formats for name lookup
    let mvpName: string | null = null;
    if (mvpTag) {
      mvpName = nameMap.get(mvpTag)
        || nameMap.get(mvpTag.replace("#", ""))
        || nameMap.get(`#${mvpTag}`)
        || null;
      
      // If still not found, query directly
      if (!mvpName) {
        const { data: mvpMember } = await supabase
          .from("members")
          .select("player_name")
          .or(`player_tag.eq.${mvpTag},player_tag.eq.#${mvpTag},player_tag.eq.${mvpTag.replace("#", "")}`)
          .limit(1)
          .single();
        mvpName = mvpMember?.player_name || mvpTag;
      }
    }

    return NextResponse.json({
      insights: {
        // Win Rate
        winRate,
        totalWins,
        totalBattlesThisWeek,
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
