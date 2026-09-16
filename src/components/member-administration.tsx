"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import { useI18n,LocalDate } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import { decisionKinds,type DecisionKind,type MemberAdministration,type MemberDecision } from "@/lib/club-administration-data";

const labels={note:"Dated note",decision:"Administrative decision",departure_reason:"Departure reason",correction:"Correction",follow_up:"Dated follow-up",absence_declared:"Absence declared",absence_cancelled:"Absence cancelled"};
export function MemberAdministrationPanel({playerTag,isCurrent}:{playerTag:string;isCurrent?:boolean}){
  const {t,dateTime}=useI18n();
  const [data,setData]=useState<MemberAdministration|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [kind,setKind]=useState<DecisionKind>("note"),[body,setBody]=useState(""),[departure,setDeparture]=useState(""),[corrects,setCorrects]=useState(""),[followUp,setFollowUp]=useState("");
  const [start,setStart]=useState(""),[end,setEnd]=useState(""),[reason,setReason]=useState("");
  const controller=useRef<AbortController|null>(null),pending=useRef(false),sequence=useRef(0),submission=useRef<{signature:string;id:string}|null>(null);
  const load=useCallback(async(cursor:string|null=null)=>{
    const current=controller.current;if(!current||current.signal.aborted)return;
    const request=++sequence.current;
    try{const result=await fetchJsonWithTimeout<MemberAdministration>(`/api/member-administration?player_tag=${encodeURIComponent(playerTag)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`,{cache:"no-store",signal:current.signal});
      if(!current.signal.aborted&&sequence.current===request){setData(previous=>cursor&&previous?{...result,decisions:[...previous.decisions,...result.decisions.filter(row=>!previous.decisions.some(old=>old.id===row.id))]}:result);setError("");}}
    catch{if(!current.signal.aborted&&sequence.current===request)setError("Administration data is temporarily unavailable.");}
  },[playerTag]);
  useEffect(()=>{const current=new AbortController(),requests=sequence;controller.current=current;void load();return()=>{current.abort();requests.current++;};},[load]);
  const mutate=async(values:Record<string,unknown>,onSuccess?:()=>void)=>{
    const current=controller.current;if(!current||current.signal.aborted||pending.current||!data)return;
    pending.current=true;setBusy(true);setError("");
    try{
      const signature=JSON.stringify(values);if(submission.current?.signature!==signature)submission.current={signature,id:crypto.randomUUID()};
      await fetchJsonWithTimeout("/api/member-administration",{method:"POST",signal:current.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({...values,request_id:submission.current.id})});
      if(current.signal.aborted)return;submission.current=null;onSuccess?.();await load();if(!current.signal.aborted)window.dispatchEvent(new CustomEvent("club-administration-updated"));
    }catch(cause){if(!current.signal.aborted)setError(cause instanceof Error?cause.message:"Administration data is temporarily unavailable.");}
    finally{pending.current=false;if(!current.signal.aborted)setBusy(false);}
  };
  const submitDecision=()=>{
    if(kind==="follow_up"&&(!followUp||!Number.isFinite(Date.parse(followUp)))){setError("Provide a valid date and timezone.");return;}
    void mutate({action:"decision",player_tag:playerTag,kind,body,
      departure_event_id:kind==="departure_reason"?departure:null,corrects_id:kind==="correction"?corrects:null,
      follow_up_at:kind==="follow_up"?new Date(followUp).toISOString():null},()=>{setBody("");setDeparture("");setCorrects("");setFollowUp("");});
  };
  const submitAbsence=()=>{
    if(!start||!end||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))){setError("Provide a valid date and timezone.");return;}
    void mutate({action:"absence",player_tag:playerTag,starts_at:new Date(start).toISOString(),ends_at:new Date(end).toISOString(),reason},()=>{setStart("");setEnd("");setReason("");});
  };
  const entryBody=(entry:MemberDecision)=>{
    if(entry.kind!=="absence_declared"&&entry.kind!=="absence_cancelled")return entry.body;
    try{const value=JSON.parse(entry.body);return `${dateTime(value.starts_at)} – ${dateTime(value.ends_at)}${value.reason?` · ${value.reason}`:""}`;}catch{return t(labels[entry.kind]);}
  };
  return <section className="space-y-4 border-t pt-5">
    <h3 className="font-semibold">{t("Private dated decision log")}</h3>
    {error&&<p role="alert" className="text-sm text-destructive">{t(error)} <Button variant="ghost" onClick={()=>void load()} disabled={busy}>{t("Retry")}</Button></p>}
    {!data?<p role="status">{t("Loading...")}</p>:<>
      <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">{t("Add a dated decision or departure reason")}</summary><div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">{t("Entries are recorded now and kept unchanged. Add a correction to an earlier entry. The shared administrator login does not identify an individual author.")}</p>
      <label className="block text-sm">{t("Entry type")}<select className="mt-1 w-full rounded border bg-background p-2" value={kind} disabled={busy} onChange={e=>setKind(e.target.value as DecisionKind)}>{decisionKinds.map(value=><option key={value} value={value}>{t(labels[value])}</option>)}</select></label>
      {kind==="departure_reason"&&<label className="block text-sm">{t("Exact recorded departure")}<select value={departure} disabled={busy} onChange={e=>setDeparture(e.target.value)} className="mt-1 w-full rounded border bg-background p-2"><option value="">{t("Choose a departure")}</option>{data.departures.map(row=><option value={row.id} key={row.id}>{dateTime(row.occurred_at)} · {t(row.source==="recorded"?"Recorded":"Reconstructed")}</option>)}</select><span className="text-xs text-muted-foreground">{t("A departure does not establish whether the player left or was removed. Enter only the reason known to administrators.")}</span>{data.departuresLimited&&<p>{t("Only the latest 100 departures are listed.")}</p>}</label>}
      {kind==="correction"&&<label className="block text-sm">{t("Entry to correct")}<select value={corrects} disabled={busy} onChange={e=>setCorrects(e.target.value)} className="mt-1 w-full rounded border bg-background p-2"><option value="">{t("Choose an earlier entry")}</option>{data.decisions.map(row=><option value={row.id} key={row.id}>{dateTime(row.created_at)} · {t(labels[row.kind])} · {entryBody(row).slice(0,70)}</option>)}</select></label>}
      {kind==="follow_up"&&<label className="block text-sm">{t("Follow-up date")}<Input type="datetime-local" dir="ltr" value={followUp} disabled={busy} onChange={e=>setFollowUp(e.target.value)}/></label>}
      <label className="block text-sm">{t("Entry text")}<textarea maxLength={1000} rows={3} value={body} disabled={busy} onChange={e=>setBody(e.target.value)} className="mt-1 w-full rounded border bg-background p-2"/></label>
      <Button disabled={busy||!body.trim()||kind==="departure_reason"&&!departure||kind==="correction"&&!corrects} onClick={submitDecision}>{t("Add dated entry")}</Button>
      </div></details>
      <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">{t("Saved decisions and corrections")}</summary><div className="mt-3 space-y-3">
      <div className="space-y-3">{data.decisions.map(entry=><article key={entry.id} className="space-y-1 rounded border p-3 text-sm"><p className="font-medium">{t(labels[entry.kind])} · <LocalDate value={entry.created_at} time/></p><p className="whitespace-pre-wrap break-words">{entryBody(entry)}</p>{entry.departure_event_id&&<p className="text-xs text-muted-foreground">{t("Linked departure")}: <LocalDate value={entry.departure_occurred_at??data.departures.find(row=>row.id===entry.departure_event_id)?.occurred_at} time/></p>}{entry.corrects_id&&<p className="text-xs text-muted-foreground">{t("Corrects an earlier entry; the original is preserved.")}</p>}{entry.follow_up_at&&<p>{t("Follow-up date")}: <LocalDate value={entry.follow_up_at} time/></p>}</article>)}{!data.decisions.length&&<p className="text-sm text-muted-foreground">{t("No dated decisions recorded yet.")}</p>}</div>
      {data.nextCursor&&<Button variant="outline" disabled={busy} onClick={()=>void load(data.nextCursor)}>{t("Load More")}</Button>}
      </div></details>
      <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">{t("Declared absence")}{data.absences.some(absence=>!absence.cancelled_at&&Date.parse(absence.starts_at)<=Date.now()&&Date.parse(absence.ends_at)>Date.now())&&<span className="ms-2 text-xs text-amber-600">{t("Absence active")}</span>}</summary><div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">{t("Absence pauses inactivity alerts only during the declared period. Recorded activity stays unchanged.")}</p>
      {data.absences.map(absence=><article key={absence.id} className="space-y-2 rounded border p-3 text-sm"><p><LocalDate value={absence.starts_at} time/> – <LocalDate value={absence.ends_at} time/></p>{absence.reason&&<p className="break-words">{absence.reason}</p>}{absence.cancelled_at?<p>{t("Cancelled")}</p>:Date.parse(absence.ends_at)>Date.now()?<Button variant="outline" disabled={busy} onClick={()=>void mutate({action:"cancel_absence",id:absence.id})}>{t("Cancel absence")}</Button>:<p>{t("Ended")}</p>}</article>)}
      {isCurrent===true&&<div className="space-y-3"><label className="block text-sm">{t("Absence starts")}<Input type="datetime-local" dir="ltr" disabled={busy} value={start} onChange={e=>setStart(e.target.value)}/></label><label className="block text-sm">{t("Absence ends")}<Input type="datetime-local" dir="ltr" disabled={busy} value={end} onChange={e=>setEnd(e.target.value)}/></label><label className="block text-sm">{t("Optional private reason")}<Input maxLength={500} disabled={busy} value={reason} onChange={e=>setReason(e.target.value)}/></label><Button disabled={busy||!start||!end} onClick={submitAbsence}>{t("Declare absence")}</Button></div>}
      </div></details>
    </>}
  </section>;
}
