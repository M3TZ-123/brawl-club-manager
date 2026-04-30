import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { appendMemberActivityMetrics } from "@/lib/member-activity-metrics";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type BattleSummary = {
  battle_time: string;
  mode: string | null;
  result: string | null;
};

async function fetchMegaBossBattleSummaries(playerTags: string[], sinceDate: string): Promise<BattleSummary[]> {
  if (playerTags.length === 0) return [];

  const pageSize = 1000;
  const rows: BattleSummary[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("battle_history")
      .select("battle_time, mode, result")
      .in("player_tag", playerTags)
      .gte("battle_time", sinceDate)
      .eq("mode", "megaBoss")
      .order("battle_time", { ascending: true })
      .order("player_tag", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows.push(...((data || []) as BattleSummary[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

export async function GET() {
  try {
    const now = new Date();
    const weekStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 6
    ));
    const previousWeekStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 13
    ));
    const weekStartStr = weekStart.toISOString().slice(0, 10);
    const previousWeekStartStr = previousWeekStart.toISOString().slice(0, 10);
    // Parallel data fetches
    const [currentMembersRes, membersRes, thisWeekStatsRes, prevWeekStatsRes] = await Promise.all([
      supabaseAdmin.from("member_history").select("player_tag").eq("is_current_member", true),
      supabaseAdmin.from("members").select("player_tag, player_name, trophies, is_active, last_updated"),
      supabaseAdmin.from("daily_stats").select("player_tag, date, battles, wins, trophies_gained, trophies_lost").gte("date", weekStartStr),
      supabaseAdmin.from("daily_stats").select("player_tag, battles").gte("date", previousWeekStartStr).lt("date", weekStartStr),
    ]);

    if (currentMembersRes.error) throw currentMembersRes.error;
    if (membersRes.error) throw membersRes.error;
    if (thisWeekStatsRes.error) throw thisWeekStatsRes.error;
    if (prevWeekStatsRes.error) throw prevWeekStatsRes.error;

    const currentTags = new Set((currentMembersRes.data || []).map(h => h.player_tag));
    const members = (membersRes.data || []).filter(m => currentTags.has(m.player_tag));
    // Build name lookup — normalize tags to handle any format differences
    const nameMap = new Map<string, string>();
    for (const m of members) {
      nameMap.set(m.player_tag, m.player_name);
      nameMap.set(m.player_tag.replace("#", ""), m.player_name);
      if (!m.player_tag.startsWith("#")) nameMap.set(`#${m.player_tag}`, m.player_name);
    }
    const thisWeekStats = (thisWeekStatsRes.data || []).filter((s) => currentTags.has(s.player_tag));
    const prevWeekStats = (prevWeekStatsRes.data || []).filter((s) => currentTags.has(s.player_tag));

    // ============================
    // 0. MEGA BOSS STATUS — derived from exact tracked battle_history mode.
    // ============================
    const megaBossBattles = await fetchMegaBossBattleSummaries(
      members.map((m) => m.player_tag),
      weekStartStr
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
    const inactiveTags = membersWithActivity
      .filter((member) => member.activity_status === "inactive")
      .map((member) => member.player_tag);

    // Get last battle date from daily_stats (actual activity, not sync timestamp)
    const lastBattleDateMap = new Map<string, string>();
    if (inactiveTags.length > 0) {
      const { data: lastBattles, error: lastBattlesError } = await supabaseAdmin
        .from("daily_stats")
        .select("player_tag, date")
        .in("player_tag", inactiveTags)
        .gt("battles", 0)
        .order("date", { ascending: false });

      if (lastBattlesError) throw lastBattlesError;

      for (const row of lastBattles || []) {
        if (!lastBattleDateMap.has(row.player_tag)) {
          lastBattleDateMap.set(row.player_tag, row.date);
        }
      }
    }

    const kickCandidates = membersWithActivity
      .filter((member) => member.activity_status === "inactive")
      .map((member) => ({
        tag: member.player_tag,
        name: member.player_name,
        lastActive: member.last_battle_at || lastBattleDateMap.get(member.player_tag) || null,
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
    const netTrophyChangeByPlayer = new Map<string, number>();
    for (const s of thisWeekStats) {
      netTrophyChangeByPlayer.set(
        s.player_tag,
        (netTrophyChangeByPlayer.get(s.player_tag) || 0)
          + (s.trophies_gained || 0)
          - (s.trophies_lost || 0)
      );
    }

    let mvpTag = "";
    let mvpTrophies = Number.NEGATIVE_INFINITY;
    for (const [tag, trophies] of netTrophyChangeByPlayer) {
      if (trophies > mvpTrophies) {
        mvpTag = tag;
        mvpTrophies = trophies;
      }
    }
    if (mvpTrophies === Number.NEGATIVE_INFINITY) {
      mvpTrophies = 0;
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
        const tagCandidates = Array.from(new Set([
          mvpTag,
          mvpTag.replace("#", ""),
          `#${mvpTag.replace("#", "")}`,
        ]));
        const { data: mvpMember, error: mvpLookupError } = await supabaseAdmin
          .from("members")
          .select("player_name")
          .in("player_tag", tagCandidates)
          .limit(1)
          .maybeSingle();
        if (mvpLookupError) throw mvpLookupError;
        mvpName = mvpMember?.player_name || mvpTag;
      }
    }

    return NextResponse.json(
      {
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
