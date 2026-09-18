import { NextRequest, NextResponse } from "next/server";
import { loadMapSnapshot } from "@/lib/map-cache";
import { parseMapStatsBand } from "@/lib/map-data";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams, statsBand = parseMapStatsBand(params.get("band"));
  if (statsBand === null || params.getAll("band").length > 1 || [...params.keys()].some(key => key !== "band")) {
    return NextResponse.json({ error: "Invalid map filter" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const snapshot = await loadMapSnapshot(statsBand);
    return NextResponse.json(snapshot, { status: snapshot.data === null ? 503 : 200,
      headers: { "Cache-Control": "public, max-age=30, s-maxage=60", ...(snapshot.data === null ? { "Retry-After": "300" } : {}) } });
  } catch {
    return NextResponse.json({ error: "Map data temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "300" } });
  }
}
