import { NextResponse } from "next/server";
import { AnalysisInputError, readClubReadiness } from "@/lib/club-analysis";
import { ClubRosterUnavailableError } from "@/lib/accepted-club-roster";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    return NextResponse.json(await readClubReadiness(new URL(request.url).searchParams), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof AnalysisInputError || error instanceof ClubRosterUnavailableError ? error.message : "Failed to fetch club readiness" },
      { status: error instanceof AnalysisInputError ? 400 : error instanceof ClubRosterUnavailableError ? 409 : 500, headers: { "Cache-Control": "no-store" } });
  }
}
