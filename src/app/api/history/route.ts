import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { rejectUnauthorizedAdminMutation, verifyAdminSession } from "@/lib/admin-auth";
import { loadMemberReviews, ReviewInputError, saveMemberReview } from "@/lib/member-reviews";
import { parseTimeRange, TIME_RANGES } from "@/lib/time-range";
import { historyClubTag, latestHistoryMembershipEvents, type HistoryMemberRow } from "@/lib/history-membership";

export const dynamic = "force-dynamic";
const PUBLIC_HISTORY_COLUMNS = "player_tag, player_name, first_seen, last_seen, last_left_at, times_joined, times_left, is_current_member, role_at_leave, trophies_at_leave";

function historyResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
}

async function fetchAllMemberHistory(): Promise<HistoryMemberRow[]> {
  const pageSize = 1000;
  const rows: HistoryMemberRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const query = supabaseAdmin
      .from("member_history")
      .select(PUBLIC_HISTORY_COLUMNS)
      .order("last_seen", { ascending: false })
      .order("player_tag", { ascending: true })
      .range(from, from + pageSize - 1);

    const { data, error } = await query;

    if (error) throw error;
    rows.push(...((data || []) as HistoryMemberRow[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const daysParam = searchParams.get("days");
    const parsedDays = daysParam && daysParam !== "all" ? Number(daysParam) : null;
    const range = searchParams.get("range");
    const days = range === "all" ? null : range != null ? TIME_RANGES[parseTimeRange(range)].days
      : parsedDays != null && Number.isFinite(parsedDays) && parsedDays > 0 ? Math.min(parsedDays, 365) : null;
    const now = new Date();
    const cutoffDate = days
      ? new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
      : null;

    const [clubTag, history] = await Promise.all([historyClubTag(), fetchAllMemberHistory()]);
    const latestEvents = await latestHistoryMembershipEvents(clubTag, history, now);
    const filteredHistory = history.filter(record => {
      if (!cutoffDate) return true;
      const event = latestEvents.get(record.player_tag);
      return !!event && Date.parse(event.at) >= cutoffDate.getTime();
    });

    // Whitelist the response too: a future query change must not publish
    // legacy notes or any other private columns through this public route.
    const publicColumns = PUBLIC_HISTORY_COLUMNS.split(", ");
    let result: Array<Record<string, unknown>> = filteredHistory.map(row => ({
      ...Object.fromEntries(publicColumns.map(column => [column, row[column]])),
      latest_membership_event: latestEvents.get(row.player_tag) || null,
    }));
    if (verifyAdminSession(request)) {
      const reviews = new Map((await loadMemberReviews()).map(review => [review.player_tag, review]));
      result = result.map(row => {
        const review = reviews.get(String(row.player_tag));
        return { ...row, notes: review?.notes || null, review_status: review?.status || "pending", follow_up_at: review?.follow_up_at || null, review_updated_at: review?.updated_at || null };
      });
    }
    if (await historyClubTag() !== clubTag) throw new Error("Club configuration changed while loading history");
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
    const review = await saveMemberReview({ player_tag: body.player_tag, notes: body.notes,
      ...(Object.prototype.hasOwnProperty.call(body, "expected_updated_at") ? { expected_updated_at: body.expected_updated_at } : {}) });
    return historyResponse({ success: true, review });
  } catch (error) {
    if (error instanceof ReviewInputError) return historyResponse({ error: error.message }, error.status);
    console.error("Private member note storage is unavailable");
    return historyResponse({ error: "Private member reviews are unavailable. Please try again later." }, 503);
  }
}
