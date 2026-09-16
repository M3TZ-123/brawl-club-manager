import { NextRequest, NextResponse } from "next/server";
import { rejectUnauthorizedAdminMutation, rejectUnauthorizedAdminRequest } from "@/lib/admin-auth";
import { CandidateInputError } from "@/lib/recruitment-data";
import { listCandidates, refreshCandidate, saveCandidate } from "@/lib/recruitment";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", Vary: "Cookie" };
function privateDenied(response: NextResponse) { Object.entries(headers).forEach(([key,value]) => response.headers.set(key,value)); return response; }
function failure(error: unknown) { return NextResponse.json({ error: error instanceof CandidateInputError ? error.message : "Candidate list unavailable" }, { status: error instanceof CandidateInputError ? error.status : 503, headers }); }
export async function GET(request: NextRequest) {
  const denied = rejectUnauthorizedAdminRequest(request); if (denied) return privateDenied(denied);
  try { return NextResponse.json({ candidates: await listCandidates() }, { headers }); } catch(error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  const denied = rejectUnauthorizedAdminMutation(request); if (denied) return privateDenied(denied);
  try { return NextResponse.json({ candidate: await saveCandidate(await request.json().catch(() => null)) }, { headers }); } catch(error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const denied = rejectUnauthorizedAdminMutation(request); if (denied) return privateDenied(denied);
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "player_tag")) throw new CandidateInputError("Invalid candidate");
    return NextResponse.json(await refreshCandidate(body.player_tag), { headers });
  } catch(error) { return failure(error); }
}
