"use client";
import Link from "next/link";
import { useState } from "react";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { attendanceLabels,eventKindLabels,inputDate,localDateInput,usePlanningMutation } from "@/lib/club-planning-client";
import { eventKinds,type EventEntry,type EventFields,type PlanningEvent,type PlanningResponse } from "@/lib/club-planning-types";
const selectClass="mt-1 block w-full min-w-0 rounded border bg-background p-2";
export function ClubEventEditor({event,data,onSaved,onCancel,onReload}:{event:PlanningEvent|null;data:PlanningResponse;onSaved:(id:string)=>void;onCancel:()=>void;onReload?:()=>void}){
  const {t,number,dateTime}=useI18n();
  const [fields,setFields]=useState<EventFields>(()=>event?{title:event.title,kind:event.kind,cycleLabel:event.cycleLabel,startsAt:event.startsAt,endsAt:event.endsAt,teamSize:event.teamSize,ticketAllowance:event.ticketAllowance,status:event.status,notes:event.notes||""}:{title:"",kind:"custom",cycleLabel:"",startsAt:"",endsAt:"",teamSize:3,ticketAllowance:null,status:"planned",notes:""});
  const [entries,setEntries]=useState<EventEntry[]>(()=>data.eventDetail?.entries.map(({playerTag,team,slot,attendance,wins,ticketsRemaining,observedAt,notes})=>({playerTag,team,slot,attendance,wins,ticketsRemaining,observedAt,notes}))||[]);
  const [reason,setReason]=useState(""),[addTag,setAddTag]=useState(""),[lastAdded,setLastAdded]=useState("");
  const {save,busy,error}=usePlanningMutation(onSaved);
  const locked=Boolean(event&&data.eventDetail?.entries.some(e=>e.wins!==null||e.ticketsRemaining!==null||e.attendance==="present"||e.attendance==="absent"));
  const hasDraftResults=entries.some(entry=>entry.wins!==null||entry.ticketsRemaining!==null);
  const nameFor=(tag:string)=>data.roster?.find(p=>p.tag===tag)?.name||data.eventDetail?.entries.find(p=>p.playerTag===tag)?.playerName||tag;
  const updateEntry=(index:number,patch:Partial<EventEntry>)=>setEntries(rows=>rows.map((row,i)=>i===index?{...row,...patch}:row));
  const available=(data.roster||[]).filter(p=>!entries.some(e=>e.playerTag===p.tag));
  const nullable=(value:string)=>value===""?null:Number(value);
  const needsCorrection=Boolean(data.eventDetail?.entries.some(previous=>{
    if(previous.wins===null&&previous.ticketsRemaining===null&&previous.attendance!=="present"&&previous.attendance!=="absent")return false;
    const current=entries.find(entry=>entry.playerTag===previous.playerTag);
    return !current||current.wins!==previous.wins||current.ticketsRemaining!==previous.ticketsRemaining||current.attendance!==previous.attendance;
  }));
  return <form className="border rounded-lg p-4 bg-card space-y-4 min-w-0" onInvalidCapture={e=>{let section=e.target instanceof HTMLElement?e.target.parentElement:null;while(section&&section!==e.currentTarget){if(section instanceof HTMLDetailsElement)section.open=true;section=section.parentElement;}}} onSubmit={e=>{e.preventDefault();void save({action:"save_event",id:event?.id||null,version:event?.version||0,event:fields,entries,reason});}}>
    <h2 className="text-xl font-semibold">{t(event?"Edit club event":"Plan a club event")}</h2>
    <p className="text-sm text-muted-foreground">{t("Set the date first. Add teams and record attendance when ready.")}</p>
    <p className="text-xs text-muted-foreground">{t("Attendance and results are private manual records.")}</p>
    <fieldset disabled={busy} className="space-y-4 min-w-0">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">{t("Event title")}<Input required maxLength={100} value={fields.title} onChange={e=>setFields({...fields,title:e.target.value})}/></label>
        <label className="block text-sm">{t("Event type")}<select className={selectClass} value={fields.kind} disabled={locked||hasDraftResults} onChange={e=>{if(!locked&&!hasDraftResults)setFields({...fields,kind:e.target.value as EventFields["kind"],ticketAllowance:e.target.value==="mega_pig"?fields.ticketAllowance:null});}}>{eventKinds.map(k=><option key={k} value={k}>{t(eventKindLabels[k])}</option>)}</select></label>
        <label className="block text-sm">{t("Cycle or edition")}<Input required disabled={locked} maxLength={80} value={fields.cycleLabel} onChange={e=>setFields({...fields,cycleLabel:e.target.value})}/></label>
        <label className="block text-sm">{t("Starts at")}<Input required type="datetime-local" dir="ltr" disabled={locked} value={localDateInput(fields.startsAt)} onChange={e=>setFields({...fields,startsAt:inputDate(e.target.value)||""})}/></label>
        <label className="block text-sm">{t("Ends at")}<Input required type="datetime-local" dir="ltr" disabled={locked} value={localDateInput(fields.endsAt)} onChange={e=>setFields({...fields,endsAt:inputDate(e.target.value)||""})}/></label>
      </div>
      {locked&&<p className="text-xs text-muted-foreground">{t("Recorded results lock the cycle and dates. Create a new event for the next cycle.")}</p>}
      {!locked&&hasDraftResults&&<p className="text-xs text-muted-foreground">{t("Clear the manual wins and tickets before changing the event type.")}</p>}
      <details className="rounded-lg border p-3" open={entries.length>0}><summary className="cursor-pointer font-medium">{t("Teams and attendance")} · {number(entries.length)}</summary><div className="mt-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">{t("Starters per team")}<Input required type="number" min={1} max={30} value={fields.teamSize} onChange={e=>setFields({...fields,teamSize:Number(e.target.value)})}/></label>
        {fields.kind==="mega_pig"&&<label className="block text-sm">{t("Tickets per member, if known")}<Input type="number" min={0} max={1000} value={fields.ticketAllowance??""} onChange={e=>setFields({...fields,ticketAllowance:nullable(e.target.value)})}/></label>}</div>
      <div className="flex flex-wrap gap-2 items-end"><label className="text-sm flex-1 min-w-40">{t("Add a member")}<select value={addTag} className={selectClass} onChange={e=>setAddTag(e.target.value)}><option value="">{t("Choose a member")}</option>{available.map(p=><option key={p.tag} value={p.tag}>{p.name} ({p.tag})</option>)}</select></label><Button type="button" variant="outline" disabled={!addTag||entries.length>=30} onClick={()=>{setEntries([...entries,{playerTag:addTag,team:1,slot:"starter",attendance:"invited",wins:null,ticketsRemaining:null,observedAt:null,notes:""}]);setLastAdded(addTag);setAddTag("");}}>{t("Add")}</Button></div>
      <div className="space-y-2">{entries.map((entry,index)=><details key={entry.playerTag} className="rounded-md border p-3 min-w-0" open={entry.playerTag===lastAdded}>
        <summary className="cursor-pointer text-sm"><span className="font-semibold break-words">{nameFor(entry.playerTag)}</span><span className="text-muted-foreground"> · {t("Team {number}",{number:number(entry.team)})} · {t(attendanceLabels[entry.attendance])}</span></summary><div className="mt-3 space-y-3">
        <div className="flex flex-wrap gap-2 justify-between items-center"><p dir="ltr" className="text-xs text-muted-foreground">{entry.playerTag}</p><Button size="sm" type="button" variant="ghost" onClick={()=>setEntries(rows=>rows.filter(row=>row.playerTag!==entry.playerTag))} aria-label={t("Remove {name} from event",{name:nameFor(entry.playerTag)})}>{t("Remove")}</Button></div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">{t("Team number")}<Input type="number" required min={1} max={30} value={entry.team} onChange={e=>updateEntry(index,{team:Number(e.target.value)})}/></label>
          <label className="text-sm">{t("Team place")}<select className={selectClass} value={entry.slot} onChange={e=>updateEntry(index,{slot:e.target.value as EventEntry["slot"]})}><option value="starter">{t("Starter")}</option><option value="substitute">{t("Substitute")}</option></select></label>
          <label className="text-sm">{t("Manual attendance")}<select className={selectClass} value={entry.attendance} onChange={e=>updateEntry(index,{attendance:e.target.value as EventEntry["attendance"]})}>{Object.entries(attendanceLabels).map(([k,label])=><option value={k} key={k}>{t(label)}</option>)}</select></label>
          {fields.kind==="mega_pig"&&<><label className="text-sm">{t("Manual wins")}<Input type="number" min={0} max={1000} value={entry.wins??""} onChange={e=>updateEntry(index,{wins:nullable(e.target.value)})}/></label><label className="text-sm">{t("Manual tickets remaining")}<Input type="number" min={0} max={fields.ticketAllowance??1000} value={entry.ticketsRemaining??""} onChange={e=>updateEntry(index,{ticketsRemaining:nullable(e.target.value)})}/></label></>}
          <label className="text-sm">{t("Observed at")}<Input type="datetime-local" dir="ltr" required={entry.wins!==null||entry.ticketsRemaining!==null||entry.attendance==="present"||entry.attendance==="absent"} min={localDateInput(fields.startsAt)} max={localDateInput(fields.endsAt)} value={localDateInput(entry.observedAt)} onChange={e=>updateEntry(index,{observedAt:inputDate(e.target.value)})}/></label>
        </div>
        <label className="block text-sm">{t("Private member note")}<Input maxLength={500} value={entry.notes} onChange={e=>updateEntry(index,{notes:e.target.value})}/></label>
      </div></details>)}</div>
      {fields.kind==="mega_pig"&&<p className="text-xs text-muted-foreground">{t("Leave unknown results blank. Zero means explicitly recorded zero; these values are not verified by the game API.")}</p>}
      <details className="text-sm"><summary className="cursor-pointer text-primary">{t("Help choosing teams")}</summary><div className="mt-2 flex flex-wrap gap-3"><Link className="text-primary underline" href="/readiness" target="_blank" rel="noopener">{t("Check brawler readiness")}</Link><Link className="text-primary underline" href="/analysis" target="_blank" rel="noopener">{t("Review observed teammate records")}</Link></div><p className="mt-2 text-xs text-muted-foreground">{t("Use these records to plan together. They do not predict the best team.")}</p></details>
      </div></details>
      <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t("Private notes and event status")}</summary><div className="mt-3 space-y-3"><label className="block text-sm">{t("Private event notes")}<textarea rows={2} maxLength={1000} className={selectClass} value={fields.notes} onChange={e=>setFields({...fields,notes:e.target.value})}/></label><label className="block text-sm">{t("Status")}<select className={selectClass} value={fields.status} onChange={e=>setFields({...fields,status:e.target.value as EventFields["status"]})}>{["planned","completed","cancelled"].map(k=><option key={k} value={k}>{t(k==="planned"?"Planned":k==="completed"?"Completed":"Cancelled")}</option>)}</select></label></div></details>
      {event&&needsCorrection&&<label className="block text-sm">{t("Reason for correction")}<Input required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/><span className="text-xs text-muted-foreground">{t("Required when changing or removing recorded attendance or results.")}</span></label>}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("Event guidance")}</summary><div className="mt-2 space-y-2"><p>{t("Dates use your device timezone. An event can last up to 31 days; each cycle needs its own event.")}</p><p>{t("Only the title, cycle, dates, event type and team settings appear publicly.")}</p></div></details>
      {error&&<div role="alert" className="space-y-2"><p className="text-destructive text-sm">{t(error)}</p>{onReload&&<Button type="button" variant="outline" onClick={onReload}>{t("Discard draft and reload saved event")}</Button>}</div>}
      <div className="flex flex-wrap gap-2"><Button>{t("Save event")}</Button><Button type="button" variant="outline" onClick={onCancel}>{t("Cancel")}</Button></div>
    </fieldset>
    {!!data.eventDetail?.revisions.length&&<details><summary className="cursor-pointer text-sm font-medium">{t("Saved event revisions")}</summary><p className="text-xs text-muted-foreground my-2">{t("The latest 20 saved revisions are kept privately.")}</p><div className="max-h-80 overflow-auto space-y-3">{data.eventDetail.revisions.map(revision=><details key={revision.version} className="border rounded p-3 text-sm"><summary className="cursor-pointer">{t("Revision {number}",{number:number(revision.version)})} · {dateTime(revision.savedAt)}</summary><p className="my-2 whitespace-pre-wrap break-words">{revision.reason||t("No correction reason recorded")}</p><p>{revision.event.title} · {revision.event.cycleLabel}</p><ul className="mt-2 space-y-1">{revision.entries.map(e=><li key={e.playerTag}>{nameFor(e.playerTag)} · {t("Team {number}",{number:number(e.team)})} · {t(e.slot==="starter"?"Starter":"Substitute")} · {t(attendanceLabels[e.attendance])}{e.wins!==null?` · ${t("Manual wins")}: ${number(e.wins)}`:""}{e.ticketsRemaining!==null?` · ${t("Manual tickets remaining")}: ${number(e.ticketsRemaining)}`:""}{e.observedAt?` · ${dateTime(e.observedAt)}`:""}{e.notes&&<p className="text-muted-foreground whitespace-pre-wrap break-words">{e.notes}</p>}</li>)}</ul></details>)}</div></details>}
  </form>;
}
