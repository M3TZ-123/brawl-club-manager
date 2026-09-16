"use client";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { UserPlus } from "lucide-react";
import { AdminGate } from "@/components/admin-gate";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import { candidateStatuses, type Candidate } from "@/lib/recruitment-data";

const statusLabels = { watching:"Watching",shortlisted:"Shortlisted",contacted:"Contacted",joined:"Joined",archived:"Archived" };
function CandidateCard({candidate,onChange,onError}:{candidate:Candidate;onChange:(value:Candidate)=>void;onError:(value:string)=>void}) {
  const {t,number,dateTime} = useI18n();
  const [draft,setDraft] = useState({ baseline: candidate, notes: candidate.notes, status: candidate.status });
  const [busy,setBusy] = useState(false);
  const pending = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => { const current = new AbortController(); controller.current = current; return () => current.abort(); }, []);
  // Follow newer saved values only for fields the administrator has not edited.
  const notes = draft.notes === draft.baseline.notes ? candidate.notes : draft.notes;
  const status = draft.status === draft.baseline.status ? candidate.status : draft.status;
  const save = async () => {
    const current = controller.current; if (!current || current.signal.aborted || pending.current) return;
    pending.current = true; setBusy(true); onError("");
    try { const data = await fetchJsonWithTimeout<{candidate:Candidate}>("/api/recruitment", {method:"PATCH",signal:current.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({player_tag:candidate.player_tag,status,notes,version:candidate.version})}); if (!current.signal.aborted) { setDraft({ baseline: data.candidate, notes: data.candidate.notes, status: data.candidate.status }); onChange(data.candidate); } }
    catch(error) {if (!current.signal.aborted) onError(error instanceof Error ? error.message : "Candidate list unavailable");} finally {pending.current = false; if (!current.signal.aborted) setBusy(false);}
  };
  const refresh = async () => {
    const current = controller.current; if (!current || current.signal.aborted || pending.current) return;
    pending.current = true; setBusy(true);onError("");
    try { const data = await fetchJsonWithTimeout<{candidate:Candidate}>("/api/recruitment", {method:"POST",signal:current.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({player_tag:candidate.player_tag})}); if (!current.signal.aborted) onChange(data.candidate); }
    catch(error) {if (!current.signal.aborted) onError(error instanceof Error ? error.message : "Candidate list unavailable");} finally {pending.current = false; if (!current.signal.aborted) setBusy(false);}
  };
  const p = candidate.profile;
  return <article className="border rounded-lg bg-card p-5 space-y-4">
    <div><h2 className="font-bold text-lg break-words">{p?.name || candidate.player_tag}</h2><p className="text-xs text-muted-foreground" dir="ltr">{candidate.player_tag}</p></div>
    {p ? <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-muted-foreground">{t("Trophies")}</dt><dd>{number(p.trophies)}</dd></div><div><dt className="text-muted-foreground">{t("Highest trophies")}</dt><dd>{number(p.highestTrophies)}</dd></div><div><dt className="text-muted-foreground">{t("Power 11 brawlers")}</dt><dd>{number(p.power11)} / {number(p.brawlers)}</dd></div><div><dt className="text-muted-foreground">{t("Ranked")}</dt><dd>{p.rank ? t(p.rank) : t("Unknown")}{p.rankedPoints !== null ? ` · ${number(p.rankedPoints)}` : ""}</dd></div>{p.clubName && <div className="col-span-2"><dt className="text-muted-foreground">{t("Club")}</dt><dd>{p.clubName}</dd></div>}</dl> : <p className="text-sm text-muted-foreground">{t("Load this player's public profile to compare them")}</p>}
    {candidate.profile_checked_at && <p className="text-xs text-muted-foreground">{t("Profile checked")}: {dateTime(candidate.profile_checked_at)}</p>}
    <label className="block text-sm">{t("Status")}<select value={status} disabled={busy} onChange={e=>setDraft({ baseline: candidate, notes, status: e.target.value as Candidate["status"] })} className="block w-full mt-1 p-2 bg-background border rounded-md">{candidateStatuses.map(s=><option key={s} value={s}>{t(statusLabels[s])}</option>)}</select></label>
    <label className="block text-sm">{t("Private notes")}<textarea value={notes} disabled={busy} onChange={e=>setDraft({ baseline: candidate, notes: e.target.value, status })} maxLength={1000} rows={3} className="block w-full mt-1 p-2 bg-background border rounded-md" /></label>
    <div className="flex flex-wrap gap-2"><Button disabled={busy || (notes===candidate.notes && status===candidate.status)} onClick={()=>void save()}>{t("Save")}</Button><Button variant="outline" disabled={busy} onClick={()=>void refresh()}>{t("Load profile")}</Button></div>
  </article>;
}
function RecruitmentWorkspace() {
  const {t,number} = useI18n();
  const [candidates,setCandidates] = useState<Candidate[] | null>(null),[error,setError] = useState(""),[tag,setTag] = useState(""),[busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const sequence = useRef(0), listRequest = useRef(0), controller = useRef<AbortController | null>(null), pendingAdd = useRef(false);
  const [minimum,setMinimum] = useState(0),[power,setPower] = useState(0),[archived,setArchived] = useState(false);
  const readList = useCallback((current: AbortController) => {
    const request = ++sequence.current; listRequest.current = request;
    return fetchJsonWithTimeout<{candidates:Candidate[]}>("/api/recruitment",{cache:"no-store",signal:current.signal}).then(data=>{
      if (!current.signal.aborted && request === sequence.current) { setCandidates(data.candidates); setError(""); }
    }).catch(e=>{if(!current.signal.aborted && request === sequence.current)setError(e instanceof Error ? e.message : "Candidate list unavailable");})
      .finally(()=>{if(!current.signal.aborted && request === listRequest.current)setLoading(false);});
  }, []);
  useEffect(()=>{ const current=new AbortController(); controller.current=current; void readList(current); return()=>current.abort();},[readList]);
  const reload = () => { if (controller.current && !controller.current.signal.aborted) { setLoading(true); return readList(controller.current); } };
  const mergeCandidate = (next: Candidate) => {
    sequence.current++;
    setCandidates(current => current?.map(row => row.player_tag === next.player_tag && row.version <= next.version ? next : row) || null);
  };
  const add = async (event:FormEvent) => {
    event.preventDefault(); const current=controller.current;
    if (!current || current.signal.aborted || pendingAdd.current || candidates === null) return;
    pendingAdd.current=true; setBusy(true);setError("");
    try {
      const result=await fetchJsonWithTimeout<{candidate:Candidate}>("/api/recruitment",{method:"PATCH",signal:current.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({player_tag:tag,status:"watching",notes:"",version:0})});
      if (current.signal.aborted) return;
      sequence.current++; setCandidates(rows=>[result.candidate,...(rows||[]).filter(row=>row.player_tag!==result.candidate.player_tag)]);setTag("");
    } catch(e) {if (!current.signal.aborted) setError(e instanceof Error?e.message:"Candidate list unavailable");}
    finally {pendingAdd.current=false;if(!current.signal.aborted)setBusy(false);}
  };
  const rows=(candidates||[]).filter(c=>(archived || c.status!=="archived") && (minimum===0 || (c.profile && c.profile.trophies>=minimum)) && (power===0 || (c.profile && c.profile.power11>=power)));
  return <div className="space-y-6">
    <header><h1 className="text-3xl font-bold flex gap-3 items-center"><UserPlus className="text-primary" />{t("Recruitment")}</h1><p className="text-muted-foreground mt-2">{t("Private candidate watchlist for club administrators")}</p></header>
    <p className="text-sm text-muted-foreground">{t("Contact and invitation status are entered manually. Profile updates are shared for one hour.")}</p>
    <form onSubmit={add} className="flex flex-wrap items-end gap-3"><label className="text-sm flex-1 min-w-48">{t("Player tag")}<Input value={tag} disabled={busy} onChange={e=>setTag(e.target.value)} maxLength={20} placeholder="#..." dir="ltr" className="mt-1" required /></label><Button disabled={busy || candidates === null || !tag.trim()}>{t("Add candidate")}</Button><Button type="button" variant="outline" disabled={loading} onClick={()=>void reload()}>{t("Reload list")}</Button></form>
    {error && <p role="alert" className="text-destructive">{t(error)}</p>}
    <div className="flex flex-wrap gap-4 items-end"><label className="text-sm">{t("Minimum trophies")}<Input type="number" min={0} max={2000000} value={minimum} onChange={e=>setMinimum(Math.max(0,Math.min(2000000,Number(e.target.value)||0)))} className="mt-1 w-36" /></label><label className="text-sm">{t("Minimum power 11 brawlers")}<Input type="number" min={0} max={300} value={power} onChange={e=>setPower(Math.max(0,Math.min(300,Number(e.target.value)||0)))} className="mt-1 w-36" /></label><label className="flex gap-2 items-center text-sm py-2"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)} />{t("Show archived")}</label></div>
    {loading && <p role="status">{t("Loading...")}</p>}{candidates !== null && <p className="text-sm text-muted-foreground">{t("{count} candidates",{count:rows.length})} · {number(candidates.length)} / {number(100)}</p>}
    {candidates?.length===0 && <p className="rounded-lg border p-8 text-center text-muted-foreground">{t("Add a player tag to start your private watchlist")}</p>}
    {candidates && candidates.length>0 && !rows.length && <p>{t("No candidates match these filters")}</p>}
    <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">{rows.map(c=><CandidateCard key={c.player_tag} candidate={c} onError={setError} onChange={mergeCandidate} />)}</div>
  </div>;
}
export default function RecruitmentPage(){return <LayoutWrapper><AdminGate><RecruitmentWorkspace /></AdminGate></LayoutWrapper>;}
