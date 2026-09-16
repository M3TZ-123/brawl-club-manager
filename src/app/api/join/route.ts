import { NextRequest,NextResponse } from "next/server";
import { publicJoinInfo,readApplicationBody,submitApplication } from "@/lib/recruitment-applications";
import { AdministrationInputError } from "@/lib/club-administration-data";
import { CandidateInputError } from "@/lib/recruitment-data";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store"};
function failure(error:unknown){const known=error instanceof AdministrationInputError || error instanceof CandidateInputError;return NextResponse.json({error:known?error.message:"Applications are temporarily unavailable."},{status:known?error.status:503,headers});}
export async function GET(){try{return NextResponse.json(await publicJoinInfo(),{headers});}catch(error){return failure(error);}}
export async function POST(request:NextRequest){try{return NextResponse.json(await submitApplication(await readApplicationBody(request),request),{status:202,headers});}catch(error){return failure(error);}}
