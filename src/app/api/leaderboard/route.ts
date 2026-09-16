import { NextRequest, NextResponse } from "next/server";
import { readLeaderboard } from "@/lib/reporting-reads";
import { parseTimeRange, TIME_RANGES } from "@/lib/time-range";
import { getReportingPeriod, reportingPeriodMetadata } from "@/lib/reporting-period";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MIN_WIN_RATE_BATTLES = { "24h": 3, "3d": 5, "7d": 10, "30d": 20, "90d": 30 } as const;

export async function GET(request: NextRequest) {
  try {
    const now = new Date();
    const rangeKey = parseTimeRange(request.nextUrl.searchParams.get("range"));
    const period = getReportingPeriod(rangeKey, now);
    const minWinRateBattles = MIN_WIN_RATE_BATTLES[rangeKey];
    const snapshot = await readLeaderboard(period.days, now);
    const enriched = snapshot.members;

    const leaderboards = {
      trophyLeaders: [...enriched].sort((a, b) => b.trophies - a.trophies).slice(0, 30),
      weeklyBattlers: [...enriched]
        .filter((m) => m.weekly.battles > 0)
        .sort((a, b) => b.weekly.battles - a.weekly.battles)
        .slice(0, 30),
      weeklyWinRate: [...enriched]
        .filter((m) => m.weekly.battles >= minWinRateBattles)
        .sort((a, b) => b.weekly.winRate - a.weekly.winRate)
        .slice(0, 30),
      weeklyTrophyGainers: [...enriched]
        .filter((m) => m.weekly.netTrophies != null && m.weekly.netTrophies !== 0)
        .sort((a, b) => (b.weekly.netTrophies || 0) - (a.weekly.netTrophies || 0))
        .slice(0, 30),
      weeklyStarPlayers: [...enriched]
        .filter((m) => m.weekly.starPlayer > 0)
        .sort((a, b) => b.weekly.starPlayer - a.weekly.starPlayer)
        .slice(0, 30),
      mostActive: [...enriched]
        .filter((m) => m.weekly.activeDays > 0)
        .sort((a, b) => b.weekly.activeDays - a.weekly.activeDays || b.weekly.battles - a.weekly.battles)
        .slice(0, 30),
    };

    return NextResponse.json({
      leaderboards,
      memberCount: enriched.length,
      period: reportingPeriodMetadata(period),
      range: {
        key: rangeKey,
        label: TIME_RANGES[rangeKey].label,
        minWinRateBattles: minWinRateBattles,
      },
      generatedAt: now.toISOString(),
      lastSyncTime: snapshot.lastSyncTime,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Error fetching leaderboard:", error instanceof Error ? error.name : "database_error");
    return NextResponse.json({ error: "Failed to fetch leaderboard" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
