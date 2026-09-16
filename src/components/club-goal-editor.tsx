"use client";
import { useState } from "react";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { goalCycles,goalMetrics,type GoalCycle,type GoalMetric,type PlanningResponse } from "@/lib/club-planning-types";
import { goalCycleLabels,goalMetricLabels,inputDate,usePlanningMutation } from "@/lib/club-planning-client";
export function ClubGoalEditor({onSaved,onCancel}:{onSaved:(id:string)=>void;onCancel:()=>void}){
  const {t}=useI18n(),[title,setTitle]=useState(""),[metric,setMetric]=useState<GoalMetric>("trophies"),[cycle,setCycle]=useState<GoalCycle>("weekly"),[end,setEnd]=useState(""),[target,setTarget]=useState("");
  const {save,busy,error}=usePlanningMutation(onSaved);
  return <form className="rounded-lg border bg-card p-4 space-y-4" onSubmit={event=>{event.preventDefault();void save({action:"create_goal",title,metric,cycle,endsAt:cycle==="custom"?inputDate(end):null,target:Number(target)});}}>
    <fieldset disabled={busy} className="space-y-4"><h2 className="text-xl font-semibold">{t("Create a club goal")}</h2><p className="text-sm text-muted-foreground">{t("Goals start when saved. The current roster and trophy baseline are frozen; later arrivals do not change the target.")}</p>
    <label className="block text-sm">{t("Goal title")}<Input required maxLength={100} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">{t("Goal metric")}<select className="mt-1 block w-full rounded border bg-background p-2" value={metric} onChange={e=>setMetric(e.target.value as GoalMetric)}>{goalMetrics.map(k=><option key={k} value={k}>{t(goalMetricLabels[k])}</option>)}</select></label>
      <label className="block text-sm">{t("Goal period")}<select className="mt-1 block w-full rounded border bg-background p-2" value={cycle} onChange={e=>setCycle(e.target.value as GoalCycle)}>{goalCycles.map(k=><option key={k} value={k}>{t(goalCycleLabels[k])}</option>)}</select></label>
      <label className="block text-sm">{t("Target")}<Input required type="number" min={1} max={metric==="participants"?30:50000000} value={target} onChange={e=>setTarget(e.target.value)}/></label>
      {cycle==="custom"&&<label className="block text-sm">{t("Ends at")}<Input required type="datetime-local" dir="ltr" value={end} onChange={e=>setEnd(e.target.value)}/></label>}
    </div>
    <p className="text-xs text-muted-foreground">{t(metric==="trophies"?"Uses saved account trophy balances for the original members, not a sum of battle rewards. Departed members keep their latest known contribution.":"Counts original members with at least one observed battle during the goal. Missing battle logs can undercount participation.")}</p>
    <p className="text-xs text-muted-foreground">{t("The target, dates and roster cannot be edited later. Archive and create a new goal to change them.")}</p>
    {error&&<p role="alert" className="text-destructive text-sm">{t(error)}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={busy}>{t("Create goal")}</Button><Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{t("Cancel")}</Button></div></fieldset>
  </form>;
}
export function ClubGoalDetails({data,onArchived}:{data:PlanningResponse;onArchived:()=>void}){
  const {t,number,dateTime}=useI18n(),{save,busy,error}=usePlanningMutation(onArchived),detail=data.goalDetail,goal=data.goals.find(g=>g.id===detail?.id);
  if(!detail||!goal)return null;
  return <section className="border rounded-lg p-4 space-y-4"><h2 className="text-xl font-semibold">{goal.title} · {t("Frozen roster")}</h2>
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{detail.members.map(m=><article key={m.playerTag} className="border rounded p-3 text-sm space-y-1"><p className="font-medium break-words">{m.playerName} {m.departed&&<span className="text-muted-foreground">· {t("Former member")}</span>}</p><p dir="ltr" className="text-xs text-muted-foreground">{m.playerTag}</p>{goal.metric==="trophies"?<p>{t("Baseline")}: {m.baselineTrophies===null?t("Unknown"):number(m.baselineTrophies)} · {t("Latest observed")}: {m.latestTrophies===null?t("Unknown"):number(m.latestTrophies)}</p>:<p>{t(m.participated?"Participation observed":"No participation observed")}</p>}{m.latestAt&&<p className="text-xs text-muted-foreground">{dateTime(m.latestAt)}</p>}{m.possibleGap&&<p className="text-amber-600">{t("Possible battle gap")}</p>}</article>)}</div>
    <details><summary className="cursor-pointer font-medium">{t("Daily progress observations")}</summary><p className="my-2 text-xs text-muted-foreground">{t("One saved observation per UTC day. This is not a reconstruction of every change.")}</p><ol className="max-h-64 overflow-auto space-y-2 text-sm">{detail.snapshots.map(s=><li key={s.day} className="flex flex-wrap justify-between gap-2 border-b py-2"><span>{dateTime(s.observedAt)}</span><span>{s.progress===null?t("Unknown"):number(s.progress)} / {number(goal.target)}{s.limited?` · ${t("Limited observations")}`:""}</span></li>)}</ol></details>
    {error&&<p role="alert" className="text-destructive">{t(error)}</p>}
    {goal.status==="active"&&<Button variant="outline" disabled={busy} onClick={()=>void save({action:"archive_goal",id:goal.id,version:goal.version})}>{t("Archive goal")}</Button>}
  </section>;
}
