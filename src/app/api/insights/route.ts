import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Parallel data fetches
    const [membersRes, historyRes, trackingRes, dailyStatsRes, battlesRes] = await Promise.all([
      supabase.from("members").select("player_tag, trophies, is_active"),
      supabase.from("member_history").select("player_tag, first_seen, times_joined, times_left, is_current_member"),
      supabase.from("player_tracking").select("player_tag, total_battles, total_wins, active_days, current_streak"),
      supabase.from("daily_stats").select("player_tag, date, battles, wins").gte("date", sevenDaysAgo.toISOString().split("T")[0]),
      supabase.from("battle_history").select("battle_time").gte("battle_time", sevenDaysAgo.toISOString()).order("battle_time", { ascending: true }),
    ]);

    const members = membersRes.data || [];
    const history = historyRes.data || [];
    const tracking = trackingRes.data || [];
    const dailyStats = dailyStatsRes.data || [];
    const battles = battlesRes.data || [];

    const currentMembers = history.filter((h) => h.is_current_member);
    const totalMembers = currentMembers.length || members.length;

    // --- Member Retention Rate ---
    // Members who joined in last 30 days and are still in the club
    const recentJoins = history.filter(
      (h) => new Date(h.first_seen) >= thirtyDaysAgo
    );
    const retained = recentJoins.filter((h) => h.is_current_member);
    const retentionRate = recentJoins.length > 0
      ? Math.round((retained.length / recentJoins.length) * 100)
      : 100; // If no new joins, 100% retention

    // Total leaves ever
    const totalLeaves = history.reduce((sum, h) => sum + (h.times_left || 0), 0);

    // --- Average Battles Per Member (weekly) ---
    const weeklyBattlesByPlayer = new Map<string, number>();
    for (const ds of dailyStats) {
      weeklyBattlesByPlayer.set(
        ds.player_tag,
        (weeklyBattlesByPlayer.get(ds.player_tag) || 0) + (ds.battles || 0)
      );
    }
    const playersWithBattles = weeklyBattlesByPlayer.size;
    const totalWeeklyBattles = [...weeklyBattlesByPlayer.values()].reduce((a, b) => a + b, 0);
    const avgBattlesPerMember = totalMembers > 0
      ? Math.round(totalWeeklyBattles / totalMembers)
      : 0;

    // --- Peak Activity Hours ---
    const hourCounts = new Array(24).fill(0);
    for (const b of battles) {
      const hour = new Date(b.battle_time).getUTCHours();
      hourCounts[hour]++;
    }
    const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
    const peakHourLabel = battles.length > 0
      ? `${peakHour.toString().padStart(2, "0")}:00 UTC`
      : null;

    // --- Weekly Activity Rate ---
    const weeklyActivePlayers = playersWithBattles;
    const weeklyActivityRate = totalMembers > 0
      ? Math.round((weeklyActivePlayers / totalMembers) * 100)
      : 0;

    // --- Club Health Score (0-100) ---
    // Composite of: activity rate (40%), retention (30%), avg battles (30%)
    const activityScore = Math.min(weeklyActivityRate, 100);
    const retentionScore = Math.min(retentionRate, 100);
    // Normalize battles: 20+ per member per week = perfect
    const battleScore = Math.min(Math.round((avgBattlesPerMember / 20) * 100), 100);

    const healthScore = Math.round(
      activityScore * 0.4 + retentionScore * 0.3 + battleScore * 0.3
    );

    // Health label
    let healthLabel: string;
    if (healthScore >= 80) healthLabel = "Excellent";
    else if (healthScore >= 60) healthLabel = "Good";
    else if (healthScore >= 40) healthLabel = "Fair";
    else healthLabel = "Needs Attention";

    return NextResponse.json({
      insights: {
        retentionRate,
        recentJoins: recentJoins.length,
        totalLeaves,
        avgBattlesPerMember,
        totalWeeklyBattles,
        weeklyActivePlayers,
        weeklyActivityRate,
        peakHour: peakHourLabel,
        healthScore,
        healthLabel,
      },
    });
  } catch (error) {
    console.error("Error fetching club insights:", error);
    return NextResponse.json({ error: "Failed to fetch insights" }, { status: 500 });
  }
}
