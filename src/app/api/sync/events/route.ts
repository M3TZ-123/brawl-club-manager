import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { normalizeSyncTag, SyncError } from "@/lib/sync-service";
import { publicAuditSnapshot } from "@/lib/sync-public-snapshots";
import { historyClubTag } from "@/lib/history-membership";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };
type TimelineCursor = { at: string; id: string };
function timelineCursor(value: string): TimelineCursor {
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!cursor || typeof cursor.at !== "string"
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(cursor.at)
      || !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.id !== "string"
      || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(cursor.id)) throw new Error();
    const day = new Date(`${cursor.at.slice(0, 10)}T00:00:00Z`);
    const offset = /[+-](\d\d):(\d\d)$/.exec(cursor.at);
    if (!Number.isFinite(day.getTime()) || day.getUTCFullYear() < 1 || day.toISOString().slice(0, 10) !== cursor.at.slice(0, 10)
      || Number(cursor.at.slice(11, 13)) > 23 || offset && (Number(offset[1]) > 15 || Number(offset[2]) > 59)) throw new Error();
    // Keep PostgreSQL microseconds verbatim for equal-timestamp UUID ties.
    return { at: cursor.at, id: cursor.id };
  } catch { throw new SyncError("invalid_cursor", "Invalid timeline cursor.", 400); }
}

function publicProvenance(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>, result: Record<string, string | null> = {};
  const categories: Record<string, readonly string[]> = {
    sourceCategory: ["club_roster_snapshot", "player_profile", "legacy_club_events"],
    timeMeaning: ["observed_at", "imported_at", "previously_recorded_at"],
    firstSeenMeaning: ["first_observed"],
  };
  for (const [key, allowed] of Object.entries(categories)) {
    if (raw[key] === null) result[key] = null;
    else if (typeof raw[key] === "string" && allowed.includes(raw[key])) result[key] = raw[key];
  }
  return result;
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const limit = Math.max(1, Math.min(100, Number.parseInt(params.get("limit") || "50", 10) || 50));
    const playerTag = params.has("playerTag") ? normalizeSyncTag(params.get("playerTag")) : null;
    const cursor = params.has("cursor") ? timelineCursor(params.get("cursor")!) : null;
    const clubTag = await historyClubTag();
    const now = new Date();
    let query = supabaseAdmin.from("membership_change_events")
      .select("id,event_type,player_tag,player_name,occurred_at,source,run_id,trigger_source,actor,before_snapshot,after_snapshot,provenance")
      .eq("club_tag", clubTag).lte("occurred_at", now.toISOString())
      .order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
    if (playerTag) query = query.eq("player_tag", playerTag);
    if (cursor) query = query.or(`occurred_at.lt.${cursor.at},and(occurred_at.eq.${cursor.at},id.lt.${cursor.id})`);
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    const page = rows.slice(0, limit);
    const tail = page.at(-1);
    if (await historyClubTag() !== clubTag) throw new Error("Club configuration changed");
    return NextResponse.json({ events: page.map((row) => ({ id: row.id, eventType: row.event_type, playerTag: row.player_tag, playerName: row.player_name,
      occurredAt: row.occurred_at, source: ["recorded", "reconstructed"].includes(row.source) ? row.source : "unknown", runId: row.run_id,
      trigger: ["cron", "manual", "member", "legacy"].includes(row.trigger_source) ? row.trigger_source : "unknown",
      actor: ["scheduler", "administrator"].includes(row.actor) ? row.actor : "unknown",
      before: publicAuditSnapshot(row.before_snapshot), after: publicAuditSnapshot(row.after_snapshot), provenance: publicProvenance(row.provenance) })),
      nextCursor: rows.length > limit && tail ? Buffer.from(JSON.stringify({ at: tail.occurred_at, id: tail.id })).toString("base64url") : null }, { headers });
  } catch (error) { return NextResponse.json({ error: error instanceof SyncError ? error.message : "Timeline unavailable." }, { status: error instanceof SyncError ? error.status : 503, headers }); }
}
