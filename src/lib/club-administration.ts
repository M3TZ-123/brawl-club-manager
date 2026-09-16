import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { normalizeReviewTag,ReviewInputError } from "@/lib/member-reviews";
import { AdministrationInputError, administrationInput, dateInput, decisionKinds, objectInput, textInput, uuidInput,
  type ClubAdministration, type MemberAdministration, type MemberAbsence, type MemberDecision, type DepartureChoice } from "@/lib/club-administration-data";

const settingsFields = "club_tag,grace_hours,recruitment_open,min_trophies,min_power11,min_ranked_points,language,availability,version,updated_at";
const decisionFields = "id,kind,body,departure_event_id,corrects_id,follow_up_at,created_at";
const absenceFields = "id,player_tag,starts_at,ends_at,reason,created_at,cancelled_at";
export function project<T>(row: Record<string, unknown>, fields: string): T { return Object.fromEntries(fields.split(",").map(field => [field,row[field]])) as T; }
function memberTag(value:unknown):string {
  try { return normalizeReviewTag(value); }
  catch(error) { if(error instanceof ReviewInputError) throw new AdministrationInputError(error.message); throw error; }
}
export function administrationCursor(cursor:string):{at:string;id:string} {
  try {
    if(cursor.length>512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const parsed=objectInput(JSON.parse(Buffer.from(cursor,"base64url").toString("utf8")));
    if(Object.keys(parsed).length!==2) throw new Error();
    return {at:dateInput(parsed.at),id:uuidInput(parsed.id)};
  } catch { throw new AdministrationInputError("Invalid page"); }
}
export function administrationFailure(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === "40001") throw new AdministrationInputError("This record changed. Reload before saving.",409);
  if (["22023","23514","23502","23503"].includes(error.code || "")) throw new AdministrationInputError("Check the member, event and date fields.");
  throw new AdministrationInputError("Administration data is temporarily unavailable.",503);
}
export async function currentAdministrationClub(): Promise<string> {
  const { data,error } = await supabaseAdmin.rpc("administration_club_tag"); administrationFailure(error);
  if (typeof data !== "string" || !/^#[A-Z0-9]{1,20}$/.test(data)) throw new AdministrationInputError("Club configuration is unavailable.",503);
  return data;
}
export async function loadClubAdministration(): Promise<ClubAdministration> {
  const club = await currentAdministrationClub();
  const { data,error } = await supabaseAdmin.from("club_administration_settings").select(settingsFields).eq("club_tag",club).maybeSingle();
  administrationFailure(error);
  return data ? project(data,settingsFields) : { club_tag:club,grace_hours:0,recruitment_open:false,min_trophies:0,min_power11:0,min_ranked_points:null,language:"",availability:"",version:0,updated_at:null };
}
export async function saveClubAdministration(value: unknown): Promise<ClubAdministration> {
  const { version,...values } = administrationInput(value);
  const { data,error } = await supabaseAdmin.rpc("save_club_administration",{p_values:values,p_version:version}); administrationFailure(error);
  if (!data) throw new AdministrationInputError("Administration data is temporarily unavailable.",503);
  return project(data,settingsFields);
}
export async function listActiveAbsences(): Promise<MemberAbsence[]> {
  const club = await currentAdministrationClub(), now = new Date().toISOString();
  const { data,error } = await supabaseAdmin.from("member_absences").select(absenceFields).eq("club_tag",club)
    .is("cancelled_at",null).lte("starts_at",now).gt("ends_at",now).order("ends_at").limit(200);
  administrationFailure(error); return (data || []).map(row=>project(row,absenceFields));
}
export async function loadMemberAdministration(value: unknown, cursor: string | null): Promise<MemberAdministration> {
  const tag = memberTag(value), club = await currentAdministrationClub();
  let query = supabaseAdmin.from("member_decision_log").select(decisionFields).eq("club_tag",club).eq("player_tag",tag)
    .order("created_at",{ascending:false}).order("id",{ascending:false}).limit(51);
  if (cursor) {
    try {
      const {at,id}=administrationCursor(cursor);
      query=query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
    } catch { throw new AdministrationInputError("Invalid decision cursor"); }
  }
  const results=await Promise.all([
    query,
    supabaseAdmin.from("member_absences").select(absenceFields).eq("club_tag",club).eq("player_tag",tag).order("created_at",{ascending:false}).limit(50),
    supabaseAdmin.from("membership_change_events").select("id,occurred_at,source").eq("club_tag",club).eq("player_tag",tag).eq("event_type","leave").order("occurred_at",{ascending:false}).order("id",{ascending:false}).limit(101),
  ]);
  for(const result of results) administrationFailure(result.error);
  const decisions=(results[0].data || []).slice(0,50).map(row=>project<MemberDecision>(row,decisionFields)), tail=decisions.at(-1);
  const departureDates=new Map((results[2].data||[]).map(row=>[row.id,row.occurred_at]));
  const missing=[...new Set(decisions.flatMap(row=>row.departure_event_id&&!departureDates.has(row.departure_event_id)?[row.departure_event_id]:[]))];
  if(missing.length){
    const {data,error}=await supabaseAdmin.from("membership_change_events").select("id,occurred_at").eq("club_tag",club).eq("player_tag",tag).eq("event_type","leave").in("id",missing);
    administrationFailure(error);for(const row of data||[])departureDates.set(row.id,row.occurred_at);
  }
  for(const row of decisions)row.departure_occurred_at=row.departure_event_id?departureDates.get(row.departure_event_id)??null:null;
  return { decisions,nextCursor:(results[0].data?.length || 0)>50 && tail ? Buffer.from(JSON.stringify({at:tail.created_at,id:tail.id})).toString("base64url") : null,
    absences:(results[1].data || []).map(row=>project<MemberAbsence>(row,absenceFields)),
    departures:(results[2].data || []).slice(0,100).map(row=>project<DepartureChoice>(row,"id,occurred_at,source")),departuresLimited:(results[2].data?.length || 0)>100 };
}
export async function mutateMemberAdministration(value: unknown) {
  const row=objectInput(value); let result;
  if(row.action==="decision") {
    const kind=row.kind;
    if(!(decisionKinds as readonly unknown[]).includes(kind)) throw new AdministrationInputError("Choose a decision type.");
    if(kind!=="departure_reason" && row.departure_event_id != null || kind!=="correction" && row.corrects_id != null || kind!=="follow_up" && row.follow_up_at != null) throw new AdministrationInputError("Invalid decision fields");
    result=await supabaseAdmin.rpc("append_member_decision",{p_tag:memberTag(row.player_tag),p_kind:kind,p_body:textInput(row.body,1000,true),p_request_id:uuidInput(row.request_id),
      p_departure_event_id:kind==="departure_reason"?uuidInput(row.departure_event_id):null,p_corrects_id:kind==="correction"?uuidInput(row.corrects_id):null,
      p_follow_up_at:kind==="follow_up"?dateInput(row.follow_up_at):null});
  } else if(row.action==="absence") {
    const start=dateInput(row.starts_at), end=dateInput(row.ends_at);
    if(Date.parse(end)<=Date.parse(start) || Date.parse(end)-Date.parse(start)>90*86400000) throw new AdministrationInputError("Absence must end after its start and last at most 90 days.");
    result=await supabaseAdmin.rpc("declare_member_absence",{p_tag:memberTag(row.player_tag),p_start:start,p_end:end,p_reason:textInput(row.reason??"",500),p_request_id:uuidInput(row.request_id)});
  } else if(row.action==="cancel_absence") {
    result=await supabaseAdmin.rpc("cancel_member_absence",{p_id:uuidInput(row.id)});
  } else throw new AdministrationInputError("Invalid administration action");
  administrationFailure(result.error); return { success:true };
}
