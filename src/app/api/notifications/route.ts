import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { rejectUnauthorizedAdminMutation } from "@/lib/admin-auth";
import { parseTimeRange, TIME_RANGES } from "@/lib/time-range";

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
  "capacity",
  "battle_gap",
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

type NotificationCursor = { at: string | null; id: number };
function validCursorTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) return false;
  const datePart = value.slice(0, 10);
  const date = new Date(`${datePart}T00:00:00Z`);
  // Date.parse normalizes impossible dates such as February 30; PostgreSQL
  // rejects them. Validate before a malformed cursor reaches PostgREST.
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.toISOString().slice(0, 10) !== datePart) return false;
  const offset = /[+-](\d\d):(\d\d)$/.exec(value);
  return Number(value.slice(11, 13)) <= 23 && (!offset || Number(offset[1]) <= 15 && Number(offset[2]) <= 59);
}
function parseCursor(value: string): NotificationCursor {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid notification cursor");
  const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as NotificationCursor;
  if (!cursor || (cursor.at !== null && !validCursorTimestamp(cursor.at))
    || !Number.isSafeInteger(cursor.id) || cursor.id <= 0 || cursor.id > 2_147_483_647) {
    throw new Error("Invalid notification cursor");
  }
  // Preserve PostgreSQL's fractional precision for equal-timestamp ID ties.
  return { at: cursor.at, id: cursor.id };
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

// GET — Fetch notifications with filters applied before pagination.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const unreadOnly = searchParams.get("unreadOnly") === "true";
    const limit = parseBoundedInt(searchParams.get("limit"), 50, 1, 100);
    const offset = parseBoundedInt(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    let cursor: NotificationCursor | null = null;
    if (searchParams.has("cursor")) {
      try { cursor = parseCursor(searchParams.get("cursor")!); }
      catch { return notificationResponse({ error: "Invalid notification cursor" }, { status: 400 }); }
    }
    const range = searchParams.get("range");
    const now = Date.now();
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
        nextOffset: null,
        nextCursor: null,
      });
    }

    let query = supabaseAdmin
      .from("notifications")
      .select("id, type, title, message, player_tag, player_name, is_read, created_at")
      .order("created_at", { ascending: false, nullsFirst: true })
      .order("id", { ascending: false })
      .range(cursor ? 0 : offset, (cursor ? 0 : offset) + limit);

    if (cursor) {
      // created_at is nullable in legacy rows. Preserve their existing nulls-
      // first order, then advance into dated rows without losing either group.
      query = query.or(cursor.at === null
        ? `created_at.not.is.null,and(created_at.is.null,id.lt.${cursor.id})`
        : `created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
    }

    if (unreadOnly) {
      query = query.eq("is_read", false);
    }

    if (types.length > 0) {
      query = query.in("type", types);
    }
    if (range != null) {
      const days = TIME_RANGES[parseTimeRange(range)].days;
      query = query.gte("created_at", new Date(now - days * 86_400_000).toISOString())
        .lte("created_at", new Date(now).toISOString());
    }

    const [notificationsRes, unreadCountRes] = await Promise.all([
      query,
      getUnreadCount(),
    ]);

    if (notificationsRes.error) {
      if (isMissingNotificationsTable(notificationsRes.error)) {
        return notificationResponse({ error: "Notifications are temporarily unavailable. Please try again." }, { status: 503 });
      }
      throw notificationsRes.error;
    }

    const rows = notificationsRes.data || [];
    const page = rows.slice(0, limit);
    const tail = page.at(-1);
    return notificationResponse({
      notifications: page,
      unreadCount: unreadCountRes,
      nextOffset: !cursor && rows.length > limit ? offset + limit : null,
      nextCursor: rows.length > limit && tail
        ? Buffer.from(JSON.stringify({ at: tail.created_at ?? null, id: tail.id })).toString("base64url") : null,
    });
  } catch (error) {
    if (isMissingNotificationsTable(error)) {
      return notificationResponse({ error: "Notifications are temporarily unavailable. Please try again." }, { status: 503 });
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

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => key !== "all" && key !== "ids")
      || (Object.hasOwn(body, "all") && Object.hasOwn(body, "ids"))) {
      return notificationResponse({ error: "Provide { all: true } or { ids: [1,2,3] }" }, { status: 400 });
    }

    if (body.all === true) {
      const { error } = await supabaseAdmin
        .from("notifications")
        .update({ is_read: true })
        .eq("is_read", false);
      if (error) {
        if (isMissingNotificationsTable(error)) {
          return notificationResponse({ error: "Notifications are temporarily unavailable. Please try again." }, { status: 503 });
        }
        throw error;
      }
    } else if (Array.isArray(body.ids) && body.ids.length > 0) {
      if (body.ids.length > 100 || !body.ids.every((id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647)) {
        return notificationResponse(
          { error: "Provide valid notification ids" },
          { status: 400 }
        );
      }
      const ids = [...new Set(body.ids as number[])];

      const { error } = await supabaseAdmin
        .from("notifications")
        .update({ is_read: true })
        .in("id", ids);
      if (error) {
        if (isMissingNotificationsTable(error)) {
          return notificationResponse({ error: "Notifications are temporarily unavailable. Please try again." }, { status: 503 });
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
      return notificationResponse({ error: "Notifications are temporarily unavailable. Please try again." }, { status: 503 });
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
        return notificationResponse({ error: "Notifications are temporarily unavailable. Please try again." }, { status: 503 });
      }
      throw error;
    }
    return notificationResponse({ success: true, unreadCount: await getUnreadCount() });
  } catch (error) {
    if (isMissingNotificationsTable(error)) {
      return notificationResponse({ error: "Notifications are temporarily unavailable. Please try again." }, { status: 503 });
    }
    console.error("Error deleting notifications:", error);
    return notificationResponse(
      { error: "Failed to delete notifications" },
      { status: 500 }
    );
  }
}
