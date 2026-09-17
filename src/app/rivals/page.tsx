"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Flag, Plus, X } from "lucide-react";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { useI18n } from "@/components/locale-provider";
import { useFeatureResource } from "@/components/use-feature-resource";
import { ClubTrendLine } from "@/components/club-trend-line";
import { Button } from "@/components/ui/button";
import { useAdminSession } from "@/hooks/use-admin-session";
import { invalidateJsonCache } from "@/lib/client-data-cache";
import { gameRegions, type GameRegion } from "@/lib/game-data";
import type { ClubRivalsResponse } from "@/lib/club-rivals-data";
import type { ClubIntelligenceResponse } from "@/lib/club-intelligence-types";
import { formatBrawlName, stripBrawlColorTags } from "@/lib/brawl-text";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";

const regions:Record<GameRegion,string>={global:"Global",TN:"Tunisia",DZ:"Algeria",MA:"Morocco",FR:"France",EG:"Egypt",SA:"Saudi Arabia",US:"United States"};
export default function RivalsPage(){
  const {t,number,dateTime}=useI18n(),{isAdmin}=useAdminSession();
  const [region,setRegion]=useState<GameRegion>("global"),[tag,setTag]=useState(""),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const [view,setView]=useState<"comparison"|"rankings">("comparison");
  const mounted=useRef(true),mutation=useRef<AbortController|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;mutation.current?.abort();};},[]);
  useEffect(()=>{if(!isAdmin)mutation.current?.abort();},[isAdmin]);
  const resource=useFeatureResource<ClubRivalsResponse>(`/api/club-rivals?region=${region}`,"roster,settings"),{data}=resource;
  const ownResource=useFeatureResource<ClubIntelligenceResponse>("/api/club-intelligence?range=7d","roster,settings");
  const own=ownResource.data?.club.tag===data?.clubTag?ownResource.data:null;
  async function save(value:string,active:boolean){
    if(!isAdmin||(mutation.current&&!mutation.current.signal.aborted))return;
    const current=new AbortController();mutation.current=current;
    setSaving(true);setError("");
    try{
      await fetchJsonWithTimeout("/api/club-rivals",{method:"POST",signal:current.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({tag:value,active})});
      if(current.signal.aborted||!mounted.current)return;
      invalidateJsonCache();if(active)setTag(draft=>draft===value?"":draft);await resource.reload();
    }catch(e){if(mounted.current&&!current.signal.aborted)setError(e instanceof Error?e.message:"Club comparison unavailable");}finally{if(mutation.current===current){mutation.current=null;if(mounted.current)setSaving(false);}}
  }
  const rows=data?[{tag:data.clubTag,name:formatBrawlName(own?.club.metadata?.name,t("Your club")),trophies:own?.club.rosterTrophies??null,count:own?.club.memberCount??null,median:own?.strength.medianTrophies??null,required:own?.club.metadata?.requiredTrophies??null,at:own?.club.observedAt??null},...data.rivals.map(r=>({tag:r.tag,name:formatBrawlName(r.profile?.name,t("Club")),trophies:r.profile?.rosterTrophies??null,count:r.profile?.memberCount??null,median:r.profile?.medianTrophies??null,required:r.profile?.requiredTrophies??null,at:r.fetchedAt}))]:[];
  return <LayoutWrapper><div className="space-y-7">
    <header><h1 className="text-3xl font-bold flex items-center gap-3"><Flag className="text-primary"/>{t("Club rivals")}</h1><p className="mt-2 text-sm text-muted-foreground">{t("Compare your club with up to five others.")}</p></header>
    <div className="flex flex-wrap gap-2" role="group" aria-label={t("Club comparison view")}><Button type="button" variant={view==="comparison"?"default":"outline"} aria-pressed={view==="comparison"} onClick={()=>setView("comparison")}>{t("Compare clubs")}</Button><Button type="button" variant={view==="rankings"?"default":"outline"} aria-pressed={view==="rankings"} onClick={()=>setView("rankings")}>{t("Ranking history")}</Button></div>
    {view==="comparison"&&(isAdmin?<form onSubmit={e=>{e.preventDefault();void save(tag,true);}} className="flex flex-wrap items-end gap-3"><label className="flex-1 min-w-44"><span className="block text-sm mb-2">{t("Club tag")}</span><input dir="ltr" value={tag} onChange={e=>setTag(e.target.value)} maxLength={22} required placeholder="#XXXXXXXX" className="w-full rounded-md border bg-background p-2"/></label><Button disabled={saving||!!data&&data.rivals.length>=5}><Plus className="w-4 h-4 me-2"/>{t("Follow club")}</Button></form>:<p className="text-sm text-muted-foreground">{t("An administrator can select clubs to follow.")} <Link href="/admin?next=%2Frivals" className="text-primary underline">{t("Sign in")}</Link></p>)}
    {error&&<p role="alert" className="text-amber-500">{t(error)}</p>}
    {resource.error&&<div role="alert" className="flex items-center gap-3"><p>{t("Club comparison unavailable")}</p><Button variant="outline" onClick={()=>void resource.reload()}>{t("Retry")}</Button></div>}
    {resource.loading&&!data&&<p role="status">{t("Loading...")}</p>}
    {data&&<><section hidden={view!=="comparison"} className="space-y-4"><h2 className="text-xl font-semibold">{t("Roster comparison")}</h2><div className="overflow-x-auto border rounded-xl"><table className="w-full text-sm"><thead className="bg-muted/40"><tr>{["Club","Roster trophies","Members","Median trophies","Required trophies"].map(label=><th key={label} className="p-3 text-start whitespace-nowrap">{t(label)}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.tag} className="border-t"><td className="p-3"><p className="font-semibold">{row.name}</p><p dir="ltr" className="text-xs text-muted-foreground">{row.tag}</p>{row.at&&<p className="text-xs text-muted-foreground">{dateTime(row.at)}</p>}</td>{[row.trophies,row.count,row.median,row.required].map((value,i)=><td key={i} className="p-3 tabular-nums">{value===null?"—":number(value)}</td>)}</tr>)}</tbody></table></div>
    {data.rivals.length===0&&<p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{t("No rival clubs selected yet.")}</p>}
    {!!data.rivals.length&&<div className="space-y-2">{data.rivals.map(r=><article key={r.tag} className="rounded-lg border bg-card p-4 min-w-0"><div className="flex gap-3 items-center justify-between"><h3 className="font-semibold break-words">{formatBrawlName(r.profile?.name,t("Club"))}</h3>{isAdmin&&<Button size="sm" variant="ghost" disabled={saving} onClick={()=>void save(r.tag,false)} aria-label={t("Stop following {name}",{name:formatBrawlName(r.profile?.name,t("Club"))})}><X className="w-4 h-4"/></Button>}</div>{r.stale&&<p className="my-2 text-amber-600 text-sm">{t(r.profile?"Showing the last available update":"Club data not available yet. Check the tag or retry later.")}</p>}<details className="mt-2 text-sm"><summary className="cursor-pointer text-primary">{t("Club details and trophy history")}</summary><div className="mt-3 space-y-3"><p className="text-muted-foreground break-words">{stripBrawlColorTags(r.profile?.description || "")}</p><ClubTrendLine points={r.history.map(p=>({at:p.at,value:p.trophies}))} label={t("Reported club trophies")}/>{r.history.length<2&&<p className="text-muted-foreground">{t("A trend appears after observations on two different days.")}</p>}<details><summary className="cursor-pointer text-primary">{t("All observations")}</summary><ul className="mt-2 max-h-48 overflow-auto space-y-1">{r.history.map(p=><li key={p.at} className="flex justify-between gap-2"><span>{dateTime(p.at)}</span><span>{number(p.trophies)}</span></li>)}</ul></details></div></details></article>)}</div>}
    <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">{t("About this comparison")}</summary><div className="mt-2 space-y-2"><p>{t("Roster trophies sum member balances. Snapshots may have different update times.")}</p><p>{t("Shared refresh every six hours when viewed. Removing a club keeps its observed history.")}</p></div></details></section>
    <section hidden={view!=="rankings"} className="space-y-4"><div className="flex flex-wrap gap-3 justify-between items-end"><h2 className="text-xl font-semibold">{t("Club ranking history")}</h2><label className="text-sm"><span className="block mb-1">{t("Region")}</span><select className="border rounded-md bg-background p-2" value={region} onChange={e=>setRegion(e.target.value as GameRegion)}>{gameRegions.map(r=><option key={r} value={r}>{t(regions[r])}</option>)}</select></label></div>{data.rankingStale&&<p className="text-amber-600 text-sm">{t("Showing the last available update")}</p>}{data.rankingAt&&<p className="text-xs text-muted-foreground">{t("Updated")}: {dateTime(data.rankingAt)}</p>}<div className="grid md:grid-cols-2 gap-4">{rows.map(row=>{const history=data.ranks.filter(r=>r.tag===row.tag);return <article key={row.tag} className="rounded-xl border p-4 space-y-3"><h3 className="font-semibold">{row.name}</h3><p>{t("Latest observed rank")}: {history.length&&history[0].rank!==null?number(history[0].rank):t("Not available in the top 50")}</p><ClubTrendLine points={history.map(p=>({at:p.at,value:p.rank}))} label={t("Club ranking history")} rank/>{history.length===0?<p className="text-sm text-muted-foreground">{t("No ranking history recorded yet.")}</p>:<details><summary className="text-primary text-sm cursor-pointer">{t("All observations")}</summary><ul className="max-h-48 overflow-auto text-sm mt-2 space-y-1">{history.map(p=><li key={p.at} className="flex justify-between gap-3"><span>{dateTime(p.at)}</span><span>{p.rank===null?"—":number(p.rank)}</span></li>)}</ul></details>}</article>;})}</div><details className="text-sm text-muted-foreground"><summary className="cursor-pointer">{t("How ranking history works")}</summary><p className="mt-2">{t("Daily last observation from the top 50. A missing rank means no exact rank is available; history starts with recorded observations.")}</p></details></section></>}
  </div></LayoutWrapper>;
}
