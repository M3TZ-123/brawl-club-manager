"use client";
import { Suspense,useEffect,useState } from "react";
import { useSearchParams } from "next/navigation";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { AdminGate } from "@/components/admin-gate";
import { T,useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { ClubEventEditor } from "@/components/club-event-editor";
import { MegaPigSourcePanel } from "@/components/mega-pig-source-panel";
import { MegaPigArchivePanel } from "@/components/mega-pig-archive-panel";
import { useAdminSession } from "@/hooks/use-admin-session";
import { eventKindLabels,usePlanningResource } from "@/lib/club-planning-client";
import type { PlanningResponse } from "@/lib/club-planning-types";
function EventDetail({id,onClose,onSaved}:{id:string;onClose:()=>void;onSaved:()=>void}){
  const {t}=useI18n(),{data,error,loading,reload}=usePlanningResource(`/api/club-planning?event=${encodeURIComponent(id)}`),[edition,setEdition]=useState(0);
  return <div className="space-y-3">{!data&&<Button variant="outline" onClick={onClose}>{t("Back to planning")}</Button>}{error&&<p role="alert" className="text-destructive">{t(error)}</p>}{loading?<p role="status">{t("Loading...")}</p>:data?<ClubEventEditor key={`${id}:${edition}`} event={data.events.find(e=>e.id===id)||null} data={data} onCancel={onClose} onSaved={onSaved} onReload={()=>{void reload().then(success=>{if(success)setEdition(v=>v+1);});}}/>:<Button onClick={()=>void reload()}>{t("Retry")}</Button>}</div>;
}
export function PlanningWorkspace({isAdmin,linkedPlayer=""}:{isAdmin:boolean;linkedPlayer?:string}){
  const {t,number,dateTime}=useI18n(),{data,error,loading,reload}=usePlanningResource(`/api/club-planning${isAdmin?"":"?public=1"}`);
  const [creating,setCreating]=useState(false),[selected,setSelected]=useState<string|null>(null);
  useEffect(()=>{if(isAdmin&&linkedPlayer)document.getElementById("mega-pig-history")?.scrollIntoView({block:"start"});},[isAdmin,linkedPlayer]);
  useEffect(()=>{const update=()=>{void reload();};window.addEventListener("club-data-updated",update);window.addEventListener("focus",update);return()=>{window.removeEventListener("club-data-updated",update);window.removeEventListener("focus",update);};},[reload]);
  const saved=()=>{setCreating(false);setSelected(null);void reload();};
  const blank:PlanningResponse={events:[],roster:data?.roster||[]};
  const editing=isAdmin&&Boolean(creating||selected);
  return <div className="space-y-5 min-w-0"><header><h1 className="text-3xl font-bold">{t("Club events")}</h1><p className="mt-2 text-sm text-muted-foreground">{t("Follow Mega Pig and organize club events.")}</p></header>
    {!editing&&<div className="flex flex-wrap justify-end gap-2">{isAdmin&&<Button disabled={!data} onClick={()=>setCreating(true)}>{t("Plan event")}</Button>}<Button variant="ghost" disabled={loading} onClick={()=>void reload()}>{t("Refresh")}</Button></div>}
    {error&&<p role="alert" className="text-destructive">{t(error)}</p>}{loading&&<p role="status">{t("Loading...")}</p>}
    {isAdmin&&!editing&&<MegaPigSourcePanel/>}
    {isAdmin&&!editing&&<MegaPigArchivePanel initialPlayerTag={linkedPlayer}/>}
    {isAdmin&&creating&&<ClubEventEditor event={null} data={blank} onSaved={saved} onCancel={()=>setCreating(false)}/>}
    {isAdmin&&selected&&<EventDetail key={selected} id={selected} onClose={()=>setSelected(null)} onSaved={saved}/>}
    {!editing&&<section className="space-y-3"><h2 className="text-xl font-semibold">{t("Planned club events")}</h2>{!loading&&!error&&!data?.events.length&&<p className="rounded border border-dashed p-5 text-sm text-muted-foreground">{t("No club events have been planned yet.")}</p>}<div className="grid gap-3 md:grid-cols-2">{data?.events.map(event=><article className="border rounded-lg p-4 space-y-3 min-w-0" key={event.id}><div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold break-words">{event.title}</h3><span className="text-xs text-muted-foreground">{t(event.status==="planned"?"Planned":event.status==="completed"?"Completed":"Cancelled")}</span></div><p className="text-sm">{t(eventKindLabels[event.kind])} · {event.cycleLabel}</p><p className="text-sm text-muted-foreground">{dateTime(event.startsAt)} – {dateTime(event.endsAt)}</p><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("Event settings")}</summary><p className="mt-2">{t("Starters per team")}: {number(event.teamSize)}{event.ticketAllowance!==null?` · ${t("Tickets per member, if known")}: ${number(event.ticketAllowance)}`:""}</p></details>{isAdmin&&<Button variant="outline" size="sm" onClick={()=>setSelected(event.id)}>{t("Teams, attendance and results")}</Button>}</article>)}</div></section>}
    {!isAdmin&&<details id="planning-admin" open={Boolean(linkedPlayer)} className="text-sm"><summary className="cursor-pointer text-primary">{t("Sign in to view Mega Pig and manage events")}</summary><AdminGate title="Manage club events" description="View Mega Pig history, organize teams and save event results."><span/></AdminGate></details>}
  </div>;
}
export function PlanningEntry(){
  const params=useSearchParams(),{isAdmin}=useAdminSession();
  const value=params.get("member")?.trim().replace(/^#/,"").toUpperCase()||"";
  const linkedPlayer=/^[0289PYLQGRJCUV]{2,19}$/.test(value)?`#${value}`:"";
  return <PlanningWorkspace key={`${isAdmin?"admin":"public"}:${linkedPlayer}`} isAdmin={isAdmin} linkedPlayer={linkedPlayer}/>;
}
export default function ClubPlanningPage(){return <LayoutWrapper><Suspense fallback={<p role="status"><T text="Loading..."/></p>}><PlanningEntry/></Suspense></LayoutWrapper>;}
