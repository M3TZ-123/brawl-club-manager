import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { rejectUnauthorizedAdminMutation, verifyAdminSession } from "@/lib/admin-auth";
import { loadMemberReviews, ReviewInputError, saveMemberReview } from "@/lib/member-reviews";

export const dynamic = "force-dynamic";
const PUBLIC_HISTORY_COLUMNS = "player_tag, player_name, first_seen, last_seen, last_left_at, times_joined, times_left, is_current_member, role_at_leave, trophies_at_leave";

function historyResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
}

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
      .select(PUBLIC_HISTORY_COLUMNS)
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

    // Whitelist the response too: a future query change must not publish
    // legacy notes or any other private columns through this public route.
    const publicColumns = PUBLIC_HISTORY_COLUMNS.split(", ");
    let result = filteredHistory.map(row => Object.fromEntries(publicColumns.map(column => [column, row[column]])));
    if (verifyAdminSession(request)) {
      const reviews = new Map((await loadMemberReviews()).map(review => [review.player_tag, review]));
      result = result.map(row => {
        const review = reviews.get(String(row.player_tag));
        return { ...row, notes: review?.notes || null, review_status: review?.status || "pending", follow_up_at: review?.follow_up_at || null };
      });
    }
    return historyResponse({ history: result });
  } catch (error) {
    console.error("Error fetching history:", error);
    return historyResponse({ error: "Failed to fetch member history" }, 503);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const authResponse = rejectUnauthorizedAdminMutation(request);
    if (authResponse) {
      authResponse.headers.set("Cache-Control", "no-store");
      authResponse.headers.set("Vary", "Cookie");
      return authResponse;
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ReviewInputError("Invalid notes payload");
    const review = await saveMemberReview({ player_tag: body.player_tag, notes: body.notes });
    return historyResponse({ success: true, review });
  } catch (error) {
    if (error instanceof ReviewInputError) return historyResponse({ error: error.message }, error.status);
    console.error("Private member note storage is unavailable");
    return historyResponse({ error: "Private member reviews are unavailable. Please try again later." }, 503);
  }
}
