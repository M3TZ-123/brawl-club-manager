import "server-only";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { fetchMegaPigSource, SourceProviderError, validateMegaPigSourcePayload } from "@/lib/mega-pig-source-provider";
import type { MegaPigSourcePayload } from "@/lib/mega-pig-source-types";

export type MegaPigSourceCacheSnapshot = {
  payload: MegaPigSourcePayload | null; previousPayload: MegaPigSourcePayload | null;
  fetchedAt: string | null; lastAttemptAt: string | null; nextCheckAt: string | null; changedAt: string | null;
  errorCode: "rate_limited" | "unavailable" | "invalid" | null;
  consecutiveFailures: number; stale: boolean; refreshing: boolean;
};
type Options = { deadlineAt?: number; signal?: AbortSignal };
type Row = Record<string, unknown>;
const pending = new Map<string, Promise<MegaPigSourceCacheSnapshot>>();
const unavailable = () => new Error("Third-party club data is temporarily unavailable.");
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Row;
}
function date(value: unknown, latest = Infinity): string | null {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time<=latest ? new Date(time).toISOString() : null;
}
function payload(value: unknown, clubTag: string): MegaPigSourcePayload | null {
  if (value == null) return null;
  try { const result = validateMegaPigSourcePayload(value, clubTag); return { ...result, members: [...result.members].sort((a,b) => a.playerTag.localeCompare(b.playerTag)) }; }
  catch { return null; }
}
function snapshot(value: unknown, clubTag: string): MegaPigSourceCacheSnapshot {
  const row = object(value), now = Date.now();
  if (row.club_tag !== clubTag) throw unavailable();
  const current = payload(row.payload, clubTag), fetchedAt = date(row.fetched_at, now), lastAttemptAt = date(row.last_attempt_at, now);
  const nextCheckAt = date(row.next_check_at), changedAt = date(row.changed_at, now);
  const errorCode = ["rate_limited", "unavailable", "invalid"].includes(String(row.error_code)) ? row.error_code as MegaPigSourceCacheSnapshot["errorCode"] : row.error_code == null ? null : "invalid";
  return { payload: current, previousPayload: payload(row.previous_payload, clubTag), fetchedAt: current ? fetchedAt : null,
    lastAttemptAt, nextCheckAt, changedAt, errorCode,
    consecutiveFailures: Number.isInteger(row.consecutive_failures) && Number(row.consecutive_failures)>=0 ? Math.min(12,Number(row.consecutive_failures)) : 0,
    stale: !current || !fetchedAt || errorCode !== null || !nextCheckAt || Date.parse(nextCheckAt)<=now
      || (lastAttemptAt !== null && Date.parse(lastAttemptAt)>Date.parse(fetchedAt)),
    refreshing: Date.parse(date(row.lease_expires_at) || "")>now };
}
/** A real timeout also bounds test doubles or transports that ignore AbortSignal. */
async function bounded<T>(work: (signal: AbortSignal)=>PromiseLike<T>, milliseconds: number, parent?: AbortSignal): Promise<T> {
  if (milliseconds<=0 || parent?.aborted) throw unavailable();
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent,controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (()=>void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(()=>{if(signal.aborted)throw unavailable();return work(signal);}),new Promise<T>((_resolve,reject)=>{
      cancel=()=>reject(unavailable()); if(signal.aborted)cancel();else signal.addEventListener("abort",cancel,{once:true});
      timer=setTimeout(()=>controller.abort(),milliseconds);
    })]);
  } finally { if(timer!==undefined)clearTimeout(timer); if(cancel)signal.removeEventListener("abort",cancel); controller.abort(); }
}
async function refresh(clubTag: string, options: Options): Promise<MegaPigSourceCacheSnapshot> {
  const deadlineAt = Math.min(Date.now()+8000,options.deadlineAt ?? Infinity);
  const token = randomUUID();
  const claim = await bounded(signal=>supabaseAdmin.rpc("claim_mega_pig_source_cache",{p_club:clubTag,p_token:token}).abortSignal(signal),Math.min(1500,deadlineAt-Date.now()),options.signal);
  if(claim.error)throw unavailable();
  const data=object(claim.data);
  if(typeof data.acquired!=="boolean")throw unavailable();
  const old=snapshot(data.entry,clubTag);
  if(!data.acquired)return old;
  let newPayload: MegaPigSourcePayload | null=null;
  let errorCode: MegaPigSourceCacheSnapshot["errorCode"]=null, retryAfterSeconds: number | null=null;
  try {
    newPayload = await bounded(signal=>fetchMegaPigSource(clubTag,{signal}),Math.min(5500,deadlineAt-Date.now()-1000),options.signal);
    newPayload=payload(newPayload,clubTag);
    if(!newPayload)throw new SourceProviderError("invalid");
  } catch(error) {
    errorCode=error instanceof SourceProviderError ? error.code : "unavailable";
    retryAfterSeconds=error instanceof SourceProviderError && Number.isFinite(error.retryAfterSeconds)
      ? Math.min(604800,Math.max(0,Math.ceil(error.retryAfterSeconds!))) : null;
  }
  try {
    const finished=await bounded(signal=>supabaseAdmin.rpc("finish_mega_pig_source_cache",{
      p_club:clubTag,p_token:token,p_payload:newPayload,p_error_code:errorCode,p_retry_after_seconds:retryAfterSeconds,
    }).abortSignal(signal),Math.min(1500,deadlineAt-Date.now()));
    if(finished.error)throw unavailable();
    const result=object(finished.data);
    if(result.accepted!==true)throw unavailable();
    return snapshot(result.entry,clubTag);
  } catch { return {...old,stale:true,errorCode:errorCode ?? "unavailable"}; }
}
/** Shared durable cadence; there is intentionally no force-refresh option. */
export async function refreshMegaPigSource(clubTag: string, options: Options={}): Promise<MegaPigSourceCacheSnapshot> {
  if(!/^#[A-Z0-9]{1,20}$/.test(clubTag))throw unavailable();
  const existing=pending.get(clubTag);
  if(existing)return bounded(()=>existing,Math.min(8000,(options.deadlineAt ?? Infinity)-Date.now()),options.signal);
  const request=refresh(clubTag,options).finally(()=>{if(pending.get(clubTag)===request)pending.delete(clubTag);});
  pending.set(clubTag,request);return request;
}
