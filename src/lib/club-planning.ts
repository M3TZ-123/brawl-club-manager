import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { PlanningInputError, planningId, planningInput } from "@/lib/club-planning-input";
import type { EventEntry, EventFields, PlanningEvent, PlanningResponse } from "@/lib/club-planning-types";
type Row=Record<string,unknown>;
const eventColumns="id,title,kind,cycle_label,starts_at,ends_at,team_size,ticket_allowance,status,version,updated_at";
const numberOrNull=(v:unknown)=>v===null||v===undefined?null:Number(v);
const nullableText=(v:unknown)=>typeof v==="string"?v:null;
export function publicPlanningEvent(row:Row):PlanningEvent {return{id:String(row.id),title:String(row.title),kind:row.kind as PlanningEvent["kind"],cycleLabel:String(row.cycle_label),startsAt:String(row.starts_at),endsAt:String(row.ends_at),teamSize:Number(row.team_size),ticketAllowance:numberOrNull(row.ticket_allowance),status:row.status as PlanningEvent["status"],version:Number(row.version),updatedAt:String(row.updated_at)};}
function eventFields(row:Row):EventFields {return{title:String(row.title),kind:row.kind as EventFields["kind"],cycleLabel:String(row.cycleLabel),startsAt:String(row.startsAt),endsAt:String(row.endsAt),teamSize:Number(row.teamSize),ticketAllowance:numberOrNull(row.ticketAllowance),status:row.status as EventFields["status"],notes:String(row.notes||"")};}
function entryFields(row:Row):EventEntry {return{playerTag:String(row.playerTag),team:Number(row.team),slot:row.slot as EventEntry["slot"],attendance:row.attendance as EventEntry["attendance"],wins:numberOrNull(row.wins),ticketsRemaining:numberOrNull(row.ticketsRemaining),observedAt:nullableText(row.observedAt),notes:String(row.notes||"")};}
async function clubConfiguration(){const result=await supabaseAdmin.from("settings").select("key,value").in("key",["club_tag","last_roster_sync_time","last_sync_time"]);if(result.error)throw new Error("planning unavailable");const settings=Object.fromEntries((result.data||[]).map(row=>[row.key,row.value]));const value=settings.club_tag||process.env.CLUB_TAG;if(typeof value!=="string"||!/^#?[A-Z0-9]{1,20}$/i.test(value.trim().replace(/^%23/i,"#")))throw new PlanningInputError("Configure your club before planning.",409);const marker=settings.last_roster_sync_time||settings.last_sync_time;return{club:`#${value.trim().replace(/^%23/i,"#").replace(/^#/,"").toUpperCase()}`,rosterReady:typeof marker==="string"&&Number.isFinite(Date.parse(marker))&&Date.parse(marker)<=Date.now()};}
function databaseError(error:{code?:string;message?:string}|null){
  if(!error)return;
  if(error.code==="40001"&&error.message?.includes("planning_request_changed"))throw new PlanningInputError("This creation was already saved with different details. Check the events before creating another.",409);
  if(error.code==="40001")throw new PlanningInputError("Planning changed. Reload before saving. Your draft is preserved.",409);
  if(error.code==="54000")throw new PlanningInputError("Planning limit reached: 100 events.",409);
  if(error.message?.includes("planning_roster_not_ready"))throw new PlanningInputError("Sync the configured club before adding event members.",409);
  if(error.message?.includes("event_cycle_locked"))throw new PlanningInputError("Results already exist. Create a new event for a different cycle or dates.");
  if(error.message?.includes("correction_reason_required"))throw new PlanningInputError("Explain the correction before changing recorded attendance or results.");
  if(["22023","22P02","22007","22008","23514"].includes(error.code||""))throw new PlanningInputError("Check the planning fields and try again.");
  throw new Error("planning unavailable");
}
export async function readClubPlanning(isAdmin:boolean,options:{event?:string}={}):Promise<PlanningResponse>{
  const eventId=options.event?planningId(options.event):null;
  if(eventId&&!isAdmin)throw new PlanningInputError("Admin login required",401);
  const {club,rosterReady}=await clubConfiguration();
  const [events,roster]=await Promise.all([
    supabaseAdmin.from("club_planned_events").select(eventColumns+(isAdmin?",notes":"")).eq("club_tag",club).order("starts_at",{ascending:false}).limit(100),
    isAdmin&&rosterReady?supabaseAdmin.from("member_history").select("player_tag,player_name").eq("is_current_member",true).order("player_name").limit(30):Promise.resolve({data:[],error:null}),
  ]);
  for(const result of [events,roster])databaseError(result.error);
  const result:PlanningResponse={events:((events.data||[]) as unknown as Row[]).map(row=>({...publicPlanningEvent(row),...(isAdmin?{notes:String(row.notes||"")}:{})}))};
  if(isAdmin)result.roster=(roster.data||[]).map((row:Row)=>({tag:String(row.player_tag),name:String(row.player_name)}));
  if(eventId){
    if(!result.events.some(e=>e.id===eventId))throw new PlanningInputError("Planning record not found",404);
    const [entries,revisions]=await Promise.all([
      supabaseAdmin.from("club_event_entries").select("player_tag,player_name,team,slot,attendance,wins,tickets_remaining,observed_at,notes").eq("event_id",eventId).order("team").order("player_name").limit(30),
      supabaseAdmin.from("club_event_revisions").select("version,saved_at,reason,snapshot").eq("event_id",eventId).order("version",{ascending:false}).limit(20),
    ]);databaseError(entries.error);databaseError(revisions.error);
    result.eventDetail={id:eventId,entries:(entries.data||[]).map((r:Row)=>({...entryFields({playerTag:r.player_tag,team:r.team,slot:r.slot,attendance:r.attendance,wins:r.wins,ticketsRemaining:r.tickets_remaining,observedAt:r.observed_at,notes:r.notes}),playerName:String(r.player_name)})),revisions:(revisions.data||[]).map((r:Row)=>{const snapshot=r.snapshot as {event:Row;entries:Row[]};return{version:Number(r.version),savedAt:String(r.saved_at),reason:String(r.reason||""),event:eventFields(snapshot.event),entries:snapshot.entries.map(entryFields)};})};
  }
  return result;
}
export async function mutateClubPlanning(value:unknown){
  const input=planningInput(value),{club}=await clubConfiguration();
  if(input.request_id){
    const {request_id,...payload}=input;
    const result=await supabaseAdmin.rpc("club_planning_create_once",{p_club:club,p_request_id:request_id,p_payload:payload});
    databaseError(result.error);return{id:String(result.data)};
  }
  const result=await supabaseAdmin.rpc("club_planning_save_event",{p_club:club,p_id:input.id,p_version:input.version,p_event:input.event,p_entries:input.entries,p_reason:input.reason});databaseError(result.error);return{id:String(result.data)};
}
