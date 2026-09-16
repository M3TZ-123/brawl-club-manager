import { NextRequest, NextResponse } from "next/server";
import { rejectUnauthorizedAdminMutation } from "@/lib/admin-auth";
import { loadClubRivals, saveClubRival } from "@/lib/club-rivals";
import { RivalInputError, rivalRegion } from "@/lib/club-rivals-data";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store"};
function failure(error:unknown) { return NextResponse.json({error:error instanceof RivalInputError?error.message:"Club comparison unavailable"},{status:error instanceof RivalInputError?error.status:503,headers}); }
export async function GET(request:NextRequest) {
  try {return NextResponse.json(await loadClubRivals(rivalRegion(request.nextUrl.searchParams.get("region")||"global")),{headers:{"Cache-Control":"public, max-age=30, s-maxage=60"}});}catch(error){return failure(error);}
}
export async function POST(request:NextRequest) {
  const denied=rejectUnauthorizedAdminMutation(request);if(denied){denied.headers.set("Cache-Control","no-store");return denied;}
  try { const raw=await request.text();if(raw.length>256)throw new RivalInputError("Invalid club selection");return NextResponse.json(await saveClubRival(JSON.parse(raw)),{headers}); }catch(error){return failure(error instanceof SyntaxError?new RivalInputError("Invalid club selection"):error);}
}
