import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const prevWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const weekAgoStr = sevenDaysAgo.toISOString().split("T")[0];
    const prevWeekStr = prevWeekStart.toISOString().split("T")[0];
    // Parallel data fetches
    const [currentMembersRes, membersRes, thisWeekStatsRes, prevWeekStatsRes] = await Promise.all([
      supabase.from("member_history").select("player_tag").eq("is_current_member", true),
      supabase.from("members").select("player_tag, player_name, trophies, is_active, last_updated"),
      supabase.from("daily_stats").select("player_tag, date, battles, wins, trophies_gained, trophies_lost").gte("date", weekAgoStr),
      supabase.from("daily_stats").select("player_tag, battles").gte("date", prevWeekStr).lt("date", weekAgoStr),
    ]);

    const currentTags = new Set((currentMembersRes.data || []).map(h => h.player_tag));
    const members = (membersRes.data || []).filter(m => currentTags.has(m.player_tag));
    // Build name lookup — normalize tags to handle any format differences
    const nameMap = new Map<string, string>();
    for (const m of members) {
      nameMap.set(m.player_tag, m.player_name);
      nameMap.set(m.player_tag.replace("#", ""), m.player_name);
      if (!m.player_tag.startsWith("#")) nameMap.set(`#${m.player_tag}`, m.player_name);
    }
    const thisWeekStats = thisWeekStatsRes.data || [];
    const prevWeekStats = prevWeekStatsRes.data || [];

    // ============================
    // 0. MEGA PIG STATUS — derived from tracked battle_history
    // Note: Official API does not currently expose a direct club Mega Pig rank field.
    // ============================
    const { data: recentBattles } = await supabase
      .from("battle_history")
      .select("battle_time, mode, result")
      .in("player_tag", members.map((m) => m.player_tag))
      .gte("battle_time", weekAgoStr);

    const megaPigBattles = (recentBattles || []).filter((battle) => {
      const mode = (battle.mode || "").toLowerCase();
      return mode.includes("mega") || mode.includes("pig");
    });

    const megaPigWins = megaPigBattles.reduce((sum, battle) => {
      return sum + (battle.result === "victory" ? 1 : 0);
    }, 0);

    const megaPigStatus = {
      isTracked: megaPigBattles.length > 0,
      totalWins: megaPigWins,
      totalBattles: megaPigBattles.length,
      rankReached: null as string | null,
      lastBattleAt: megaPigBattles.length > 0
        ? megaPigBattles
            .map((battle) => new Date(battle.battle_time).getTime())
            .sort((a, b) => b - a)[0]
        : null,
    };

    // ============================
    // 1. WIN RATE — Club win percentage this week
    // ============================
    const totalWins = thisWeekStats.reduce((sum, s) => sum + (s.wins || 0), 0);
    const totalBattlesThisWeek = thisWeekStats.reduce((sum, s) => sum + (s.battles || 0), 0);
    const winRate = totalBattlesThisWeek > 0
      ? Math.round((totalWins / totalBattlesThisWeek) * 100)
      : 0;

    // ============================
    // 2. KICK LIST — Inactive members (is_active = false, consistent with Active Players stat)
    // ============================
    const inactiveTags = members.filter((m) => !m.is_active).map((m) => m.player_tag);

    // Get last battle date from daily_stats (actual activity, not sync timestamp)
    const lastBattleDateMap = new Map<string, string>();
    if (inactiveTags.length > 0) {
      const { data: lastBattles } = await supabase
        .from("daily_stats")
        .select("player_tag, date")
        .in("player_tag", inactiveTags)
        .gt("battles", 0)
        .order("date", { ascending: false });

      for (const row of lastBattles || []) {
        if (!lastBattleDateMap.has(row.player_tag)) {
          lastBattleDateMap.set(row.player_tag, row.date);
        }
      }
    }

    const kickCandidates = members
      .filter((m) => !m.is_active)
      .map((m) => ({
        tag: m.player_tag,
        name: m.player_name,
        lastActive: lastBattleDateMap.get(m.player_tag) || null,
      }))
      .sort((a, b) => {
        // Sort by longest inactive first (null = never played = first)
        const aTime = a.lastActive ? new Date(a.lastActive).getTime() : 0;
        const bTime = b.lastActive ? new Date(b.lastActive).getTime() : 0;
        return aTime - bTime;
      });

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
        // Mega Pig
        megaPig: {
          ...megaPigStatus,
          lastBattleAt: megaPigStatus.lastBattleAt
            ? new Date(megaPigStatus.lastBattleAt).toISOString()
            : null,
        },
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
