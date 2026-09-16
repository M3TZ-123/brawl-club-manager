import { NextRequest,NextResponse } from "next/server";
import { rejectUnauthorizedAdminMutation,verifyAdminSession } from "@/lib/admin-auth";
import { PlanningInputError } from "@/lib/club-planning-input";
import { mutateClubPlanning,readClubPlanning } from "@/lib/club-planning";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store",Vary:"Cookie"};
function failure(error:unknown){return NextResponse.json({error:error instanceof PlanningInputError?error.message:"Club planning is unavailable. Please try again."},{status:error instanceof PlanningInputError?error.status:503,headers});}
export async function GET(request:NextRequest){try{const query=request.nextUrl.searchParams;return NextResponse.json(await readClubPlanning(query.get("public")!=="1"&&verifyAdminSession(request),{goal:query.get("goal")||undefined,event:query.get("event")||undefined,overview:query.get("overview")==="1"}),{headers});}catch(error){return failure(error);}}
async function save(request:NextRequest){const denied=rejectUnauthorizedAdminMutation(request);if(denied){Object.entries(headers).forEach(([k,v])=>denied.headers.set(k,v));return denied;}try{const body=await request.text();if(body.length>60000)throw new PlanningInputError("Check the planning fields and try again.");return NextResponse.json(await mutateClubPlanning(JSON.parse(body)),{headers});}catch(error){return failure(error instanceof SyntaxError?new PlanningInputError("Check the planning fields and try again."):error);}}
export const POST=save;
export const PATCH=save;
