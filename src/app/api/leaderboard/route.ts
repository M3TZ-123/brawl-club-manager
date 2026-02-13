import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Fetch all data in parallel
    const [membersRes, allDailyStatsRes, currentMembersRes] = await Promise.all([
      supabase.from("members").select("player_tag, player_name, trophies, highest_trophies, role, win_rate, solo_victories, duo_victories, trio_victories, brawlers_count, rank_current, rank_highest, exp_level"),
      supabase.from("daily_stats").select("player_tag, date, battles, wins, losses, star_player, trophies_gained, trophies_lost").limit(5000),
      supabase.from("member_history").select("player_tag").eq("is_current_member", true),
    ]);

    const currentTags = new Set((currentMembersRes.data || []).map((m) => m.player_tag));
    const members = (membersRes.data || []).filter((m) => currentTags.has(m.player_tag));
    const allDailyStats = allDailyStatsRes.data || [];

    const weekAgoStr = sevenDaysAgo.toISOString().split("T")[0];

    // Aggregate weekly AND all-time stats from daily_stats
    const weeklyMap = new Map<string, { battles: number; wins: number; losses: number; starPlayer: number; trophiesGained: number; trophiesLost: number; activeDays: number }>();
    const allTimeMap = new Map<string, { battles: number; wins: number; losses: number; starPlayer: number; trophiesGained: number; trophiesLost: number; activeDays: number; dates: Set<string> }>();

    for (const ds of allDailyStats) {
      // All-time aggregation
      const at = allTimeMap.get(ds.player_tag) || { battles: 0, wins: 0, losses: 0, starPlayer: 0, trophiesGained: 0, trophiesLost: 0, activeDays: 0, dates: new Set<string>() };
      at.battles += ds.battles || 0;
      at.wins += ds.wins || 0;
      at.losses += ds.losses || 0;
      at.starPlayer += ds.star_player || 0;
      at.trophiesGained += ds.trophies_gained || 0;
      at.trophiesLost += ds.trophies_lost || 0;
      if ((ds.battles || 0) > 0) at.dates.add(ds.date);
      allTimeMap.set(ds.player_tag, at);

      // Weekly aggregation (only last 7 days)
      if (ds.date >= weekAgoStr) {
        const existing = weeklyMap.get(ds.player_tag) || { battles: 0, wins: 0, losses: 0, starPlayer: 0, trophiesGained: 0, trophiesLost: 0, activeDays: 0 };
        existing.battles += ds.battles || 0;
        existing.wins += ds.wins || 0;
        existing.losses += ds.losses || 0;
        existing.starPlayer += ds.star_player || 0;
        existing.trophiesGained += ds.trophies_gained || 0;
        existing.trophiesLost += ds.trophies_lost || 0;
        if ((ds.battles || 0) > 0) existing.activeDays += 1;
        weeklyMap.set(ds.player_tag, existing);
      }
    }

    // Compute streaks from daily data per player
    const streakMap = new Map<string, { currentStreak: number; bestStreak: number; peakDayBattles: number }>();
    const playerDates = new Map<string, { date: string; battles: number }[]>();
    for (const ds of allDailyStats) {
      if ((ds.battles || 0) > 0) {
        if (!playerDates.has(ds.player_tag)) playerDates.set(ds.player_tag, []);
        playerDates.get(ds.player_tag)!.push({ date: ds.date, battles: ds.battles || 0 });
      }
    }
    const todayStr = now.toISOString().split("T")[0];
    for (const [tag, dates] of playerDates) {
      dates.sort((a, b) => a.date.localeCompare(b.date));
      let currentStreak = 0;
      let bestStreak = 0;
      let streak = 1;
      let peakDayBattles = 0;
      for (let i = 0; i < dates.length; i++) {
        peakDayBattles = Math.max(peakDayBattles, dates[i].battles);
        if (i > 0) {
          const prev = new Date(dates[i - 1].date);
          const curr = new Date(dates[i].date);
          const diffDays = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);
          if (diffDays === 1) {
            streak++;
          } else {
            bestStreak = Math.max(bestStreak, streak);
            streak = 1;
          }
        }
      }
      bestStreak = Math.max(bestStreak, streak);
      // Current streak: check if last active date is today or yesterday
      const lastDate = dates[dates.length - 1].date;
      const lastDateObj = new Date(lastDate);
      const diffFromToday = (new Date(todayStr).getTime() - lastDateObj.getTime()) / (1000 * 60 * 60 * 24);
      currentStreak = diffFromToday <= 1 ? streak : 0;
      streakMap.set(tag, { currentStreak, bestStreak, peakDayBattles });
    }

    // Build enriched member data
    const enriched = members.map((m) => {
      const at = allTimeMap.get(m.player_tag);
      const streaks = streakMap.get(m.player_tag);
      const w = weeklyMap.get(m.player_tag);
      const totalVictories = (m.solo_victories || 0) + (m.duo_victories || 0) + (m.trio_victories || 0);
      return {
        tag: m.player_tag,
        name: m.player_name,
        role: m.role,
        trophies: m.trophies || 0,
        highestTrophies: m.highest_trophies || 0,
        winRate: m.win_rate ?? null,
        totalVictories,
        brawlersCount: m.brawlers_count || 0,
        expLevel: m.exp_level || 1,
        rankCurrent: m.rank_current,
        rankHighest: m.rank_highest,
        // All-time from daily_stats aggregation
        allTime: {
          battles: at?.battles || 0,
          wins: at?.wins || 0,
          losses: at?.losses || 0,
          starPlayer: at?.starPlayer || 0,
          trophiesGained: at?.trophiesGained || 0,
          trophiesLost: at?.trophiesLost || 0,
          activeDays: at?.dates.size || 0,
          currentStreak: streaks?.currentStreak || 0,
          bestStreak: streaks?.bestStreak || 0,
          peakDayBattles: streaks?.peakDayBattles || 0,
        },
        // Weekly from daily_stats
        weekly: {
          battles: w?.battles || 0,
          wins: w?.wins || 0,
          losses: w?.losses || 0,
          starPlayer: w?.starPlayer || 0,
          trophiesGained: w?.trophiesGained || 0,
          trophiesLost: w?.trophiesLost || 0,
          activeDays: w?.activeDays || 0,
          winRate: w && w.battles > 0 ? Math.round((w.wins / w.battles) * 100) : 0,
          netTrophies: (w?.trophiesGained || 0) - (w?.trophiesLost || 0),
        },
      };
    });

    // Build leaderboard categories
    const leaderboards = {
      // Trophy Leaders (current)
      trophyLeaders: [...enriched].sort((a, b) => b.trophies - a.trophies).slice(0, 30),

      // Most Battles This Week
      weeklyBattlers: [...enriched]
        .filter((m) => m.weekly.battles > 0)
        .sort((a, b) => b.weekly.battles - a.weekly.battles)
        .slice(0, 30),

      // Best Win Rate This Week (min 10 battles)
      weeklyWinRate: [...enriched]
        .filter((m) => m.weekly.battles >= 10)
        .sort((a, b) => b.weekly.winRate - a.weekly.winRate)
        .slice(0, 30),

      // Most Trophies Gained This Week
      weeklyTrophyGainers: [...enriched]
        .filter((m) => m.weekly.netTrophies !== 0)
        .sort((a, b) => b.weekly.netTrophies - a.weekly.netTrophies)
        .slice(0, 30),

      // Star Players This Week
      weeklyStarPlayers: [...enriched]
        .filter((m) => m.weekly.starPlayer > 0)
        .sort((a, b) => b.weekly.starPlayer - a.weekly.starPlayer)
        .slice(0, 30),

      // Most Active (all-time tracked days)
      mostActive: [...enriched]
        .filter((m) => m.allTime.activeDays > 0)
        .sort((a, b) => b.allTime.activeDays - a.allTime.activeDays || b.allTime.currentStreak - a.allTime.currentStreak)
        .slice(0, 30),

      // All-time battle stats
      allTimeBattlers: [...enriched]
        .filter((m) => m.allTime.battles > 0)
        .sort((a, b) => b.allTime.battles - a.allTime.battles)
        .slice(0, 30),
    };

    return NextResponse.json({ leaderboards, memberCount: enriched.length });
  } catch (error) {
    console.error("Error fetching leaderboard:", error);
    return NextResponse.json({ error: "Failed to fetch leaderboard" }, { status: 500 });
  }
}
