import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

function isMissingNotificationsTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: string; message?: string };
  return (
    maybeError.code === "PGRST205" ||
    maybeError.message?.includes("public.notifications") === true
  );
}

// GET — Fetch notifications (with optional ?unreadOnly=true and ?limit=50)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const unreadOnly = searchParams.get("unreadOnly") === "true";
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const typesParam = searchParams.get("types");
    const types = typesParam
      ? typesParam.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    // One-time backfill: if notifications table is empty, import from club_events
    const { count: existingCount, error: existingCountError } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true });

    if (existingCountError) {
      if (isMissingNotificationsTable(existingCountError)) {
        return NextResponse.json({ notifications: [], unreadCount: 0, tableMissing: true });
      }
      throw existingCountError;
    }

    if (existingCount === 0) {
      const { data: events } = await supabase
        .from("club_events")
        .select("*")
        .order("event_time", { ascending: false })
        .limit(100);

      if (events && events.length > 0) {
        const uniqueKeys = new Set<string>();
        const backfill = events
          .filter((e: { event_type: string; player_name: string; player_tag: string; event_time: string }) => {
            const key = `${e.event_type}|${e.player_tag}|${e.player_name}|${e.event_time}`;
            if (uniqueKeys.has(key)) return false;
            uniqueKeys.add(key);
            return true;
          })
          .map((e: { event_type: string; player_name: string; player_tag: string; event_time: string }) => ({
          type: e.event_type,
          title: e.event_type === "join" ? "Member Joined" : "Member Left",
          message: `${e.player_name} (${e.player_tag}) ${e.event_type === "join" ? "joined" : "left"} the club.`,
          player_tag: e.player_tag,
          player_name: e.player_name,
          is_read: true, // mark old events as already read
          created_at: e.event_time,
        }));
        const { error: insertError } = await supabase.from("notifications").insert(backfill);
        if (insertError && !isMissingNotificationsTable(insertError)) {
          throw insertError;
        }
        console.log(`Backfilled ${backfill.length} notifications from club_events`);
      }
    }

    let query = supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (unreadOnly) {
      query = query.eq("is_read", false);
    }

    if (types.length > 0) {
      query = query.in("type", types);
    }

    const { data: notifications, error } = await query;
    if (error) {
      if (isMissingNotificationsTable(error)) {
        return NextResponse.json({ notifications: [], unreadCount: 0, tableMissing: true });
      }
      throw error;
    }

    // Also get unread count
    const { count, error: countError } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("is_read", false);

    if (countError) {
      if (isMissingNotificationsTable(countError)) {
        return NextResponse.json({ notifications: notifications || [], unreadCount: 0, tableMissing: true });
      }
      throw countError;
    }

    return NextResponse.json({
      notifications: notifications || [],
      unreadCount: count || 0,
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    return NextResponse.json(
      { error: "Failed to fetch notifications" },
      { status: 500 }
    );
  }
}

// PATCH — Mark notifications as read
// Body: { ids: number[] } to mark specific ones, or { all: true } to mark all
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();

    if (body.all === true) {
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("is_read", false);
      if (error) {
        if (isMissingNotificationsTable(error)) {
          return NextResponse.json({ success: true, tableMissing: true });
        }
        throw error;
      }
    } else if (Array.isArray(body.ids) && body.ids.length > 0) {
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .in("id", body.ids);
      if (error) {
        if (isMissingNotificationsTable(error)) {
          return NextResponse.json({ success: true, tableMissing: true });
        }
        throw error;
      }
    } else {
      return NextResponse.json(
        { error: "Provide { all: true } or { ids: [1,2,3] }" },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating notifications:", error);
    return NextResponse.json(
      { error: "Failed to update notifications" },
      { status: 500 }
    );
  }
}

// DELETE — Delete old read notifications (cleanup)
export async function DELETE() {
  try {
    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("is_read", true)
      .lt("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    if (error) {
      if (isMissingNotificationsTable(error)) {
        return NextResponse.json({ success: true, tableMissing: true });
      }
      throw error;
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting notifications:", error);
    return NextResponse.json(
      { error: "Failed to delete notifications" },
      { status: 500 }
    );
  }
}
