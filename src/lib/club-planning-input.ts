import { eventKinds, goalCycles, goalMetrics, type EventEntry, type EventFields, type PlanningMutation } from "@/lib/club-planning-types";
export class PlanningInputError extends Error { constructor(message:string, public readonly status=400){super(message);} }
export const planningUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail():never {throw new PlanningInputError("Check the planning fields and try again.");}
function obj(value:unknown,keys:string[]) {if(!value||typeof value!=="object"||Array.isArray(value))return fail();const row=value as Record<string,unknown>;if(Object.keys(row).some(k=>!keys.includes(k)))fail();return row;}
function text(value:unknown,max:number,required=false) {if(typeof value!=="string"||value.length>max||value.includes("\0")||(required&&!value.trim()))return fail();return value.trim();}
function integer(value:unknown,min:number,max:number) {if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)return fail();return value as number;}
function choice<T extends string>(value:unknown,options:readonly T[]):T {if(typeof value!=="string"||!options.includes(value as T))return fail();return value as T;}
function date(value:unknown):string {if(typeof value!=="string"||value.length>40||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,6})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))return fail();if(new Date(`${value.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10)!==value.slice(0,10))return fail();return value;}
function nullableInteger(value:unknown) {return value===null?null:integer(value,0,1000);}
export function planningId(value:unknown) {if(typeof value!=="string"||!planningUuid.test(value))return fail();return value;}
export function planningInput(value:unknown,now=Date.now()):PlanningMutation {
  const body=obj(value,["action","title","metric","cycle","endsAt","target","id","version","event","entries","reason"]);
  if(body.action==="archive_goal") {obj(body,["action","id","version"]);return{action:"archive_goal",id:planningId(body.id),version:integer(body.version,1,2147483646)};}
  if(body.action==="create_goal") {
    obj(body,["action","title","metric","cycle","endsAt","target"]);
    const cycle=choice(body.cycle,goalCycles),endsAt=cycle==="custom"?date(body.endsAt):null;
    if(endsAt&&(Date.parse(endsAt)<=now||Date.parse(endsAt)>now+90*86400000))fail();
    return{action:"create_goal",title:text(body.title,100,true),metric:choice(body.metric,goalMetrics),cycle,endsAt,target:integer(body.target,1,50000000)};
  }
  if(body.action!=="save_event")return fail();
  obj(body,["action","id","version","event","entries","reason"]);
  const raw=obj(body.event,["title","kind","cycleLabel","startsAt","endsAt","teamSize","ticketAllowance","status","notes"]);
  const event:EventFields={title:text(raw.title,100,true),kind:choice(raw.kind,eventKinds),cycleLabel:text(raw.cycleLabel,80,true),startsAt:date(raw.startsAt),endsAt:date(raw.endsAt),teamSize:integer(raw.teamSize,1,30),ticketAllowance:nullableInteger(raw.ticketAllowance),status:choice(raw.status,["planned","completed","cancelled"]),notes:text(raw.notes,1000)};
  const start=Date.parse(event.startsAt),end=Date.parse(event.endsAt);
  if(end<=start||end>start+31*86400000||start>now+365*86400000||(body.id===null&&start<now-90*86400000)||(event.status==="completed"&&end>now)||(event.kind!=="mega_pig"&&event.ticketAllowance!==null))fail();
  if(!Array.isArray(body.entries)||body.entries.length>30)fail();
  const tags=new Set<string>(),teams=new Map<number,number>();
  const entries:EventEntry[]=(body.entries as unknown[]).map(value=>{
    const row=obj(value,["playerTag","team","slot","attendance","wins","ticketsRemaining","observedAt","notes"]),playerTag=text(row.playerTag,21,true);
    if(!/^#[A-Z0-9]{1,20}$/.test(playerTag)||tags.has(playerTag))fail();tags.add(playerTag);
    const entry:EventEntry={playerTag,team:integer(row.team,1,30),slot:choice(row.slot,["starter","substitute"]),attendance:choice(row.attendance,["invited","confirmed","present","absent"]),wins:nullableInteger(row.wins),ticketsRemaining:nullableInteger(row.ticketsRemaining),observedAt:row.observedAt===null?null:date(row.observedAt),notes:text(row.notes,500)};
    if(entry.slot==="starter"){const count=(teams.get(entry.team)||0)+1;teams.set(entry.team,count);if(count>event.teamSize)fail();}
    if(entry.observedAt&&(Date.parse(entry.observedAt)<start||Date.parse(entry.observedAt)>end||Date.parse(entry.observedAt)>now+300000))fail();
    if((entry.wins!==null||entry.ticketsRemaining!==null||["present","absent"].includes(entry.attendance))&&!entry.observedAt)fail();
    if((entry.wins!==null||entry.ticketsRemaining!==null)&&event.kind!=="mega_pig")fail();
    if(event.ticketAllowance!==null&&((entry.ticketsRemaining??0)>event.ticketAllowance||(entry.wins??0)+(entry.ticketsRemaining??0)>event.ticketAllowance))fail();
    return entry;
  });
  return{action:"save_event",id:body.id===null?null:planningId(body.id),version:integer(body.version,body.id===null?0:1,2147483646),event,entries,reason:text(body.reason,500)};
}
