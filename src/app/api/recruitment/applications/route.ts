import { NextRequest,NextResponse } from "next/server";
import { rejectUnauthorizedAdminMutation,rejectUnauthorizedAdminRequest } from "@/lib/admin-auth";
import { AdministrationInputError } from "@/lib/club-administration-data";
import { listApplications,reviewApplication } from "@/lib/recruitment-applications";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store",Vary:"Cookie"};
function denied(response:NextResponse){Object.entries(headers).forEach(([key,value])=>response.headers.set(key,value));return response;}
function failure(error:unknown){return NextResponse.json({error:error instanceof AdministrationInputError?error.message:"Applications are temporarily unavailable."},{status:error instanceof AdministrationInputError?error.status:503,headers});}
export async function GET(request:NextRequest){const auth=rejectUnauthorizedAdminRequest(request);if(auth)return denied(auth);try{const params=new URL(request.url).searchParams;const offset=Number(params.get("offset")||0);if(!Number.isSafeInteger(offset)||offset<0||offset>500 || params.has("cursor")&&offset!==0)throw new AdministrationInputError("Invalid page");return NextResponse.json(await listApplications(offset,params.get("status"),params.get("cursor")),{headers});}catch(error){return failure(error);}}
export async function PATCH(request:NextRequest){const auth=rejectUnauthorizedAdminMutation(request);if(auth)return denied(auth);try{return NextResponse.json(await reviewApplication(await request.json().catch(()=>null)),{headers});}catch(error){return failure(error);}}
