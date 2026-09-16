"use client";
import Link from "next/link";
import { useEffect,useState } from "react";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { AdminGate } from "@/components/admin-gate";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { ClubGoalCard } from "@/components/club-goals-overview";
import { ClubGoalEditor,ClubGoalDetails } from "@/components/club-goal-editor";
import { ClubEventEditor } from "@/components/club-event-editor";
import { useAdminSession } from "@/hooks/use-admin-session";
import { eventKindLabels,usePlanningResource } from "@/lib/club-planning-client";
import type { PlanningResponse } from "@/lib/club-planning-types";
function PlanningDetail({kind,id,onClose,onSaved}:{kind:"goal"|"event";id:string;onClose:()=>void;onSaved:()=>void}){
  const {t}=useI18n(),{data,error,loading,reload}=usePlanningResource(`/api/club-planning?${kind}=${encodeURIComponent(id)}`),[edition,setEdition]=useState(0);
  return <div className="space-y-3"><Button variant="outline" onClick={onClose}>{t("Close details")}</Button>{error&&<p role="alert" className="text-destructive">{t(error)}</p>}{loading?<p role="status">{t("Loading...")}</p>:data?(kind==="goal"?<ClubGoalDetails data={data} onArchived={onSaved}/>:<ClubEventEditor key={`${id}:${edition}`} event={data.events.find(e=>e.id===id)||null} data={data} onCancel={onClose} onSaved={onSaved} onReload={()=>{void reload().then(success=>{if(success)setEdition(v=>v+1);});}}/>):<Button onClick={()=>void reload()}>{t("Retry")}</Button>}</div>;
}
export function PlanningWorkspace({isAdmin}:{isAdmin:boolean}){
  const {t,number,dateTime}=useI18n(),{data,error,loading,reload}=usePlanningResource(`/api/club-planning${isAdmin?"":"?public=1"}`);
  const [creating,setCreating]=useState<"goal"|"event"|null>(null),[selected,setSelected]=useState<{kind:"goal"|"event";id:string}|null>(null),[showArchived,setShowArchived]=useState(false);
  useEffect(()=>{const update=()=>{void reload();};window.addEventListener("club-data-updated",update);window.addEventListener("focus",update);return()=>{window.removeEventListener("club-data-updated",update);window.removeEventListener("focus",update);};},[reload]);
  const saved=()=>{setCreating(null);setSelected(null);void reload();};
  const blank:PlanningResponse={goals:[],events:[],roster:data?.roster||[]};
  const goals=(data?.goals||[]).filter(g=>showArchived||g.status!=="archived");
  return <div className="space-y-6 min-w-0"><header><h1 className="text-3xl font-bold">{t("Goals and events")}</h1><p className="mt-2 text-muted-foreground">{t("Set shared goals and plan club events with a clear record of what is known.")}</p></header>
    <div className="flex flex-wrap gap-2">{isAdmin?<><Button disabled={!data} onClick={()=>{setSelected(null);setCreating("goal");}}>{t("Create goal")}</Button><Button variant="outline" disabled={!data} onClick={()=>{setSelected(null);setCreating("event");}}>{t("Plan event")}</Button></>:<Link className="text-primary underline text-sm" href="#planning-admin">{t("Sign in to plan goals and events")}</Link>}<Button variant="ghost" disabled={loading} onClick={()=>void reload()}>{t("Refresh")}</Button></div>
    {error&&<p role="alert" className="text-destructive">{t(error)}</p>}{loading&&<p role="status">{t("Loading...")}</p>}
    {data?.refreshDeferred&&<p role="status" className="text-sm text-amber-600">{t("Progress refresh delayed. Showing the last saved observations.")}</p>}
    {isAdmin&&creating==="goal"&&<ClubGoalEditor onSaved={saved} onCancel={()=>setCreating(null)}/>}
    {isAdmin&&creating==="event"&&<ClubEventEditor event={null} data={blank} onSaved={saved} onCancel={()=>setCreating(null)}/>}
    {isAdmin&&selected&&<PlanningDetail key={`${selected.kind}:${selected.id}`} {...selected} onClose={()=>setSelected(null)} onSaved={saved}/>}
    <section className="space-y-3"><div className="flex flex-wrap gap-3 justify-between items-center"><h2 className="text-xl font-semibold">{t("Club goals")}</h2><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/>{t("Show archived")}</label></div>
      <p className="text-sm text-muted-foreground">{t("Goals retain their original roster, including members who leave. Battle participation is observed activity, not online time.")}</p>
      {!loading&&!goals.length&&<p className="rounded border p-6 text-muted-foreground">{t("No club goals have been set yet.")}</p>}
      <div className="grid gap-3 md:grid-cols-2">{goals.map(goal=><ClubGoalCard key={goal.id} goal={goal} onDetails={isAdmin?()=>{setCreating(null);setSelected({kind:"goal",id:goal.id});}:undefined}/>)}</div>
    </section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">{t("Planned club events")}</h2>{!loading&&!data?.events.length&&<p className="rounded border p-6 text-muted-foreground">{t("No club events have been planned yet.")}</p>}<div className="grid gap-3 md:grid-cols-2">{data?.events.map(event=><article className="border rounded-lg p-4 space-y-2 min-w-0" key={event.id}><div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold break-words">{event.title}</h3><span className="text-xs text-muted-foreground">{t(event.status==="planned"?"Planned":event.status==="completed"?"Completed":"Cancelled")}</span></div><p className="text-sm">{t(eventKindLabels[event.kind])} · {event.cycleLabel}</p><p className="text-sm text-muted-foreground">{dateTime(event.startsAt)} – {dateTime(event.endsAt)}</p><p className="text-xs text-muted-foreground">{t("Starters per team")}: {number(event.teamSize)}{event.ticketAllowance!==null?` · ${t("Tickets per member, if known")}: ${number(event.ticketAllowance)}`:""}</p>{isAdmin&&<Button variant="outline" size="sm" onClick={()=>{setCreating(null);setSelected({kind:"event",id:event.id});}}>{t("Teams, attendance and results")}</Button>}</article>)}</div></section>
    {!isAdmin&&<div id="planning-admin"><AdminGate title="Plan club goals and events" description="Sign in to save goals, teams and private event results."><span/></AdminGate></div>}
  </div>;
}
export default function ClubPlanningPage(){const {isAdmin}=useAdminSession();return <LayoutWrapper><PlanningWorkspace key={isAdmin?"admin":"public"} isAdmin={isAdmin}/></LayoutWrapper>;}
