import { NextRequest, NextResponse } from "next/server";
import { loadGameData } from "@/lib/game-cache";
import { gameRankingKey } from "@/lib/game-data";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams, kind = params.get("kind") || "events", region = params.get("region") || "global";
  if (kind !== "events" && !gameRankingKey(region, kind)) return NextResponse.json({ error: "Invalid ranking selection" }, { status: 400 });
  try {
    const snapshot = await loadGameData(kind as "events" | "players" | "clubs", region);
    return NextResponse.json(snapshot, { status: snapshot.data === null ? 503 : 200, headers: { "Cache-Control": snapshot.stale ? "no-store" : "public, max-age=30, s-maxage=60", ...(snapshot.data === null ? { "Retry-After": "60" } : {}) } });
  } catch { return NextResponse.json({ error: "Game data temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } }); }
}
