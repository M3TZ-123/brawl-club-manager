import { supabaseAdmin } from "@/lib/supabase-admin";
import { classifyActivity, normalizeInactivityThreshold } from "@/lib/activity-status";

export type MemberActivityMetrics = {
  trophies_24h: number | null;
  trophies_3d: number | null;
  trophies_7d: number | null;
  activity_status: "active" | "minimal" | "inactive";
  last_battle_at: string | null;
};

type ActivitySummary = Omit<MemberActivityMetrics, "activity_status"> & {
  player_tag: string;
  last_activity_at: string | null;
};

export async function appendMemberActivityMetrics<T extends { player_tag: string; trophies: number }>(
  members: T[],
  now = new Date()
): Promise<Array<T & MemberActivityMetrics>> {
  if (members.length === 0) return [];
  const [summary, settings] = await Promise.all([
    supabaseAdmin.rpc("sync_activity_summary", {
      p_player_tags: [...new Set(members.map(member => member.player_tag))],
      p_now: now.toISOString(),
    }),
    supabaseAdmin.from("settings").select("value").eq("key", "inactivity_threshold").maybeSingle(),
  ]);
  if (summary.error) throw summary.error;
  if (settings.error) throw settings.error;
  const threshold = normalizeInactivityThreshold(settings.data?.value);
  const byTag = new Map((summary.data as ActivitySummary[] | null ?? []).map(row => [row.player_tag, row]));
  return members.map(member => {
    const row = byTag.get(member.player_tag);
    return {
      ...member,
      trophies_24h: row?.trophies_24h ?? null,
      trophies_3d: row?.trophies_3d ?? null,
      trophies_7d: row?.trophies_7d ?? null,
      last_battle_at: row?.last_battle_at ?? null,
      activity_status: classifyActivity(row?.last_activity_at ? new Date(row.last_activity_at) : null, now, threshold),
    };
  });
}
