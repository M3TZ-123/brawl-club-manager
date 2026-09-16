import { NextRequest, NextResponse } from "next/server";
import { getPlayerProgress, ProgressQueryError } from "@/lib/player-progress-service";

export async function GET(request: NextRequest, { params }: { params: Promise<{ tag: string }> }) {
  try {
    const { tag } = await params;
    let playerTag: string;
    try { playerTag = decodeURIComponent(tag).trim().toUpperCase(); }
    catch { throw new ProgressQueryError("Invalid player tag"); }
    return NextResponse.json(await getPlayerProgress(playerTag, new URL(request.url).searchParams), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof ProgressQueryError ? error.status : 500;
    return NextResponse.json({ error: error instanceof ProgressQueryError ? error.message : "Failed to fetch player progress" }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
