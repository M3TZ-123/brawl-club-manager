import { NextResponse } from "next/server";
import { isAuthorizedSchedulerRequest } from "@/lib/scheduler-auth";
import { requireAcceptedClubRoster } from "@/lib/accepted-club-roster";
import { refreshMegaPigSource } from "@/lib/mega-pig-source-cache";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const headers = { "Cache-Control": "no-store" };

// Called by the Supabase pg_cron job "brawl-mega-pig-fetch" every 10 minutes so
// Mega Pig readings (and automatic cycles) never depend on an admin having the
// page open. The shared cache cadence decides whether the source is actually
// fetched (10 minutes while a cycle is capturing, otherwise 20).
export async function GET(request: Request) {
  if (!await isAuthorizedSchedulerRequest(request)) return NextResponse.json({ error: "Scheduler authorization required" }, { status: 401, headers });
  try {
    const clubTag = await requireAcceptedClubRoster();
    const snapshot = await refreshMegaPigSource(clubTag);
    return NextResponse.json({ ok: true, fetchedAt: snapshot.fetchedAt, nextCheckAt: snapshot.nextCheckAt,
      stale: snapshot.stale, errorCode: snapshot.errorCode ?? null }, { headers });
  } catch {
    return NextResponse.json({ ok: false, error: "Mega Pig source is temporarily unavailable" }, { status: 503, headers });
  }
}
