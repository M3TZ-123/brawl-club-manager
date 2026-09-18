"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import { useI18n,LocalDate } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import type { RecruitmentApplication } from "@/lib/club-administration-data";
const statuses=["pending","reviewing","accepted","rejected","archived"] as const;

function ApplicationCard({application,onSaved,onCandidate}:{application:RecruitmentApplication;onSaved:(row:RecruitmentApplication)=>void;onCandidate:()=>void}){
  const {t}=useI18n();
  const [draft,setDraft]=useState<{notes:string;status:RecruitmentApplication["status"];version:number}|null>(null);
  const [error,setError]=useState(""),[busy,setBusy]=useState(false),[added,setAdded]=useState(false);
  const controller=useRef<AbortController|null>(null),pending=useRef(false);
  useEffect(()=>{const current=new AbortController();controller.current=current;return()=>current.abort();},[]);
  const values=draft??{notes:application.private_notes,status:application.status,version:application.version};
  const change=(value:Partial<typeof values>)=>setDraft(previous=>({...previous??values,...value}));
  const submit=async(watchlist=false)=>{
    const current=controller.current;if(!current||current.signal.aborted||pending.current)return;
    pending.current=true;setBusy(true);setError("");
    try{
      if(watchlist){
        await fetchJsonWithTimeout("/api/recruitment",{method:"PATCH",signal:current.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({player_tag:application.player_tag,status:"watching",notes:"",version:0})});
        if(!current.signal.aborted){setAdded(true);onCandidate();}
      }else{
        const data=await fetchJsonWithTimeout<{application:RecruitmentApplication}>("/api/recruitment/applications",{method:"PATCH",signal:current.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({id:application.id,status:values.status,private_notes:values.notes,version:values.version})});
        if(!current.signal.aborted){setDraft(null);onSaved(data.application);}
      }
    }catch(cause){if(!current.signal.aborted)setError(cause instanceof Error?cause.message:"Applications are temporarily unavailable.");}
    finally{pending.current=false;if(!current.signal.aborted)setBusy(false);}
  };
  return <article className="space-y-3 rounded-lg border p-4"><div className="flex flex-wrap justify-between gap-2"><p className="font-semibold" dir="ltr">{application.player_tag}</p><span className="text-xs text-muted-foreground">{t(application.status)}</span></div><p className="text-xs text-muted-foreground"><LocalDate value={application.created_at} time/> · {t("Account ownership unverified")}</p><p className="line-clamp-2 break-words text-sm text-muted-foreground">{application.message||t("No application message")}</p>
    <details className="border-t pt-3"><summary className="cursor-pointer text-sm font-medium text-primary">{t("Review application")}</summary><div className="mt-3 space-y-3"><p className="whitespace-pre-wrap break-words text-sm">{application.message||t("No application message")}</p><p className="text-sm">{t("Languages you use")}: {application.language||t("Unknown")}</p><p className="text-sm">{t("Usual playing times and timezone")}: {application.availability||t("Unknown")}</p>
    <label className="block text-sm">{t("Application status")}<select className="mt-1 w-full rounded border bg-background p-2" value={values.status} disabled={busy} onChange={e=>change({status:e.target.value as RecruitmentApplication["status"]})}>{statuses.map(value=><option value={value} key={value}>{t(value)}</option>)}</select></label>
    <label className="block text-sm">{t("Private notes")}<textarea maxLength={1000} value={values.notes} disabled={busy} onChange={e=>change({notes:e.target.value})} rows={2} className="mt-1 w-full rounded border bg-background p-2"/></label>
    {draft&&draft.version!==application.version&&<p role="alert">{t("The saved application changed. Your draft is preserved; load the saved review before editing again.")}</p>}
    {error&&<p role="alert" className="text-sm text-destructive">{t(error)}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={()=>void submit()}>{t("Save application review")}</Button><Button variant="outline" disabled={busy||added} onClick={()=>void submit(true)}>{t(added?"Added to watchlist":"Add to watchlist")}</Button>{draft&&draft.version!==application.version&&<Button variant="outline" disabled={busy} onClick={()=>{setDraft(null);setError("");}}>{t("Load saved review")}</Button>}</div></div></details>
  </article>;
}

export function RecruitmentApplications({onCandidate}:{onCandidate:()=>void}){
  const {t,number}=useI18n();
  const [rows,setRows]=useState<RecruitmentApplication[]>([]),[total,setTotal]=useState(0),[next,setNext]=useState<string|null>(null),[filter,setFilter]=useState("pending"),[error,setError]=useState(false),[loading,setLoading]=useState(true);
  const controller=useRef<AbortController|null>(null),sequence=useRef(0);
  const load=useCallback(async(cursor:string|null=null)=>{
    const current=controller.current;if(!current||current.signal.aborted)return;
    const request=++sequence.current;setLoading(true);setError(false);
    try{
      const data=await fetchJsonWithTimeout<{applications:RecruitmentApplication[];total:number|null;nextCursor:string|null}>(`/api/recruitment/applications?status=${filter}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`,{cache:"no-store",signal:current.signal});
      if(!current.signal.aborted&&request===sequence.current){setRows(previous=>cursor?Array.from(new Map([...previous,...data.applications].map(row=>[row.id,row])).values()):data.applications);if(data.total!==null)setTotal(data.total);setNext(data.nextCursor);}
    }catch{if(!current.signal.aborted&&request===sequence.current)setError(true);}
    finally{if(!current.signal.aborted&&request===sequence.current)setLoading(false);}
  },[filter]);
  useEffect(()=>{const current=new AbortController(),requests=sequence;controller.current=current;setRows([]);setNext(null);void load();return()=>{current.abort();requests.current++;};},[load]);
  const saved=(row:RecruitmentApplication)=>{
    // Invalidate reads started before this save, so they cannot restore an older revision.
    sequence.current++;setLoading(false);
    const keep=filter==="all"||row.status===filter;
    setRows(previous=>keep?previous.map(old=>old.id===row.id?row:old):previous.filter(old=>old.id!==row.id));
    if(!keep)setTotal(value=>Math.max(0,value-1));
  };
  return <section className="space-y-4"><h2 className="text-xl font-bold">{t("Private applications")}</h2><p className="text-sm text-muted-foreground">{t("Status changes do not send invitations.")}</p><div className="flex flex-wrap items-end gap-3"><label className="text-sm">{t("Application status")}<select aria-label={t("Application status")} value={filter} onChange={e=>setFilter(e.target.value)} className="ms-2 rounded border bg-background p-2">{["all",...statuses].map(value=><option key={value} value={value}>{t(value)}</option>)}</select></label><Button variant="outline" disabled={loading} onClick={()=>void load()}>{t("Reload list")}</Button></div>
    {error&&<p role="alert">{t("Applications are temporarily unavailable.")}</p>}{loading&&<p role="status">{t("Loading...")}</p>}{!error&&!loading&&<p>{t("Applications")}: {number(total)}</p>}
    <div className="grid gap-4 md:grid-cols-2">{rows.map(row=><ApplicationCard key={row.id} application={row} onSaved={saved} onCandidate={onCandidate}/>)}</div>
    {!loading&&!error&&!rows.length&&<p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{t("No applications in this status.")}</p>}
    {next!=null&&<Button disabled={loading} variant="outline" onClick={()=>void load(next)}>{t("Load More")}</Button>}
  </section>;
}
