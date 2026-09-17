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
import { ClubAdministrationSettings } from "@/components/club-administration-settings";
import { RecruitmentApplications } from "@/components/recruitment-applications";
import { recruitmentFit } from "@/lib/recruitment-fit";
import type { ClubAdministration } from "@/lib/club-administration-data";
import type { CandidateCompatibility } from "@/lib/recruitment-data";

const statusLabels = { watching:"Watching",shortlisted:"Shortlisted",contacted:"Contacted",joined:"Joined",archived:"Archived" };
const emptyCompatibility:CandidateCompatibility={language:"unknown",time:"unknown",languages:"",availability:""};
const fitLabels:Record<string,string>={met:"Meets criterion",not_met:"Does not meet criterion",unknown:"Unknown",not_required:"Not required"};
function CandidateCard({candidate,onChange,onError,criteria}:{candidate:Candidate;onChange:(value:Candidate)=>void;onError:(value:string)=>void;criteria?:ClubAdministration|null}) {
  const {t,number,dateTime} = useI18n();
  const [draft,setDraft] = useState({ baseline: candidate, notes: candidate.notes, status: candidate.status, manual:candidate.manual_compatibility??emptyCompatibility });
  const [busy,setBusy] = useState(false);
  const pending = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => { const current = new AbortController(); controller.current = current; return () => current.abort(); }, []);
  // Follow newer saved values only for fields the administrator has not edited.
  const notes = draft.notes === draft.baseline.notes ? candidate.notes : draft.notes;
  const status = draft.status === draft.baseline.status ? candidate.status : draft.status;
  const manual = JSON.stringify(draft.manual)===JSON.stringify(draft.baseline.manual_compatibility??emptyCompatibility) ? candidate.manual_compatibility??emptyCompatibility : draft.manual;
  const hasDraft=draft.notes!==draft.baseline.notes||draft.status!==draft.baseline.status||JSON.stringify(draft.manual)!==JSON.stringify(draft.baseline.manual_compatibility??emptyCompatibility);
  const savedFieldsChanged=candidate.notes!==draft.baseline.notes||candidate.status!==draft.baseline.status||JSON.stringify(candidate.manual_compatibility??emptyCompatibility)!==JSON.stringify(draft.baseline.manual_compatibility??emptyCompatibility);
  const conflict=hasDraft&&savedFieldsChanged;
  const changeDraft=(values:Partial<typeof draft>)=>setDraft({baseline:hasDraft?draft.baseline:candidate,notes,status,manual,...values});
  const save = async () => {
    const current = controller.current; if (!current || current.signal.aborted || pending.current || conflict) return;
    pending.current = true; setBusy(true); onError("");
    try { const data = await fetchJsonWithTimeout<{candidate:Candidate}>("/api/recruitment", {method:"PATCH",signal:current.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({player_tag:candidate.player_tag,status,notes,version:candidate.version,...(candidate.manual_compatibility||JSON.stringify(manual)!==JSON.stringify(emptyCompatibility)?{manual_compatibility:manual}:{})})}); if (!current.signal.aborted) { setDraft({ baseline: data.candidate, notes: data.candidate.notes, status: data.candidate.status,manual:data.candidate.manual_compatibility??emptyCompatibility }); onChange(data.candidate); } }
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
    <div className="flex flex-wrap justify-between gap-2"><div><h2 className="font-bold text-lg break-words">{p?.name || candidate.player_tag}</h2><p className="text-xs text-muted-foreground" dir="ltr">{candidate.player_tag}</p></div><span className="text-xs text-muted-foreground">{t(statusLabels[candidate.status])}</span></div>
    {p ? <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-muted-foreground">{t("Trophies")}</dt><dd>{number(p.trophies)}</dd></div><div><dt className="text-muted-foreground">{t("Highest trophies")}</dt><dd>{number(p.highestTrophies)}</dd></div><div><dt className="text-muted-foreground">{t("Power 11 brawlers")}</dt><dd>{number(p.power11)} / {number(p.brawlers)}</dd></div><div><dt className="text-muted-foreground">{t("Ranked")}</dt><dd>{p.rank ? t(p.rank) : t("Unknown")}{p.rankedPoints !== null ? ` · ${number(p.rankedPoints)}` : ""}</dd></div>{p.clubName && <div className="col-span-2"><dt className="text-muted-foreground">{t("Club")}</dt><dd>{p.clubName}</dd></div>}</dl> : <p className="text-sm text-muted-foreground">{t("Load this player's public profile to compare them")}</p>}
    <Button variant="outline" size="sm" disabled={busy} onClick={()=>void refresh()}>{t("Load profile")}</Button>
    <details className="border-t pt-3"><summary className="cursor-pointer text-sm font-medium text-primary">{t("Review candidate")}</summary><div className="mt-3 space-y-3">
    {candidate.profile_checked_at && <p className="text-xs text-muted-foreground">{t("Profile checked")}: {dateTime(candidate.profile_checked_at)}</p>}
    {criteria&&<details className="text-sm"><summary className="cursor-pointer">{t("Compare with club requirements")}</summary><div className="mt-2 space-y-1">{recruitmentFit({...candidate,manual_compatibility:manual},criteria).map(row=><p key={row.key}>{t(row.label)}: {t(fitLabels[row.status])}</p>)}<p className="text-xs text-muted-foreground">{t("Profile criteria use the last checked profile. Language and time compatibility are assessed manually; no commitment score is inferred.")}</p></div></details>}
    <label className="block text-sm">{t("Status")}<select value={status} disabled={busy} onChange={e=>changeDraft({status:e.target.value as Candidate["status"]})} className="block w-full mt-1 p-2 bg-background border rounded-md">{candidateStatuses.map(s=><option key={s} value={s}>{t(statusLabels[s])}</option>)}</select></label>
    <label className="block text-sm">{t("Private notes")}<textarea value={notes} disabled={busy} onChange={e=>changeDraft({notes:e.target.value})} maxLength={1000} rows={3} className="block w-full mt-1 p-2 bg-background border rounded-md" /></label>
    <details className="space-y-3 rounded border p-3"><summary className="cursor-pointer text-sm font-medium">{t("Manual language and playing-time compatibility")}</summary>
      {([['language','Language compatibility'],['time','Playing-time compatibility']] as const).map(([key,label])=><label className="block text-sm" key={key}>{t(label)}<select value={manual[key]} disabled={busy} onChange={e=>changeDraft({manual:{...manual,[key]:e.target.value}})} className="mt-1 w-full rounded border bg-background p-2">{['unknown','compatible','incompatible'].map(value=><option value={value} key={value}>{t(value)}</option>)}</select></label>)}
      <label className="block text-sm">{t("Languages you use")}<Input maxLength={120} value={manual.languages} disabled={busy} onChange={e=>changeDraft({manual:{...manual,languages:e.target.value}})}/></label>
      <label className="block text-sm">{t("Usual playing times and timezone")}<Input maxLength={240} value={manual.availability} disabled={busy} onChange={e=>changeDraft({manual:{...manual,availability:e.target.value}})}/></label>
    </details>
    {conflict&&<div role="alert" className="space-y-2 text-sm"><p>{t("This candidate was edited elsewhere. Your draft is preserved; load the saved candidate before saving again.")}</p><Button variant="outline" disabled={busy} onClick={()=>setDraft({baseline:candidate,notes:candidate.notes,status:candidate.status,manual:candidate.manual_compatibility??emptyCompatibility})}>{t("Discard draft and load saved candidate")}</Button></div>}
    <Button disabled={busy || conflict || (notes===candidate.notes && status===candidate.status && JSON.stringify(manual)===JSON.stringify(candidate.manual_compatibility??emptyCompatibility))} onClick={()=>void save()}>{t("Save")}</Button>
    </div></details>
  </article>;
}
function RecruitmentWorkspace() {
  const {t,number} = useI18n();
  const [candidates,setCandidates] = useState<Candidate[] | null>(null),[error,setError] = useState(""),[tag,setTag] = useState(""),[busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const sequence = useRef(0), listRequest = useRef(0), controller = useRef<AbortController | null>(null), pendingAdd = useRef(false);
  const [minimum,setMinimum] = useState(0),[power,setPower] = useState(0),[archived,setArchived] = useState(false);
  const [criteria,setCriteria]=useState<ClubAdministration|null>(null);
  const [view,setView]=useState<"candidates"|"applications"|"settings">("candidates"),[applicationsOpened,setApplicationsOpened]=useState(false);
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
  const visibleTags=new Set(rows.map(candidate=>candidate.player_tag));
  return <div className="space-y-5">
    <header><h1 className="text-3xl font-bold flex gap-3 items-center"><UserPlus className="text-primary" />{t("Recruitment")}</h1><p className="text-sm text-muted-foreground mt-2">{t("Review potential members and incoming applications in one place.")}</p></header>
    <div className="flex flex-wrap gap-2" role="group" aria-label={t("Recruitment view")}>{([["candidates","Candidates"],["applications","Applications"],["settings","Recruitment settings"]] as const).map(([key,label])=><Button key={key} variant={view===key?"default":"outline"} aria-pressed={view===key} onClick={()=>{setView(key);if(key==="applications")setApplicationsOpened(true);}}>{t(label)}</Button>)}</div>
    <section hidden={view!=="settings"}><ClubAdministrationSettings onChange={setCriteria}/></section>
    <section hidden={view!=="candidates"} className="space-y-4">
    <form onSubmit={add} className="flex flex-wrap items-end gap-3"><label className="text-sm flex-1 min-w-48">{t("Player tag")}<Input value={tag} disabled={busy} onChange={e=>setTag(e.target.value)} maxLength={20} placeholder="#..." dir="ltr" className="mt-1" required /></label><Button disabled={busy || candidates === null || !tag.trim()}>{t("Add candidate")}</Button><Button type="button" variant="outline" disabled={loading} onClick={()=>void reload()}>{t("Reload list")}</Button></form>
    {error && <p role="alert" className="text-destructive">{t(error)}</p>}
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">{t("Candidate filters")}{minimum>0||power>0||archived?` · ${t("Filters active")}`:""}</summary><div className="mt-3 flex flex-wrap gap-4 items-end"><label className="text-sm">{t("Minimum trophies")}<Input type="number" min={0} max={2000000} value={minimum} onChange={e=>setMinimum(Math.max(0,Math.min(2000000,Number(e.target.value)||0)))} className="mt-1 w-36" /></label><label className="text-sm">{t("Minimum power 11 brawlers")}<Input type="number" min={0} max={300} value={power} onChange={e=>setPower(Math.max(0,Math.min(300,Number(e.target.value)||0)))} className="mt-1 w-36" /></label><label className="flex gap-2 items-center text-sm py-2"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)} />{t("Show archived")}</label></div></details>
    {loading && <p role="status">{t("Loading...")}</p>}{candidates !== null && <p className="text-sm text-muted-foreground">{t("{count} candidates",{count:rows.length})}</p>}
    {candidates?.length===0 && <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{t("Add a player tag to start your private watchlist")}</p>}
    {candidates && candidates.length>0 && !rows.length && <p>{t("No candidates match these filters")}</p>}
    <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">{candidates?.map(c=><div key={c.player_tag} hidden={!visibleTags.has(c.player_tag)}><CandidateCard key={c.player_tag} candidate={c} criteria={criteria} onError={setError} onChange={mergeCandidate} /></div>)}</div>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("About the watchlist")}</summary><p className="mt-2">{t("Contact and invitation status are entered manually. Profile updates are shared for one hour.")}</p><p className="mt-1">{number(candidates?.length||0)} / {number(100)}</p></details>
    </section>
    <section hidden={view!=="applications"}>{applicationsOpened&&<RecruitmentApplications onCandidate={()=>void reload()}/>}</section>
  </div>;
}
export default function RecruitmentPage(){return <LayoutWrapper><AdminGate><RecruitmentWorkspace /></AdminGate></LayoutWrapper>;}
