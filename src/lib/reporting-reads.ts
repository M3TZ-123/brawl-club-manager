import { supabaseAdmin } from "@/lib/supabase-admin";
import { classifyActivity, normalizeInactivityThreshold } from "@/lib/activity-status";
import { publicMemberSnapshot } from "@/lib/sync-public-snapshots";
import type { Member } from "@/types/database";
import type { MemberActivityMetrics } from "@/lib/member-activity-metrics";

type MemberRead = Member & Omit<MemberActivityMetrics, "activity_status"> & { last_activity_at: string | null };
type RecentEvent = { id: number; event_type: string; player_tag: string; player_name: string; event_time: string };
type ReadResult = { members: MemberRead[]; inactivityThreshold: string | null; lastSyncTime: string | null };
type DashboardRead = ReadResult & {
  recentEvents: RecentEvent[];
  changeCounts: { joins: number; leaves: number; nameChanges: number; roleChanges: number };
};
type LeaderboardReadMember = Pick<MemberRead, "player_tag" | "player_name" | "role" | "trophies" | "highest_trophies" | "brawlers_count" | "last_battle_at" | "last_activity_at"> & {
  trophyChange: number | null;
  battles: number; wins: number; losses: number; starPlayer: number; activeDays: number;
};
type LeaderboardRead = Omit<ReadResult, "members"> & { members: LeaderboardReadMember[] };

const periods = ["24h", "3d", "7d", "30d", "90d"] as const;

export function normalizeReportTimestamp(value: string | null | undefined) {
  const timestamp = value?.trim();
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toISOString();
}

async function read<T extends { members: unknown[] }>(name: string, days: number, now: Date): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(name, { p_days: days, p_now: now.toISOString() });
  if (error) throw error;
  if (!data || !Array.isArray(data.members)) throw new Error("Invalid reporting response");
  return data as T;
}

export async function readDashboard(days: number, now: Date) {
  const data = await read<DashboardRead>("report_dashboard_read", days, now);
  const threshold = normalizeInactivityThreshold(data.inactivityThreshold);
  const members: Array<Member & MemberActivityMetrics> = data.members.map(row => ({
    // Keep a public projection at both boundaries: SQL and the HTTP response.
    ...publicMemberSnapshot(row) as Member,
    trophies_24h: row.trophies_24h ?? null,
    trophies_3d: row.trophies_3d ?? null,
    trophies_7d: row.trophies_7d ?? null,
    trophies_30d: row.trophies_30d ?? null,
    trophies_90d: row.trophies_90d ?? null,
    trophy_baselines: Object.fromEntries(periods.filter(key => row.trophy_baselines && Object.hasOwn(row.trophy_baselines, key))
      .map(key => [key, row.trophy_baselines[key]])),
    last_battle_at: row.last_battle_at ?? null,
    activity_status: classifyActivity(row.last_activity_at ? new Date(row.last_activity_at) : null, now, threshold),
  }));
  return {
    members,
    lastSyncTime: normalizeReportTimestamp(data.lastSyncTime),
    changeCounts: {
      joins: data.changeCounts.joins, leaves: data.changeCounts.leaves,
      nameChanges: data.changeCounts.nameChanges, roleChanges: data.changeCounts.roleChanges,
    },
    recentEvents: data.recentEvents.map(({ id, event_type, player_tag, player_name, event_time }) => ({
      id, event_type, player_tag, player_name, event_time,
    })),
  };
}

export async function readLeaderboard(days: number, now: Date) {
  const data = await read<LeaderboardRead>("report_leaderboard_read", days, now);
  const threshold = normalizeInactivityThreshold(data.inactivityThreshold);
  return {
    lastSyncTime: normalizeReportTimestamp(data.lastSyncTime),
    members: data.members.map(row => ({
      tag: row.player_tag,
      name: row.player_name,
      role: row.role,
      trophies: row.trophies || 0,
      highestTrophies: row.highest_trophies || 0,
      brawlersCount: row.brawlers_count || 0,
      activityStatus: classifyActivity(row.last_activity_at ? new Date(row.last_activity_at) : null, now, threshold),
      lastBattleAt: row.last_battle_at || null,
      // The legacy property name remains compatible; values use the selected period.
      weekly: {
        battles: row.battles, wins: row.wins, losses: row.losses,
        starPlayer: row.starPlayer, activeDays: row.activeDays,
        winRate: row.battles ? Math.round(row.wins / row.battles * 100) : 0,
        netTrophies: row.trophyChange ?? null,
      },
    })),
  };
}
