import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { normalizeSyncTag, SyncError } from "@/lib/sync-service";
import { publicAuditSnapshot } from "@/lib/sync-public-snapshots";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const limit = Math.max(1, Math.min(100, Number.parseInt(params.get("limit") || "50", 10) || 50));
    let query = supabaseAdmin.from("membership_change_events")
      .select("id,event_type,player_tag,player_name,occurred_at,source,run_id,trigger_source,actor,before_snapshot,after_snapshot,provenance")
      .order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
    if (params.get("playerTag")) query = query.eq("player_tag", normalizeSyncTag(params.get("playerTag")));
    if (params.get("cursor")) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(params.get("cursor")!, "base64url").toString("utf8")); } catch { throw new SyncError("invalid_cursor", "Invalid timeline cursor.", 400); }
      if (!cursor || typeof cursor.at !== "string" || !/^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(cursor.at) || !Number.isFinite(Date.parse(cursor.at)) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(cursor.id)) throw new SyncError("invalid_cursor", "Invalid timeline cursor.", 400);
      query = query.or(`occurred_at.lt.${cursor.at},and(occurred_at.eq.${cursor.at},id.lt.${cursor.id})`);
    }
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    const page = rows.slice(0, limit);
    const tail = page.at(-1);
    return NextResponse.json({ events: page.map((row) => ({ id: row.id, eventType: row.event_type, playerTag: row.player_tag, playerName: row.player_name,
      occurredAt: row.occurred_at, source: row.source, runId: row.run_id, trigger: row.trigger_source, actor: row.actor, before: publicAuditSnapshot(row.before_snapshot), after: publicAuditSnapshot(row.after_snapshot), provenance: row.provenance })),
      nextCursor: rows.length > limit && tail ? Buffer.from(JSON.stringify({ at: tail.occurred_at, id: tail.id })).toString("base64url") : null });
  } catch (error) { return NextResponse.json({ error: error instanceof SyncError ? error.message : "Timeline unavailable." }, { status: error instanceof SyncError ? error.status : 500 }); }
}
