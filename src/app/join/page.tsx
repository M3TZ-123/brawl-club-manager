"use client";
import { type FormEvent,useCallback,useEffect,useRef,useState } from "react";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import type { PublicJoinInfo } from "@/lib/club-administration-data";

export default function JoinPage(){
  const {t,number}=useI18n();
  const [info,setInfo]=useState<PublicJoinInfo|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[accepted,setAccepted]=useState(false);
  const [tag,setTag]=useState(""),[message,setMessage]=useState(""),[language,setLanguage]=useState(""),[availability,setAvailability]=useState(""),[consent,setConsent]=useState(false),[website,setWebsite]=useState("");
  const controller=useRef<AbortController|null>(null),pending=useRef(false),request=useRef<{signature:string;id:string}|null>(null);
  const load=useCallback(async()=>{const current=controller.current;if(!current||current.signal.aborted)return;setError("");try{const data=await fetchJsonWithTimeout<PublicJoinInfo>("/api/join",{cache:"no-store",signal:current.signal});if(!current.signal.aborted)setInfo(data);}catch{if(!current.signal.aborted)setError("Applications are temporarily unavailable.");}},[]);
  useEffect(()=>{const current=new AbortController();controller.current=current;void load();return()=>current.abort();},[load]);
  const submit=async(event:FormEvent)=>{
    event.preventDefault();const current=controller.current;if(!current||current.signal.aborted||!info||pending.current)return;
    pending.current=true;setBusy(true);setError("");
    try{const values={club_tag:info.club_tag,player_tag:tag,message,language,availability,consent,website};const signature=JSON.stringify(values);
      if(request.current?.signature!==signature)request.current={signature,id:crypto.randomUUID()};
      const result=await fetchJsonWithTimeout<{accepted:boolean}>("/api/join",{method:"POST",signal:current.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({...values,request_id:request.current.id})});
      if(!current.signal.aborted&&result.accepted===true){setAccepted(true);setTag("");setMessage("");setLanguage("");setAvailability("");}}
    catch(cause){if(!current.signal.aborted)setError(cause instanceof Error?cause.message:"Applications are temporarily unavailable.");}
    finally{pending.current=false;if(!current.signal.aborted)setBusy(false);}
  };
  return <LayoutWrapper><div className="mx-auto max-w-2xl space-y-5"><header><h1 className="text-2xl font-bold">{t("Apply to join the club")}</h1><p className="mt-2 text-sm text-muted-foreground">{t("Send a private request to the club administrators.")}</p></header>
    {error&&<p role="alert" className="text-destructive">{t(error)} {!info&&<Button variant="ghost" onClick={()=>void load()}>{t("Retry")}</Button>}</p>}
    {!info&&!error&&<p role="status">{t("Loading...")}</p>}
    {info&&<section className="space-y-3 rounded-lg border p-4"><div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">{t("Club requirements")}</h2><p dir="ltr" className="text-sm text-muted-foreground">{info.club_tag}</p></div><dl className="grid gap-3 sm:grid-cols-2 text-sm"><div><dt className="text-muted-foreground">{t("Minimum trophies")}</dt><dd className="font-semibold">{number(info.min_trophies)}</dd></div><div><dt className="text-muted-foreground">{t("Minimum power 11 brawlers")}</dt><dd className="font-semibold">{number(info.min_power11)}</dd></div>{info.min_ranked_points!=null&&<div><dt className="text-muted-foreground">{t("Minimum ranked points")}</dt><dd className="font-semibold">{number(info.min_ranked_points)}</dd></div>}</dl>{(info.language||info.availability)&&<details className="text-sm"><summary className="cursor-pointer text-primary">{t("Club preferences")}</summary><div className="mt-2 space-y-2">{info.language&&<p className="break-words">{t("Preferred language")}: {info.language}</p>}{info.availability&&<p className="break-words">{t("Preferred playing times and timezone")}: {info.availability}</p>}</div></details>}<p className="text-xs text-muted-foreground">{t("Meeting the criteria does not guarantee admission.")}</p></section>}
    {accepted?<p role="status" className="rounded border border-green-500 p-4">{t("Application received. Administrators can review it privately.")}</p>:info&&!info.recruitment_open?<p>{t("Applications are currently closed.")}</p>:info&&<form className="space-y-4" onSubmit={submit}>
      <label className="block text-sm">{t("Player tag")}<Input required maxLength={20} dir="ltr" value={tag} disabled={busy} onChange={e=>setTag(e.target.value)} placeholder="#..."/></label>
      <label className="block text-sm">{t("Application message")}<textarea maxLength={1000} rows={4} value={message} disabled={busy} onChange={e=>setMessage(e.target.value)} className="mt-1 w-full rounded border bg-background p-3"/></label>
      <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer font-medium">{t("Playing preferences (optional)")}</summary><div className="mt-3 space-y-3"><label className="block">{t("Languages you use")}<Input maxLength={120} value={language} disabled={busy} onChange={e=>setLanguage(e.target.value)}/></label><label className="block">{t("Usual playing times and timezone")}<Input maxLength={240} value={availability} disabled={busy} onChange={e=>setAvailability(e.target.value)}/></label></div></details>
      <p className="text-xs text-muted-foreground">{t("Do not include passwords or sensitive personal information.")}</p>
      <input aria-hidden="true" tabIndex={-1} autoComplete="off" name="website" className="hidden" value={website} onChange={e=>setWebsite(e.target.value)}/>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)} required/>{t("I agree to share these details privately with this club's administrators.")}</label>
      <Button disabled={busy||!consent||!tag.trim()}>{t(busy?"Sending...":"Submit application")}</Button>
    </form>}
    <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">{t("How applications work")}</summary><div className="mt-2 space-y-2"><p>{t("Your application is private to club administrators. Entering a player tag does not verify account ownership. No invitation or message is sent automatically.")}</p><p>{t("Do not include passwords, API keys or sensitive personal information. Rejected or archived applications may be removed after 90 days.")}</p></div></details>
  </div></LayoutWrapper>;
}
