import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { rejectUnauthorizedAdminMutation } from "@/lib/admin-auth";

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

type MemberHistoryRow = Record<string, unknown> & {
  player_tag: string;
  first_seen?: string | null;
  last_left_at?: string | null;
  last_seen?: string | null;
  is_current_member?: boolean | null;
};

async function fetchAllMemberHistory(): Promise<MemberHistoryRow[]> {
  const pageSize = 1000;
  const rows: MemberHistoryRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const query = supabaseAdmin
      .from("member_history")
      .select("player_tag, player_name, first_seen, last_seen, last_left_at, times_joined, times_left, is_current_member, role_at_leave, trophies_at_leave, notes")
      .order("last_seen", { ascending: false })
      .order("player_tag", { ascending: true })
      .range(from, from + pageSize - 1);

    const { data, error } = await query;

    if (error) throw error;
    rows.push(...((data || []) as MemberHistoryRow[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function fetchRecentMembershipTags(cutoffDate: Date): Promise<Set<string>> {
  const pageSize = 1000;
  const tags = new Set<string>();

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("club_events")
      .select("player_tag")
      .in("event_type", ["join", "leave"])
      .gte("event_time", cutoffDate.toISOString())
      .order("event_time", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    for (const event of data || []) tags.add(event.player_tag);
    if (!data || data.length < pageSize) break;
  }

  return tags;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const daysParam = searchParams.get("days");
    const parsedDays = daysParam && daysParam !== "all" ? Number(daysParam) : null;
    const days = parsedDays != null && Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : null;
    const cutoffDate = days
      ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      : null;

    const [history, recentMembershipTags] = await Promise.all([
      fetchAllMemberHistory(),
      cutoffDate ? fetchRecentMembershipTags(cutoffDate) : Promise.resolve(new Set<string>()),
    ]);

    let filteredHistory = history;

    if (cutoffDate) {
      filteredHistory = filteredHistory.filter((record) => {
        // first_seen remains the original join date when a member returns.
        // Events preserve later joins; snapshots also cover initial/legacy records.
        if (recentMembershipTags.has(record.player_tag)) return true;

        const joinedAt = parseDate(record.first_seen);
        const leftAt = parseDate(record.last_left_at)
          || (!record.is_current_member ? parseDate(record.last_seen) : null);

        const joinedInRange = !!joinedAt && joinedAt >= cutoffDate;
        const leftInRange = !!leftAt && leftAt >= cutoffDate;

        return joinedInRange || leftInRange;
      });
    }

    return NextResponse.json({ history: filteredHistory });
  } catch (error) {
    console.error("Error fetching history:", error);
    return NextResponse.json(
      { error: "Failed to fetch member history" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const authResponse = rejectUnauthorizedAdminMutation(request);
    if (authResponse) return authResponse;

    const body = await request.json().catch(() => ({}));
    const { player_tag, notes } = body;

    if (typeof player_tag !== "string" || player_tag.trim().length === 0) {
      return NextResponse.json(
        { error: "player_tag is required" },
        { status: 400 }
      );
    }

    const sanitizedNotes = typeof notes === "string"
      ? notes.trim().slice(0, 1000)
      : null;

    const { error } = await supabaseAdmin
      .from("member_history")
      .update({ notes: sanitizedNotes || null })
      .eq("player_tag", player_tag.trim());

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating notes:", error);
    return NextResponse.json(
      { error: "Failed to update notes" },
      { status: 500 }
    );
  }
}
