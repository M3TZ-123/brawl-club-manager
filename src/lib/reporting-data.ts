import { supabaseAdmin } from "@/lib/supabase-admin";
import type { DailyBattleStatsRow } from "@/lib/battle-tracking-stats";

// At most365 UTC dates for the retained-history view; a normal range is at most90.
export async function fetchDailyStats(playerTags: string[], startDate: string, endDate: string): Promise<DailyBattleStatsRow[]> {
  if (!playerTags.length) return [];
  const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000;
  if (!Number.isFinite(days) || days < 0 || days > 365 || playerTags.length > 100) throw new Error("Invalid reporting range");
  const rows: DailyBattleStatsRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("daily_stats")
      .select("player_tag,date,battles,wins,losses,star_player,trophies_gained,trophies_lost")
      .in("player_tag", playerTags).gte("date", startDate).lte("date", endDate)
      .order("date", { ascending: true }).order("player_tag", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

export type TrophyTrendPoint = { date: string; trophies: number | null; observedMembers: number; totalMembers: number };

export async function fetchAccountTrophyTrend(playerTags: string[], days: number, now: Date): Promise<TrophyTrendPoint[]> {
  const { data, error } = await supabaseAdmin.rpc("report_account_trophy_trend", {
    p_player_tags: playerTags, p_days: days, p_now: now.toISOString(),
  });
  if (error) throw error;
  return ((data || []) as Array<{ date: string; trophies: number | null; observed_members: number; total_members: number }>).map(row => ({
    date: row.date,
    trophies: row.trophies,
    observedMembers: row.observed_members,
    totalMembers: row.total_members,
  }));
}
