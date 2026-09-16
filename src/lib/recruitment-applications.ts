import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { adminLoginClientKey } from "@/lib/admin-rate-limit";
import { candidateTag,CandidateInputError } from "@/lib/recruitment-data";
import { administrationCursor,administrationFailure,currentAdministrationClub,loadClubAdministration,project } from "@/lib/club-administration";
import { AdministrationInputError,integerInput,objectInput,textInput,uuidInput,type PublicJoinInfo,type RecruitmentApplication } from "@/lib/club-administration-data";
const fields="id,player_tag,message,language,availability,status,private_notes,version,created_at,updated_at";
export async function publicJoinInfo():Promise<PublicJoinInfo>{return project(await loadClubAdministration(),"club_tag,recruitment_open,min_trophies,min_power11,min_ranked_points,language,availability");}
export async function readApplicationBody(request:Request):Promise<unknown>{
  if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))throw new AdministrationInputError("Send the application as JSON.",415);
  if(Number(request.headers.get("content-length"))>4096)throw new AdministrationInputError("Application is too long.",413);
  const reader=request.body?.getReader();if(!reader)throw new AdministrationInputError("Invalid application");
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw new AdministrationInputError("Application is too long.",413);}chunks.push(value);}}
  finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new AdministrationInputError("Invalid application");}
}
export async function submitApplication(value:unknown,request:Request){
  const origin=request.headers.get("origin");
  if(!origin || origin!==new URL(request.url).origin)throw new AdministrationInputError("Submit this form from the club website.",403);
  const row=objectInput(value);
  if(Object.keys(row).some(key=>!["club_tag","player_tag","message","language","availability","request_id","website","consent"].includes(key)))throw new AdministrationInputError("Invalid application");
  if(row.consent!==true)throw new AdministrationInputError("Confirm that you agree to submit these details privately.");
  let tag:string;try{tag=candidateTag(row.player_tag);}catch(error){if(error instanceof CandidateInputError)throw new AdministrationInputError(error.message);throw error;}
  const payload={p_club_tag:textInput(row.club_tag,21,true),p_tag:tag,p_message:textInput(row.message??"",1000),
    p_language:textInput(row.language??"",120),p_availability:textInput(row.availability??"",240),p_request_id:uuidInput(row.request_id)};
  if(row.website!=null && textInput(row.website,200))return {accepted:true};
  // No raw IP is stored. A separate domain prevents linking these quota buckets to login attempts.
  const p_client_key=createHash("sha256").update(`recruitment:${adminLoginClientKey(request)}`).digest("hex");
  const {data,error}=await supabaseAdmin.rpc("submit_recruitment_application",{...payload,p_client_key});
  if(error?.code==="55000")throw new AdministrationInputError("Applications are currently closed.",409);
  if(error?.code==="54000" || !error && data===false)throw new AdministrationInputError("Application limit reached. Please try again tomorrow.",429);
  administrationFailure(error);
  if(data!==true)throw new AdministrationInputError("Applications are temporarily unavailable.",503);
  return {accepted:true};
}
export async function listApplications(offset:number,status:string|null,cursor:string|null=null){
  const club=await currentAdministrationClub();
  const base=()=>{let query=supabaseAdmin.from("recruitment_applications").select(fields,{count:"exact"}).eq("club_tag",club);if(status&&status!=="all")query=query.eq("status",status);return query;};
  if(status && status!=="all" && !["pending","reviewing","accepted","rejected","archived"].includes(status))throw new AdministrationInputError("Invalid application status");
  let query=base().order("created_at",{ascending:false}).order("id",{ascending:false});
  if(cursor){const {at,id}=administrationCursor(cursor);query=query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`).limit(51);}
  else query=query.range(offset,offset+50);
  const {data,error,count}=await query;administrationFailure(error);
  const applications=(data||[]).slice(0,50).map(row=>project<RecruitmentApplication>(row,fields)),tail=applications.at(-1),hasMore=(data?.length||0)>50;
  return {applications,total:cursor?null:count??0,nextOffset:!cursor&&hasMore?offset+50:null,
    nextCursor:hasMore&&tail?Buffer.from(JSON.stringify({at:tail.created_at,id:tail.id})).toString("base64url"):null};
}
export async function reviewApplication(value:unknown){
  const row=objectInput(value);
  if(!["pending","reviewing","accepted","rejected","archived"].includes(String(row.status)))throw new AdministrationInputError("Invalid application status");
  const {data,error}=await supabaseAdmin.rpc("review_recruitment_application",{p_id:uuidInput(row.id),p_status:row.status,p_notes:textInput(row.private_notes,1000),p_version:integerInput(row.version,2147483646)});
  administrationFailure(error);
  if(!data || typeof data!=="object")throw new AdministrationInputError("Applications are temporarily unavailable.",503);
  return {application:project<RecruitmentApplication>(data,fields)};
}
