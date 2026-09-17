import { NextResponse } from "next/server";
import { rejectUnauthorizedAdminRequest } from "@/lib/admin-auth";
import { ClubRosterUnavailableError } from "@/lib/accepted-club-roster";
import { MemberComparisonInputError, readMemberComparison } from "@/lib/member-comparison-service";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", Vary: "Cookie" };
export async function GET(request: Request) {
  const denied = rejectUnauthorizedAdminRequest(request);
  if (denied) {
    Object.entries(headers).forEach(([key, value]) => denied.headers.set(key, value));
    return denied;
  }
  try { return NextResponse.json(await readMemberComparison(new URL(request.url).searchParams), { headers }); }
  catch (error) {
    const status = error instanceof MemberComparisonInputError ? 400 : error instanceof ClubRosterUnavailableError ? 409 : 503;
    return NextResponse.json({ error: status === 503 ? "Member comparison is temporarily unavailable. Please try again." : (error as Error).message }, { status, headers });
  }
}
