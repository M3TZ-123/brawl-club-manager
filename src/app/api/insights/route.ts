import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { appendMemberActivityMetrics } from "@/lib/member-activity-metrics";
import { getReportingPeriod, reportingPeriodMetadata } from "@/lib/reporting-period";
import { fetchDailyStats } from "@/lib/reporting-data";
import { parseTimeRange, TIME_RANGES } from "@/lib/time-range";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type BattleSummary = {
  battle_time: string;
  mode: string | null;
  result: string | null;
};

async function fetchMegaBossBattleSummaries(playerTags: string[], sinceDate: string, untilDate: string): Promise<BattleSummary[]> {
  if (playerTags.length === 0) return [];

  const pageSize = 1000;
  const rows: BattleSummary[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("battle_history")
      .select("battle_time, mode, result")
      .in("player_tag", playerTags)
      .gte("battle_time", sinceDate)
      .lte("battle_time", untilDate)
      .eq("mode", "megaBoss")
      .order("battle_time", { ascending: true })
      .order("player_tag", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows.push(...((data || []) as BattleSummary[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

export async function GET(request?: Request) {
  try {
    const now = new Date();
    const range = parseTimeRange(request ? new URL(request.url).searchParams.get("range") : null);
    const period = getReportingPeriod(range, now);
    const metric = TIME_RANGES[range].metric;
    const weekStartStr = period.dates[0];
    const previousWeekStartStr = period.previousStart.toISOString().slice(0, 10);
    const currentMembersRes = await supabaseAdmin.from("member_history")
      .select("player_tag").eq("is_current_member", true);
    if (currentMembersRes.error) throw currentMembersRes.error;
    const currentTags = new Set<string>((currentMembersRes.data || []).map(h => h.player_tag));
    const memberFilter = currentTags.size ? [...currentTags] : [""];
    const [membersRes, currentDailyRows, previousDailyRows] = await Promise.all([
      supabaseAdmin.from("members").select("player_tag, player_name, trophies, is_active, last_updated").in("player_tag", memberFilter),
      fetchDailyStats([...currentTags], weekStartStr, period.dates.at(-1)!),
      fetchDailyStats([...currentTags], previousWeekStartStr, new Date(period.start.getTime() - 86_400_000).toISOString().slice(0, 10)),
    ]);
    if (membersRes.error) throw membersRes.error;
    const members = (membersRes.data || []).filter(m => currentTags.has(m.player_tag));
    const rosterTags = new Set(members.map(member => member.player_tag));
    const thisWeekStats = currentDailyRows.filter(row => rosterTags.has(row.player_tag));
    const prevWeekStats = previousDailyRows.filter(row => rosterTags.has(row.player_tag));

    // ============================
    // 0. MEGA BOSS STATUS — derived from exact tracked battle_history mode.
    // ============================
    const megaBossBattles = await fetchMegaBossBattleSummaries(
      members.map((m) => m.player_tag),
      period.start.toISOString(),
      period.end.toISOString()
    );

    const megaBossWins = megaBossBattles.reduce((sum, battle) => {
      return sum + (battle.result === "victory" ? 1 : 0);
    }, 0);

    const megaBossStatus = {
      isTracked: megaBossBattles.length > 0,
      totalWins: megaBossWins,
      totalBattles: megaBossBattles.length,
      rankReached: null as string | null,
      lastBattleAt: megaBossBattles.length > 0
        ? megaBossBattles
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
    // 2. INACTIVE MEMBERS — use the same computed activity status as Members/Dashboard.
    // ============================
    const membersWithActivity = await appendMemberActivityMetrics(members, now);
    const kickCandidates = membersWithActivity
      .filter((member) => member.activity_status === "inactive")
      .map((member) => ({
        tag: member.player_tag,
        name: member.player_name,
        lastActive: member.last_battle_at || null,
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
    // 4. MVP OF THE WEEK — Best net trophy progress this week
    // ============================
    const mvp = membersWithActivity
      .filter(member => member[metric] != null)
      .sort((a, b) => (b[metric] ?? 0) - (a[metric] ?? 0))[0];
    const mvpName = mvp?.player_name ?? null;
    const mvpTrophies = mvp?.[metric] ?? null;

    return NextResponse.json(
      {
        period: reportingPeriodMetadata(period),
        insights: {
          // Mega Boss
          megaBoss: {
            ...megaBossStatus,
            lastBattleAt: megaBossStatus.lastBattleAt
              ? new Date(megaBossStatus.lastBattleAt).toISOString()
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
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error fetching club insights:", error);
    return NextResponse.json(
      { error: "Failed to fetch insights" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
