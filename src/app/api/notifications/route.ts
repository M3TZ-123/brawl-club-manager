import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { rejectUnauthorizedAdminMutation } from "@/lib/admin-auth";

const ALLOWED_NOTIFICATION_TYPES = new Set([
  "join",
  "leave",
  "inactive",
  "promotion",
  "demotion",
  "role_change",
  "name_change",
  "sync_error",
  "milestone",
]);

function isMissingNotificationsTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: string; message?: string };
  return (
    maybeError.code === "PGRST205" ||
    maybeError.message?.includes("public.notifications") === true
  );
}

function parseBoundedInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function notificationResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");

  return NextResponse.json(body, {
    ...init,
    headers,
  });
}

async function getUnreadCount() {
  const { count, error } = await supabaseAdmin
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("is_read", false);

  if (error) throw error;
  return count || 0;
}

// GET — Fetch notifications (with optional ?unreadOnly=true and ?limit=50)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const unreadOnly = searchParams.get("unreadOnly") === "true";
    const limit = parseBoundedInt(searchParams.get("limit"), 50, 1, 100);
    const typesParam = searchParams.get("types");
    const hasTypeFilter = typesParam != null && typesParam.trim().length > 0;
    const types = hasTypeFilter
      ? [...new Set(
          typesParam
            .split(",")
            .map((t) => t.trim())
            .filter((type) => ALLOWED_NOTIFICATION_TYPES.has(type))
        )].slice(0, ALLOWED_NOTIFICATION_TYPES.size)
      : [];

    if (hasTypeFilter && types.length === 0) {
      return notificationResponse({
        notifications: [],
        unreadCount: await getUnreadCount(),
      });
    }

    let query = supabaseAdmin
      .from("notifications")
      .select("id, type, title, message, player_tag, player_name, is_read, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (unreadOnly) {
      query = query.eq("is_read", false);
    }

    if (types.length > 0) {
      query = query.in("type", types);
    }

    const [notificationsRes, unreadCountRes] = await Promise.all([
      query,
      getUnreadCount(),
    ]);

    if (notificationsRes.error) {
      if (isMissingNotificationsTable(notificationsRes.error)) {
        return notificationResponse({ notifications: [], unreadCount: 0, tableMissing: true });
      }
      throw notificationsRes.error;
    }

    return notificationResponse({
      notifications: notificationsRes.data || [],
      unreadCount: unreadCountRes,
    });
  } catch (error) {
    if (isMissingNotificationsTable(error)) {
      return notificationResponse({ notifications: [], unreadCount: 0, tableMissing: true });
    }
    console.error("Error fetching notifications:", error);
    return notificationResponse(
      { error: "Failed to fetch notifications" },
      { status: 500 }
    );
  }
}

// PATCH — Mark notifications as read
// Body: { ids: number[] } to mark specific ones, or { all: true } to mark all
export async function PATCH(request: NextRequest) {
  try {
    const authResponse = rejectUnauthorizedAdminMutation(request);
    if (authResponse) return authResponse;

    const body = await request.json().catch(() => ({}));

    if (body.all === true) {
      const { error } = await supabaseAdmin
        .from("notifications")
        .update({ is_read: true })
        .eq("is_read", false);
      if (error) {
        if (isMissingNotificationsTable(error)) {
          return notificationResponse({ success: true, unreadCount: 0, tableMissing: true });
        }
        throw error;
      }
    } else if (Array.isArray(body.ids) && body.ids.length > 0) {
      const ids = body.ids
        .map((id: unknown) => Number.parseInt(String(id), 10))
        .filter((id: number) => Number.isFinite(id) && id > 0)
        .slice(0, 100);

      if (ids.length === 0) {
        return notificationResponse(
          { error: "Provide valid notification ids" },
          { status: 400 }
        );
      }

      const { error } = await supabaseAdmin
        .from("notifications")
        .update({ is_read: true })
        .in("id", ids);
      if (error) {
        if (isMissingNotificationsTable(error)) {
          return notificationResponse({ success: true, unreadCount: 0, tableMissing: true });
        }
        throw error;
      }
    } else {
      return notificationResponse(
        { error: "Provide { all: true } or { ids: [1,2,3] }" },
        { status: 400 }
      );
    }

    return notificationResponse({ success: true, unreadCount: await getUnreadCount() });
  } catch (error) {
    if (isMissingNotificationsTable(error)) {
      return notificationResponse({ success: true, unreadCount: 0, tableMissing: true });
    }
    console.error("Error updating notifications:", error);
    return notificationResponse(
      { error: "Failed to update notifications" },
      { status: 500 }
    );
  }
}

// DELETE — Delete old read notifications (cleanup)
export async function DELETE(request: NextRequest) {
  try {
    const authResponse = rejectUnauthorizedAdminMutation(request);
    if (authResponse) return authResponse;

    const { error } = await supabaseAdmin
      .from("notifications")
      .delete()
      .eq("is_read", true)
      .lt("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    if (error) {
      if (isMissingNotificationsTable(error)) {
        return notificationResponse({ success: true, unreadCount: 0, tableMissing: true });
      }
      throw error;
    }
    return notificationResponse({ success: true, unreadCount: await getUnreadCount() });
  } catch (error) {
    if (isMissingNotificationsTable(error)) {
      return notificationResponse({ success: true, unreadCount: 0, tableMissing: true });
    }
    console.error("Error deleting notifications:", error);
    return notificationResponse(
      { error: "Failed to delete notifications" },
      { status: 500 }
    );
  }
}
