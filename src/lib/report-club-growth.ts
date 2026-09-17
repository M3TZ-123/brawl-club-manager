import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildClubTrophyChange, type ClubTrophyChange } from "@/lib/club-trophy-change";

const HISTORY_TIMEOUT_MS = 2_000;
const DAY_MS = 86_400_000;

/** Optional, bounded history: a failed read must not hide the rest of the report. */
export async function fetchReportClubGrowth(clubTag: string, period: { start: Date; end: Date }): Promise<ClubTrophyChange | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const start = period.start.getTime(), end = period.end.getTime();
    if (!/^#[A-Z0-9]{2,20}$/.test(clubTag) || !Number.isFinite(start) || !Number.isFinite(end)
      || end < start || end - start > 90 * DAY_MS) return null;
    const query = supabaseAdmin.from("club_roster_snapshots")
      .select("first_observed_at,last_observed_at,first_members,last_members,snapshot_day")
      .eq("club_tag", clubTag)
      .gte("snapshot_day", new Date(start - 2 * DAY_MS).toISOString().slice(0, 10))
      .lte("snapshot_day", period.end.toISOString().slice(0, 10))
      .order("snapshot_day", { ascending: true })
      .limit(93)
      .abortSignal(controller.signal);
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, HISTORY_TIMEOUT_MS);
    });
    const result = await Promise.race([query, timeout]);
    if (!result || result.error) return null;
    return buildClubTrophyChange(result.data, period.start, period.end);
  } catch {
    // Neither database errors nor raw roster fields are part of the public response.
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
