"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import type { PlanningMutation,PlanningResponse } from "@/lib/club-planning-types";
export const goalMetricLabels={trophies:"Net trophy gain",participants:"Unique participating members"};
export const goalCycleLabels={weekly:"7 days",monthly:"30 days",custom:"Custom end date"};
export const eventKindLabels={mega_pig:"Mega Pig",ranked:"Ranked",tournament:"Tournament",custom:"Custom event"};
export const attendanceLabels={invited:"Invited",confirmed:"Confirmed",present:"Present",absent:"Absent"};
export function localDateInput(value:string|null){if(!value)return"";const date=new Date(value);if(!Number.isFinite(date.getTime()))return"";return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
export function inputDate(value:string){const date=new Date(value);return value&&Number.isFinite(date.getTime())?date.toISOString():null;}
export function usePlanningResource(url:string){
  const [data,setData]=useState<PlanningResponse|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true);
  const [dataUrl,setDataUrl]=useState<string|null>(null),[finishedUrl,setFinishedUrl]=useState<string|null>(null);
  const request=useRef<AbortController|null>(null);
  const load=useCallback(()=>{request.current?.abort();const current=new AbortController();request.current=current;
    return fetchJsonWithTimeout<PlanningResponse>(url,{cache:"no-store",signal:current.signal}).then(value=>{if(current.signal.aborted)return false;setData(value);setDataUrl(url);setError("");return true;}).catch(e=>{if(!current.signal.aborted)setError(e instanceof Error?e.message:"Club planning is unavailable. Please try again.");return false;}).finally(()=>{if(!current.signal.aborted){setFinishedUrl(url);setLoading(false);}});
  },[url]);
  useEffect(()=>{void load();return()=>request.current?.abort();},[load]);
  return{data:dataUrl===url?data:null,error:finishedUrl===url?error:"",loading:finishedUrl!==url||loading,reload:load};
}
export function usePlanningMutation(onSaved:(id:string)=>void){
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const controller=useRef<AbortController|null>(null),pending=useRef(false),createRequestId=useRef<string|null>(null);
  useEffect(()=>{const current=new AbortController();controller.current=current;return()=>current.abort();},[]);
  const save=async(body:PlanningMutation)=>{const current=controller.current;if(!current||current.signal.aborted||pending.current)return;pending.current=true;setBusy(true);setError("");
    try{const creating=body.action==="create_goal"||(body.action==="save_event"&&body.id===null);
      if(creating&&!createRequestId.current)createRequestId.current=crypto.randomUUID();
      const payload=creating?{...body,request_id:createRequestId.current}:body;
      const result=await fetchJsonWithTimeout<{id:string}>("/api/club-planning",{method:body.action==="create_goal"?"POST":"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:current.signal});if(!current.signal.aborted)onSaved(result.id);}
    catch(e){if(!current.signal.aborted)setError(e instanceof Error?e.message:"Club planning is unavailable. Please try again.");}
    finally{pending.current=false;if(!current.signal.aborted)setBusy(false);}
  };
  return{save,busy,error};
}
