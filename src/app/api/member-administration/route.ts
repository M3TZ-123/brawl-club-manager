import { NextRequest, NextResponse } from "next/server";
import { rejectUnauthorizedAdminMutation, rejectUnauthorizedAdminRequest } from "@/lib/admin-auth";
import { AdministrationInputError } from "@/lib/club-administration-data";
import { listActiveAbsences, loadMemberAdministration, mutateMemberAdministration } from "@/lib/club-administration";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store",Vary:"Cookie"};
function denied(response:NextResponse){Object.entries(headers).forEach(([key,value])=>response.headers.set(key,value));return response;}
function failure(error:unknown){return NextResponse.json({error:error instanceof AdministrationInputError?error.message:"Administration data is temporarily unavailable."},{status:error instanceof AdministrationInputError?error.status:503,headers});}
export async function GET(request:NextRequest){const auth=rejectUnauthorizedAdminRequest(request);if(auth)return denied(auth);try{const params=new URL(request.url).searchParams;return NextResponse.json(params.has("player_tag")?await loadMemberAdministration(params.get("player_tag"),params.get("cursor")):{absences:await listActiveAbsences()},{headers});}catch(error){return failure(error);}}
export async function POST(request:NextRequest){const auth=rejectUnauthorizedAdminMutation(request);if(auth)return denied(auth);try{return NextResponse.json(await mutateMemberAdministration(await request.json().catch(()=>null)),{headers});}catch(error){return failure(error);}}
