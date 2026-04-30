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
  first_seen?: string | null;
  last_left_at?: string | null;
  last_seen?: string | null;
  is_current_member?: boolean | null;
};

async function fetchAllMemberHistory(cutoffDate: Date | null): Promise<MemberHistoryRow[]> {
  const pageSize = 1000;
  const rows: MemberHistoryRow[] = [];

  for (let from = 0; ; from += pageSize) {
    let query = supabaseAdmin
      .from("member_history")
      .select("player_tag, player_name, first_seen, last_seen, last_left_at, times_joined, times_left, is_current_member, role_at_leave, trophies_at_leave, notes")
      .order("last_seen", { ascending: false })
      .order("player_tag", { ascending: true })
      .range(from, from + pageSize - 1);

    if (cutoffDate) {
      const cutoffISO = cutoffDate.toISOString();
      query = query.or(`first_seen.gte.${cutoffISO},last_left_at.gte.${cutoffISO},last_seen.gte.${cutoffISO}`);
    }

    const { data, error } = await query;

    if (error) throw error;
    rows.push(...((data || []) as MemberHistoryRow[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
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

    const history = await fetchAllMemberHistory(cutoffDate);

    let filteredHistory = history;

    if (cutoffDate) {
      filteredHistory = filteredHistory.filter((record) => {
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
