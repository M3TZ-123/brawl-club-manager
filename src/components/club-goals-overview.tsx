"use client";
import Link from "next/link";
import { useEffect,useState } from "react";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { goalMetricLabels,usePlanningResource } from "@/lib/club-planning-client";
import type { PlanningGoal } from "@/lib/club-planning-types";
export function ClubGoalCard({goal,onDetails}:{goal:PlanningGoal;onDetails?:()=>void}){
  const {t,number,dateTime}=useI18n();
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60000);return()=>clearInterval(timer);},[]);
  const ended=Date.parse(goal.endsAt)<=now,progress=goal.progress;
  return <article className="rounded-lg border bg-card p-4 space-y-3 min-w-0">
    <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold break-words">{goal.title}</h3><span className="text-xs text-muted-foreground">{t(goal.status==="archived"?"Archived":ended?"Ended":"In progress")}</span></div>
    <p className="text-sm text-muted-foreground">{t(goalMetricLabels[goal.metric])}</p>
    <p className="text-xl font-bold tabular-nums">{progress===null?t("Unknown"):number(progress)} <span className="text-sm font-normal text-muted-foreground">/ {number(goal.target)}</span></p>
    {progress!==null&&<progress className="w-full h-2 accent-primary" aria-label={t("Goal progress")} value={Math.max(0,Math.min(progress,goal.target))} max={goal.target}/>}
    <p className="text-xs text-muted-foreground">{t("Ends at")}: {dateTime(goal.endsAt)}</p>
    {goal.achievedAt&&<p className="text-sm text-emerald-600 dark:text-emerald-400">{t("Target reached in observed data")}</p>}
    {(goal.limited||goal.possibleGap)&&<p className="text-sm text-amber-700 dark:text-amber-400">{t("Progress may be incomplete")}</p>}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("Dates and progress details")}</summary><div className="mt-2 space-y-2"><p>{t("Frozen roster: {count} members",{count:number(goal.cohortCount)})}</p><p>{t("Starts at")}: {dateTime(goal.startsAt)}</p>
      {goal.achievedAt&&<p>{t("Target first observed reached")}: {dateTime(goal.achievedAt)}</p>}
      {(goal.limited||goal.possibleGap)&&<p>{t(goal.metric==="participants"?(goal.possibleGap?"Possible battle gaps overlap this goal. Observed participation is a lower bound.":"Some battle observations are missing or stale. Participation may be undercounted."):"Limited observations. Missing or stale balances are not counted as zero.")}</p>}
      {goal.refreshedAt&&<p>{t("Progress checked")}: {dateTime(goal.refreshedAt)}</p>}
    </div></details>
    {onDetails&&<Button type="button" variant="outline" size="sm" onClick={onDetails}>{t("Goal details")}</Button>}
  </article>;
}
export function ClubGoalsOverview({hideWhenEmpty=false}:{hideWhenEmpty?:boolean}={}){
  const {t}=useI18n(),{data,error,loading,reload}=usePlanningResource("/api/club-planning?overview=1&public=1");
  useEffect(()=>{const update=()=>{void reload();};window.addEventListener("club-data-updated",update);return()=>window.removeEventListener("club-data-updated",update);},[reload]);
  if(loading)return null;
  if(hideWhenEmpty&&data&&!data.goals.length&&!error&&!data.refreshDeferred)return null;
  return <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{t("Club goals")}</h2><Link href="/club-planning" className="text-sm text-primary underline">{t("Goals and events")}</Link></div>
    {data?.refreshDeferred&&<p className="text-sm text-amber-600">{t("Progress refresh delayed. Showing the last saved observations.")}</p>}
    {error?<p className="text-sm text-muted-foreground">{t(error)}</p>:!data?.goals.length?<p className="text-sm text-muted-foreground">{t("No club goals have been set yet.")}</p>:<div className="grid gap-3 md:grid-cols-2">{data.goals.slice(0,4).map(goal=><ClubGoalCard key={goal.id} goal={goal}/>)}</div>}
  </section>;
}
