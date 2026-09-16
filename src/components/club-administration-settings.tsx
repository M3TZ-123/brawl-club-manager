"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import Link from "next/link";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import type { ClubAdministration } from "@/lib/club-administration-data";

export function ClubAdministrationSettings({graceOnly=false,onChange}:{graceOnly?:boolean;onChange?:(value:ClubAdministration)=>void}){
  const {t}=useI18n();
  const [settings,setSettings]=useState<ClubAdministration|null>(null),[draft,setDraft]=useState<ClubAdministration|null>(null);
  const [error,setError]=useState(""),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[loading,setLoading]=useState(true);
  const controller=useRef<AbortController|null>(null),pending=useRef(false),sequence=useRef(0);
  const load=useCallback(async()=>{
    const current=controller.current;if(!current||current.signal.aborted||pending.current)return;
    const request=++sequence.current;setError("");setLoading(true);setSaved(false);
    try{const data=await fetchJsonWithTimeout<{settings:ClubAdministration}>("/api/club-administration",{cache:"no-store",signal:current.signal});if(!current.signal.aborted&&request===sequence.current){setSettings(data.settings);setDraft(data.settings);onChange?.(data.settings);}}
    catch{if(!current.signal.aborted&&request===sequence.current)setError("Administration data is temporarily unavailable.");}
    finally{if(!current.signal.aborted&&request===sequence.current)setLoading(false);}
  },[onChange]);
  useEffect(()=>{const current=new AbortController();controller.current=current;void load();return()=>current.abort();},[load]);
  const save=async()=>{
    const current=controller.current;if(!current||current.signal.aborted||!draft||!settings||pending.current||loading)return;
    pending.current=true;setBusy(true);setError("");setSaved(false);
    try{const data=await fetchJsonWithTimeout<{settings:ClubAdministration}>("/api/club-administration",{method:"PATCH",signal:current.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify(draft)});
      if(!current.signal.aborted){setSettings(data.settings);setDraft(data.settings);setSaved(true);onChange?.(data.settings);window.dispatchEvent(new CustomEvent("club-administration-updated"));}}
    catch(cause){if(!current.signal.aborted)setError(cause instanceof Error?cause.message:"Administration data is temporarily unavailable.");}
    finally{pending.current=false;if(!current.signal.aborted)setBusy(false);}
  };
  const change=(values:Partial<ClubAdministration>)=>{setDraft(value=>value?{...value,...values}:value);setSaved(false);};
  return <section className="space-y-3 rounded-lg border bg-card p-4">
    <h2 className="font-semibold">{t(graceOnly?"New member grace period":"Recruitment criteria and applications")}</h2>
    {error&&<p role="alert" className="text-sm text-destructive">{t(error)} <Button variant="ghost" onClick={()=>void load()} disabled={busy||loading}>{t("Reload saved settings")}</Button></p>}
    {!draft?<p role="status">{t("Loading...")}</p>:<>
      <label className="block text-sm">{t("New member grace hours")}<Input type="number" min={0} max={168} value={draft.grace_hours} disabled={busy||loading} onChange={e=>change({grace_hours:Number(e.target.value)})} className="mt-1 w-32"/></label>
      <p className="text-xs text-muted-foreground">{t("Grace and declared absence pause inactivity alerts, not recorded activity statistics. Zero disables grace.")}</p>
      {!graceOnly&&<>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.recruitment_open} disabled={busy||loading} onChange={e=>change({recruitment_open:e.target.checked})}/>{t("Accept public applications")}</label>
        <p className="text-sm"><Link className="text-primary underline" href="/join">{t("Open public application page")}</Link></p>
        <p className="text-xs text-muted-foreground">{t("These criteria, language and playing times are public. They do not automatically accept applicants.")}</p>
        <div className="grid gap-3 sm:grid-cols-3">{([['min_trophies','Minimum trophies',2000000],['min_power11','Minimum power 11 brawlers',300],['min_ranked_points','Minimum ranked points',1000000]] as const).map(([key,label,max])=><label key={key} className="text-sm">{t(label)}<Input type="number" min={0} max={max} value={draft[key]??""} disabled={busy||loading} onChange={e=>change({[key]:key==="min_ranked_points"&&e.target.value===""?null:Number(e.target.value)})}/></label>)}</div>
        <label className="block text-sm">{t("Preferred language")}<Input maxLength={120} value={draft.language} disabled={busy||loading} onChange={e=>change({language:e.target.value})}/></label>
        <label className="block text-sm">{t("Preferred playing times and timezone")}<Input maxLength={240} value={draft.availability} disabled={busy||loading} onChange={e=>change({availability:e.target.value})}/></label>
      </>}
      <Button onClick={()=>void save()} disabled={busy||loading}>{t(busy?"Saving...":"Save administration settings")}</Button>
      {saved&&<p role="status" className="text-sm text-green-500">{t("Administration settings saved")}</p>}
    </>}
  </section>;
}
