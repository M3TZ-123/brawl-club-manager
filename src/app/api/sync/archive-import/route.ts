import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedSchedulerRequest } from "@/lib/scheduler-auth";
import { processBattleLog, type BrawlStarsBattleLog } from "@/lib/brawl-api";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Imports battle logs captured by the GitHub battle safety-net archive
// (scripts/battle-archive.cjs) after a Vercel/Supabase outage. Insert-only:
// battles already stored are left untouched. Scheduler credentials required.
type ArchivedPlayer = { player_tag?: unknown; battlelog?: { items?: unknown } };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!await isAuthorizedSchedulerRequest(request)) return json({ error: "Scheduler authorization required" }, 401);
  const body = await request.json().catch(() => null) as { players?: unknown } | null;
  if (!body || !Array.isArray(body.players) || body.players.length > 100) return json({ error: "Invalid archive payload" }, 400);

  const battles = [];
  for (const player of body.players as ArchivedPlayer[]) {
    const tag = typeof player?.player_tag === "string" ? player.player_tag.trim().toUpperCase() : "";
    if (!/^#[0-9A-Z]{3,15}$/.test(tag) || !Array.isArray(player.battlelog?.items)) continue;
    try {
      const processed = processBattleLog(tag, { items: player.battlelog.items } as BrawlStarsBattleLog);
      battles.push(...new Map(processed.map(battle => [battle.battle_time, battle])).values());
    } catch { /* Skip a malformed log; the rest of the archive still imports. */ }
  }

  let inserted = 0, daysRebuilt = 0;
  for (let offset = 0; offset < battles.length; offset += 2000) {
    const { data, error } = await supabaseAdmin.rpc("import_archived_battles", { p_battles: battles.slice(offset, offset + 2000) });
    if (error) {
      console.error("Archive import failed", { sqlstate: /^[0-9A-Z]{5}$/.test(error.code || "") ? error.code : "unavailable" });
      return json({ error: "Archive import failed", inserted, daysRebuilt }, 503);
    }
    inserted += Number(data?.inserted || 0);
    daysRebuilt += Number(data?.daysRebuilt || 0);
  }
  return json({ success: true, received: battles.length, inserted, daysRebuilt });
}
