import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { currentAdministrationClub } from "@/lib/club-administration";

export type MemberReviewHistorySummary = {
  player_tag: string;
  entry_count: number;
  latest_at: string;
};

type DecisionSummaryRow = { id: string; player_tag: string; created_at: string };
const PAGE_SIZE = 1000;
const SUMMARY_COLUMNS = "id,player_tag,created_at";

function summaryRow(value: unknown): DecisionSummaryRow {
  if (!value || typeof value !== "object") throw new Error("Invalid member history summary");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.id)
    || typeof row.player_tag !== "string" || !/^#[A-Z0-9]{1,19}$/.test(row.player_tag)
    || typeof row.created_at !== "string"
    || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.created_at)
    || !Number.isFinite(Date.parse(row.created_at))) throw new Error("Invalid member history summary");
  return { id: row.id, player_tag: row.player_tag, created_at: row.created_at };
}

export async function loadMemberReviewHistorySummaries(): Promise<MemberReviewHistorySummary[]> {
  const club = await currentAdministrationClub();
  const summaries = new Map<string, MemberReviewHistorySummary>();
  const cursors = new Set<string>();
  let cursor: DecisionSummaryRow | null = null;
  while (true) {
    let query = supabaseAdmin.from("member_decision_log").select(SUMMARY_COLUMNS)
      .eq("club_tag", club).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE_SIZE);
    if (cursor) {
      // Preserve database microseconds in the keyset: millisecond rounding can
      // skip entries. Both cursor fields were validated before interpolation.
      query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
    }
    const { data, error } = await query;
    if (error) throw error;
    if (!Array.isArray(data) || data.length > PAGE_SIZE) throw new Error("Incomplete member history summary");
    let tail: DecisionSummaryRow | null = null;
    for (const value of data) {
      const row = summaryRow(value);
      const summary = summaries.get(row.player_tag);
      if (summary) summary.entry_count++;
      else summaries.set(row.player_tag, { player_tag: row.player_tag, entry_count: 1, latest_at: row.created_at });
      tail = row;
    }
    if (data.length < PAGE_SIZE) break;
    if (!tail || cursors.has(tail.id)) throw new Error("Member history pagination did not advance");
    cursors.add(tail.id);
    cursor = tail;
  }
  if (await currentAdministrationClub() !== club) throw new Error("Club changed during member history read");
  // Only summary fields leave the server. Neither private bodies nor event IDs
  // are needed to discover members whose dated history has been saved.
  return [...summaries.values()].sort((left, right) => left.player_tag.localeCompare(right.player_tag));
}
