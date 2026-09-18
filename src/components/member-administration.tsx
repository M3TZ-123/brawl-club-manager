"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import { useI18n,LocalDate } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import { decisionKinds,type DecisionKind,type MemberAdministration,type MemberDecision } from "@/lib/club-administration-data";

const labels={note:"Dated note",decision:"Administrative decision",departure_reason:"Departure reason",correction:"Correction",follow_up:"Dated follow-up",absence_declared:"Absence declared",absence_cancelled:"Absence cancelled"};
const entryKinds=decisionKinds.filter(kind=>kind!=="follow_up");
type EntryKind=Exclude<DecisionKind,"follow_up">;
export function MemberAdministrationPanel({playerTag,isCurrent}:{playerTag:string;isCurrent?:boolean}){
  const {t,dateTime}=useI18n();
  const [data,setData]=useState<MemberAdministration|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [kind,setKind]=useState<EntryKind>("note"),[body,setBody]=useState(""),[departure,setDeparture]=useState(""),[corrects,setCorrects]=useState("");
  const [formOpen,setFormOpen]=useState(false),[entrySaved,setEntrySaved]=useState(false);
  const [historyWindow,setHistoryWindow]=useState({playerTag,count:5});
  const visibleEntries=historyWindow.playerTag===playerTag?historyWindow.count:5;
  const [start,setStart]=useState(""),[end,setEnd]=useState(""),[reason,setReason]=useState("");
  const controller=useRef<AbortController|null>(null),pending=useRef(false),sequence=useRef(0),submission=useRef<{signature:string;id:string}|null>(null);
  const load=useCallback(async(cursor:string|null=null)=>{
    const current=controller.current;if(!current||current.signal.aborted)return;
    const request=++sequence.current;
    setLoading(true);
    try{const result=await fetchJsonWithTimeout<MemberAdministration>(`/api/member-administration?player_tag=${encodeURIComponent(playerTag)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`,{cache:"no-store",signal:current.signal});
      if(!current.signal.aborted&&sequence.current===request){setData(previous=>cursor&&previous?{...result,decisions:[...previous.decisions,...result.decisions.filter(row=>!previous.decisions.some(old=>old.id===row.id))]}:result);if(cursor)setHistoryWindow(previous=>({playerTag,count:(previous.playerTag===playerTag?previous.count:5)+5}));setError("");}}
    catch{if(!current.signal.aborted&&sequence.current===request)setError("Administration data is temporarily unavailable.");}
    finally{if(!current.signal.aborted&&sequence.current===request)setLoading(false);}
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
    if(!body.trim()||!entryKinds.includes(kind)||kind==="departure_reason"&&!departure||kind==="correction"&&!corrects)return;
    void mutate({action:"decision",player_tag:playerTag,kind,body,
      departure_event_id:kind==="departure_reason"?departure:null,corrects_id:kind==="correction"?corrects:null,
      follow_up_at:null},()=>{setBody("");setDeparture("");setCorrects("");setFormOpen(false);setEntrySaved(true);});
  };
  const submitAbsence=()=>{
    if(!start||!end||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))){setError("Provide a valid date and timezone.");return;}
    void mutate({action:"absence",player_tag:playerTag,starts_at:new Date(start).toISOString(),ends_at:new Date(end).toISOString(),reason},()=>{setStart("");setEnd("");setReason("");});
  };
  const entryBody=(entry:MemberDecision)=>{
    if(entry.kind!=="absence_declared"&&entry.kind!=="absence_cancelled")return entry.body;
    try{const value=JSON.parse(entry.body);return `${dateTime(value.starts_at)} – ${dateTime(value.ends_at)}${value.reason?` · ${value.reason}`:""}`;}catch{return t(labels[entry.kind]);}
  };
  const openEntry=(value:EntryKind)=>{setKind(value);setFormOpen(true);setEntrySaved(false);};
  const formId=`decision-form-${playerTag.replaceAll("#","")}`;
  return <section className="space-y-4 border-t pt-5">
    <div className="space-y-1"><h3 className="font-semibold">{t("Dated history")}</h3><p className="text-xs text-muted-foreground">{t("Saved entries stay in history. Add a correction to update an earlier entry.")}</p></div>
    {error&&<p role="alert" className="text-sm text-destructive">{t(error)} <Button variant="ghost" onClick={()=>void load()} disabled={busy}>{t("Retry")}</Button></p>}
    {!data?(loading?<p role="status">{t("Loading...")}</p>:null):<>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} aria-expanded={formOpen} aria-controls={formId} onClick={()=>openEntry("departure_reason")}>{t("Record departure reason")}</Button><Button size="sm" variant="outline" disabled={busy} aria-expanded={formOpen} aria-controls={formId} onClick={()=>openEntry("note")}>{t("Add dated note")}</Button></div>
      {formOpen&&<div id={formId} className="space-y-3 rounded-lg border p-3">
      <label className="block text-sm">{t("Entry type")}<select className="mt-1 w-full rounded border bg-background p-2" value={kind} disabled={busy} onChange={e=>{if(entryKinds.some(value=>value===e.target.value))setKind(e.target.value as EntryKind);}}>{entryKinds.map(value=><option key={value} value={value}>{t(labels[value])}</option>)}</select></label>
      {kind==="departure_reason"&&<div className="space-y-2"><label className="block text-sm">{t("Exact recorded departure")}<select value={departure} disabled={busy||!data.departures.length} onChange={e=>setDeparture(e.target.value)} className="mt-1 w-full rounded border bg-background p-2"><option value="">{t("Choose a departure")}</option>{data.departures.map(row=><option value={row.id} key={row.id}>{dateTime(row.occurred_at)} · {t(row.source==="recorded"?"Recorded":"Reconstructed")}</option>)}</select></label><p className="text-xs text-muted-foreground">{t("A departure does not establish whether the player left or was removed. Enter only the reason known to administrators.")}</p>{!data.departures.length&&<p className="text-sm">{t("No recorded departure is available to link. You can save the context as a dated note.")}</p>}{data.departuresLimited&&<p className="text-xs text-muted-foreground">{t("Only the latest 100 departures are listed.")}</p>}</div>}
      {kind==="correction"&&<label className="block text-sm">{t("Entry to correct")}<select value={corrects} disabled={busy} onChange={e=>setCorrects(e.target.value)} className="mt-1 w-full rounded border bg-background p-2"><option value="">{t("Choose an earlier entry")}</option>{data.decisions.map(row=><option value={row.id} key={row.id}>{dateTime(row.created_at)} · {t(labels[row.kind])} · {entryBody(row).slice(0,70)}</option>)}</select></label>}
      <label className="block text-sm">{t("Entry text")}<textarea maxLength={1000} rows={3} value={body} disabled={busy} onChange={e=>setBody(e.target.value)} className="mt-1 w-full rounded border bg-background p-2"/></label>
      <div className="flex flex-wrap gap-2"><Button disabled={busy||!body.trim()||kind==="departure_reason"&&!departure||kind==="correction"&&!corrects} onClick={submitDecision}>{t(busy?"Saving...":"Save dated entry")}</Button><Button variant="ghost" disabled={busy} onClick={()=>setFormOpen(false)}>{t("Close entry form")}</Button></div>
      </div>}
      {entrySaved&&<p role="status" className="text-sm text-green-600 dark:text-green-400">{t("Entry saved to history")}</p>}
      <div className="space-y-3" aria-label={t("Saved dated history")}>{data.decisions.slice(0,visibleEntries).map(entry=><article key={entry.id} className="space-y-1 border-s-2 ps-3 text-sm"><p className="font-medium">{t(entry.kind==="follow_up"?"Historical follow-up":labels[entry.kind])} · <LocalDate value={entry.created_at} time/></p><p className="whitespace-pre-wrap break-words">{entryBody(entry)}</p>{entry.departure_event_id&&<p className="text-xs text-muted-foreground">{t("Linked departure")}: <LocalDate value={entry.departure_occurred_at??data.departures.find(row=>row.id===entry.departure_event_id)?.occurred_at} time/></p>}{entry.corrects_id&&<p className="text-xs text-muted-foreground">{t("Corrects an earlier entry; the original is preserved.")}</p>}{entry.follow_up_at&&<p className="text-xs text-muted-foreground">{t("Recorded follow-up date")}: <LocalDate value={entry.follow_up_at} time/></p>}</article>)}{!data.decisions.length&&<p className="text-sm text-muted-foreground">{t("No dated decisions recorded yet.")}</p>}</div>
      {data.decisions.slice(0,visibleEntries).some(entry=>entry.kind==="follow_up")&&<p className="text-xs text-muted-foreground">{t("Historical follow-up entries do not schedule a follow-up. Use the note's follow-up status above.")}</p>}
      {visibleEntries<data.decisions.length?<Button variant="outline" disabled={busy||loading} onClick={()=>setHistoryWindow({playerTag,count:visibleEntries+5})}>{t("Show older entries")}</Button>:data.nextCursor&&<Button variant="outline" disabled={busy||loading} onClick={()=>void load(data.nextCursor)}>{t(loading?"Loading...":"Show older entries")}</Button>}
      {(isCurrent===true||data.absences.length>0)&&<details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">{t("Declared absence")}{data.absences.some(absence=>!absence.cancelled_at&&Date.parse(absence.starts_at)<=Date.now()&&Date.parse(absence.ends_at)>Date.now())&&<span className="ms-2 text-xs text-amber-600">{t("Absence active")}</span>}</summary><div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">{t("Absence pauses inactivity alerts only during the declared period. Recorded activity stays unchanged.")}</p>
      {data.absences.map(absence=><article key={absence.id} className="space-y-2 rounded border p-3 text-sm"><p><LocalDate value={absence.starts_at} time/> – <LocalDate value={absence.ends_at} time/></p>{absence.reason&&<p className="break-words">{absence.reason}</p>}{absence.cancelled_at?<p>{t("Cancelled")}</p>:Date.parse(absence.ends_at)>Date.now()?<Button variant="outline" disabled={busy} onClick={()=>void mutate({action:"cancel_absence",id:absence.id})}>{t("Cancel absence")}</Button>:<p>{t("Ended")}</p>}</article>)}
      {isCurrent===true&&<div className="space-y-3"><label className="block text-sm">{t("Absence starts")}<Input type="datetime-local" dir="ltr" disabled={busy} value={start} onChange={e=>setStart(e.target.value)}/></label><label className="block text-sm">{t("Absence ends")}<Input type="datetime-local" dir="ltr" disabled={busy} value={end} onChange={e=>setEnd(e.target.value)}/></label><label className="block text-sm">{t("Optional private reason")}<Input maxLength={500} disabled={busy} value={reason} onChange={e=>setReason(e.target.value)}/></label><Button disabled={busy||!start||!end} onClick={submitAbsence}>{t("Declare absence")}</Button></div>}
      </div></details>}
    </>}
  </section>;
}
