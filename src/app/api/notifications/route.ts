import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// GET — Fetch notifications (with optional ?unreadOnly=true and ?limit=50)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const unreadOnly = searchParams.get("unreadOnly") === "true";
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);

    let query = supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (unreadOnly) {
      query = query.eq("is_read", false);
    }

    const { data: notifications, error } = await query;
    if (error) throw error;

    // Also get unread count
    const { count, error: countError } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("is_read", false);

    if (countError) throw countError;

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
      if (error) throw error;
    } else if (Array.isArray(body.ids) && body.ids.length > 0) {
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .in("id", body.ids);
      if (error) throw error;
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

    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting notifications:", error);
    return NextResponse.json(
      { error: "Failed to delete notifications" },
      { status: 500 }
    );
  }
}
