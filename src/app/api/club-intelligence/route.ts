import { NextResponse } from "next/server";
import { intelligenceRange } from "@/lib/club-intelligence";
import { readClubIntelligence } from "@/lib/club-intelligence-service";

export async function GET(request: Request) {
  let range;
  try { range = intelligenceRange(new URL(request.url).searchParams.get("range")); }
  catch { return NextResponse.json({ error: "Choose a 7, 30 or 90 day club period." }, { status: 400 }); }
  try {
    return NextResponse.json(await readClubIntelligence(range), { headers: { "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=30" } });
  } catch {
    return NextResponse.json({ error: "Club insights are temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
