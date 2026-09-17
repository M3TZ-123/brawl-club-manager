"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAdminSession } from "@/hooks/use-admin-session";
import { useAppStore } from "@/lib/store";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBrawlName } from "@/lib/brawl-text";
import { inputDate, localDateInput } from "@/lib/club-planning-client";
import { megaPigCycleProgress, MEGA_PIG_STANDARD_MILESTONES, MEGA_PIG_RULE_REFERENCE_URL } from "@/lib/mega-pig-progress";
import type { MegaPigArchiveCycle, MegaPigArchiveMember, MegaPigArchiveMutation, MegaPigArchiveResponse, MegaPigObservationSummary, MegaPigRewardStatus } from "@/lib/mega-pig-archive-types";

type View = { mode: "cycles" | "readings" } | { mode: "cycle" | "reading"; id: string } | { mode: "player"; tag: string };
const canonicalTag = (value: string) => value.trim() ? `#${value.trim().replace(/^#/, "").toUpperCase()}` : "";
const integer = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 30000 ? Number(value) : null;
const rewardLabels: Record<MegaPigRewardStatus, string> = { unknown: "Reward not confirmed", received: "Reward received", not_received: "Reward not received" };
const lifecycleLabels = { scheduled: "Scheduled", active: "Cycle active", ended: "Ended · result not finalized", finalized: "Finalized" };
const selectClass = "block w-full min-w-0 rounded border bg-background p-2 mt-1";
const viewKey = (view: View) => `${view.mode}:${"id" in view ? view.id : "tag" in view ? view.tag : ""}`;

class ArchiveRequestError extends Error { constructor(readonly code: string) { super(code); } }
async function archiveRequest<T>(url: string, controller: AbortController, body?: MegaPigArchiveMutation): Promise<T> {
  const transport = new AbortController();
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { transport.abort(); rejectAbort(new ArchiveRequestError("unavailable")); };
  controller.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15_000);
  try {
    if (controller.signal.aborted) abort();
    return await Promise.race([aborted, fetch(url, { cache: "no-store", signal: transport.signal, ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new ArchiveRequestError(response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 409 ? "conflict" : value?.code || "unavailable");
      return value as T;
    })]);
  } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); }
}

function useArchiveSave(onSaved: (id: string) => void) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const request = useRef<AbortController | null>(null), mounted = useRef(false), requestId = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    const cancel = () => { request.current?.abort(); };
    const clubChanged = (event: Event) => { if ((event as CustomEvent<{ clubChanged?: boolean }>).detail?.clubChanged) cancel(); };
    window.addEventListener("admin-session-changed", cancel); window.addEventListener("club-data-updated", clubChanged);
    return () => { mounted.current = false; cancel(); window.removeEventListener("admin-session-changed", cancel); window.removeEventListener("club-data-updated", clubChanged); };
  }, []);
  const save = async (body: MegaPigArchiveMutation) => {
    if (!mounted.current || request.current) return;
    const current = new AbortController(); request.current = current; setBusy(true); setError("");
    if (body.action === "save_cycle") { requestId.current ||= crypto.randomUUID(); body = { ...body, requestId: requestId.current }; }
    try {
      const result = await archiveRequest<{ id: string; version: number; replayed: boolean }>("/api/mega-pig-archive", current, body);
      if (typeof result.id !== "string" || !Number.isInteger(result.version)) throw new ArchiveRequestError("unavailable");
      if (!current.signal.aborted && mounted.current) onSaved(result.id);
    } catch (failure) {
      if (!current.signal.aborted && mounted.current) setError(failure instanceof ArchiveRequestError && failure.code === "conflict" ? "The saved cycle changed. Your draft is preserved. Reload its saved version before retrying." : "Could not save the Mega Pig cycle. Your draft is preserved.");
    } finally { if (request.current === current) { request.current = null; if (mounted.current) setBusy(false); } }
  };
  return { save, busy, error, setError };
}

function FormError({ error, reload, creating = false }: { error: string; reload?: () => void; creating?: boolean }) {
  const { t } = useI18n();
  return error ? <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{t(error)}</p>{reload && <Button type="button" variant="outline" size="sm" onClick={reload}>{t(creating ? "Reload saved history and discard this draft" : "Reload saved version and discard this draft")}</Button>}</div> : null;
}

export function MegaPigCycleForm({ cycle, reading, onSaved, onReload }: { cycle?: MegaPigArchiveCycle; reading: MegaPigObservationSummary | null; onSaved: (id: string) => void; onReload?: () => void }) {
  const { t, number, dateTime } = useI18n();
  // This baseline intentionally stays fixed while the list refreshes. Saving an
  // old draft must meet its original version instead of overwriting newer work.
  const [baseline] = useState(cycle);
  const [title, setTitle] = useState(cycle?.title || ""), [startsAt, setStartsAt] = useState(localDateInput(cycle?.startsAt || null)), [endsAt, setEndsAt] = useState(localDateInput(cycle?.endsAt || null));
  const [milestones, setMilestones] = useState<string[]>(() => cycle ? cycle.milestones?.map(String) || Array(5).fill("") : MEGA_PIG_STANDARD_MILESTONES.map(String));
  const [notes, setNotes] = useState(cycle?.notes || ""), [capture, setCapture] = useState(cycle?.captureEnabled || false);
  const [confirmedReading, setConfirmedReading] = useState<MegaPigObservationSummary | null>(null);
  const { save, busy, error, setError } = useArchiveSave(onSaved);
  const anchored = Boolean(baseline?.initialObservationId), paused = Boolean(baseline?.capturePausedReason);
  const offeredReading = confirmedReading || (reading?.id !== baseline?.initialObservationId ? reading : null);
  const anyMilestone = milestones.some(value => value !== "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const start = startsAt === localDateInput(baseline?.startsAt || null) && baseline ? baseline.startsAt : inputDate(startsAt);
    const end = endsAt === localDateInput(baseline?.endsAt || null) && baseline ? baseline.endsAt : inputDate(endsAt);
    const parsed = milestones.map(integer);
    if (!title.trim() || !start || !end || Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 90 * 86400000) return setError("Enter a title and a valid cycle of no more than 90 days.");
    if (anyMilestone && parsed.some((value, index) => value === null || value < 1 || (index > 0 && value <= (parsed[index - 1] ?? 0)))) return setError("Complete every stage with increasing cumulative wins, or clear all targets.");
    if (capture && ((!anchored && !confirmedReading) || (paused && (!confirmedReading || confirmedReading.id === baseline?.initialObservationId || !notes.trim())))) return setError("Confirm a new reading and explain why it belongs to this same cycle before resuming.");
    void save({ action: "save_cycle", id: baseline?.id || null, version: baseline?.version || 0, requestId: "", cycle: { title: title.trim(), startsAt: start, endsAt: end, milestones: anyMilestone ? parsed as number[] : null, captureEnabled: capture, initialObservationId: confirmedReading?.id || null, notes } });
  };
  return <form onSubmit={submit} className="space-y-3 min-w-0">
    <p className="text-xs text-muted-foreground">{t("Confirm the cycle dates in the game. The source does not provide a verified calendar.")}</p>
    <fieldset disabled={busy} className="space-y-3 min-w-0">
      <label className="block text-sm">{t("Cycle title")}<Input required maxLength={100} value={title} onChange={event => setTitle(event.target.value)}/></label>
      <div className="grid gap-3 sm:grid-cols-2"><label className="block min-w-0 text-sm">{t("Starts at")}<Input className="min-w-0 w-full" required type="datetime-local" dir="ltr" disabled={anchored} value={startsAt} onChange={event => setStartsAt(event.target.value)}/></label><label className="block min-w-0 text-sm">{t("Ends at")}<Input className="min-w-0 w-full" required type="datetime-local" dir="ltr" disabled={anchored} value={endsAt} onChange={event => setEndsAt(event.target.value)}/></label></div>
      {anchored && <p className="text-xs text-muted-foreground">{t("Confirmed readings lock this cycle's dates.")}</p>}
      <div className="rounded border p-3 space-y-2"><p className="text-sm font-medium">{t("Cumulative stage targets")}</p><p className="text-xs text-muted-foreground">{t("16 wins per stage · community-reported rules, adjustable")}</p><div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{milestones.map((value, index) => <label className="min-w-0 text-xs" key={index}>{t("Stage {stage}", { stage: number(index + 1) })}<Input aria-label={t("Stage {stage} cumulative wins", { stage: number(index + 1) })} type="number" min={1} max={30000} step={1} required={anyMilestone} value={value} onChange={event => setMilestones(previous => previous.map((old, position) => position === index ? event.target.value : old))}/></label>)}</div><div className="flex flex-wrap gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => setMilestones(MEGA_PIG_STANDARD_MILESTONES.map(String))}>{t("Use 16-win stage targets")}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setMilestones(Array(5).fill(""))}>{t("Leave targets unknown")}</Button><a className="text-xs text-primary underline self-center" href={MEGA_PIG_RULE_REFERENCE_URL} target="_blank" rel="noopener noreferrer">{t("Rule reference")}</a></div></div>
      {paused && <p role="status" className="text-sm text-amber-600 dark:text-amber-400">{t("Collection paused because counters decreased. Confirm a different reading only if it is still the same cycle.")}</p>}
      {(!anchored || paused) && <div className="space-y-2">{offeredReading ? <><p className="text-xs text-muted-foreground">{t("Reading fetched")}: {dateTime(offeredReading.lastFetchedAt)} · {t("Reported total wins")}: {number(offeredReading.totalWins)}</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={Boolean(confirmedReading)} onChange={event => { setConfirmedReading(event.target.checked ? offeredReading : null); setCapture(event.target.checked); }}/><span>{t(paused ? "I confirm this new reading is still the same cycle" : "I confirm this reading belongs to this cycle")}</span></label></> : <p className="text-sm text-muted-foreground">{t("No new saved reading is available to confirm. You can save the cycle with automatic collection off.")}</p>}</div>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={capture} disabled={(!anchored || paused) && !confirmedReading} onChange={event => setCapture(event.target.checked)}/><span>{t("Collect future source readings automatically for this cycle")}</span></label>
      <label className="block text-sm">{t(paused ? "Reason for confirming the same cycle" : "Private cycle notes")}<textarea className={selectClass} rows={3} maxLength={2000} required={paused && capture} value={notes} onChange={event => setNotes(event.target.value)}/></label>
      <Button type="submit">{t(busy ? "Saving..." : baseline ? "Save cycle changes" : "Create Mega Pig cycle")}</Button>
    </fieldset><FormError error={error} reload={onReload} creating={!baseline}/>
  </form>;
}

export function MegaPigFinalizeForm({ cycle, onSaved, onReload }: { cycle: MegaPigArchiveCycle; onSaved: (id: string) => void; onReload: () => void }) {
  const { t, number } = useI18n();
  const [baseline] = useState(cycle), [wins, setWins] = useState(""), [stage, setStage] = useState(""), [reward, setReward] = useState<MegaPigRewardStatus>("unknown"), [notes, setNotes] = useState(cycle.notes);
  const { save, busy, error, setError } = useArchiveSave(onSaved);
  const maxStage = baseline.milestones?.length ?? 5;
  const submit = (event: FormEvent) => {
    event.preventDefault(); const finalTotalWins = wins === "" ? null : integer(wins), confirmedStage = stage === "" ? null : integer(stage);
    if (Date.now() < Date.parse(baseline.endsAt)) return setError("A cycle can be finalized only after its end time.");
    if ((wins !== "" && finalTotalWins === null) || (stage !== "" && (confirmedStage === null || confirmedStage > maxStage))) return setError("Enter valid nonnegative final wins and a valid stage, or leave them unknown.");
    if (baseline.milestones && finalTotalWins !== null && confirmedStage !== null && baseline.milestones.filter(value => finalTotalWins >= value).length !== confirmedStage) return setError("The confirmed stage must agree with the final wins and saved targets.");
    void save({ action: "finalize_cycle", id: baseline.id, version: baseline.version, finalTotalWins, confirmedStage, rewardStatus: reward, notes });
  };
  return <form onSubmit={submit} className="space-y-3"><p className="text-xs text-muted-foreground">{t("Enter only results you confirmed. Observed wins and rewards are not filled in automatically.")}</p><fieldset disabled={busy} className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">{t("Confirmed final wins, if known")}<Input type="number" min={0} max={30000} step={1} value={wins} onChange={event => setWins(event.target.value)}/></label><label className="text-sm">{t("Confirmed final stage")}<select className={selectClass} value={stage} onChange={event => setStage(event.target.value)}><option value="">{t("Unknown")}</option>{Array.from({ length: maxStage + 1 }, (_, index) => <option key={index} value={index}>{number(index)}</option>)}</select></label></div>
    <label className="block text-sm">{t("Reward receipt")}<select className={selectClass} value={reward} onChange={event => setReward(event.target.value as MegaPigRewardStatus)}>{Object.entries(rewardLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
    <label className="block text-sm">{t("Private cycle notes")}<textarea rows={3} maxLength={2000} className={selectClass} value={notes} onChange={event => setNotes(event.target.value)}/></label><Button type="submit">{t(busy ? "Saving..." : "Finalize cycle")}</Button>
  </fieldset><FormError error={error} reload={onReload}/></form>;
}

export function MegaPigReopenForm({ cycle, onSaved, onReload }: { cycle: MegaPigArchiveCycle; onSaved: (id: string) => void; onReload: () => void }) {
  const { t } = useI18n(); const [baseline] = useState(cycle), [reason, setReason] = useState(""); const { save, busy, error, setError } = useArchiveSave(onSaved);
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (!reason.trim()) return setError("Enter a reason to reopen this cycle."); void save({ action: "reopen_cycle", id: baseline.id, version: baseline.version, reason: reason.trim() }); }}><p className="text-xs text-muted-foreground">{t("Reopening clears the confirmed result and pauses automatic collection. Saved member history remains.")}</p><fieldset disabled={busy} className="space-y-3"><label className="block text-sm">{t("Reason for reopening")}<textarea className={selectClass} required maxLength={2000} rows={3} value={reason} onChange={event => setReason(event.target.value)}/></label><Button type="submit" variant="outline">{t(busy ? "Saving..." : "Reopen cycle")}</Button></fieldset><FormError error={error} reload={onReload}/></form>;
}

export function MegaPigCycleSummary({ cycle, now }: { cycle: MegaPigArchiveCycle; now?: number }) {
  const [initialNow] = useState(() => Date.now());
  const { t, number, dateTime } = useI18n(), progress = megaPigCycleProgress(cycle, now ?? initialNow);
  const observed = cycle.finalizedAt ? megaPigCycleProgress({ ...cycle, finalizedAt: null, finalTotalWins: null, confirmedStage: null }, now ?? initialNow) : null;
  const value = (amount: number | null) => amount === null ? t("Unknown") : number(amount);
  const stage = progress.stage === null ? t("Unknown") : `${number(progress.stage)}/${value(progress.stages)}`;
  const goalLabels = { unknown: "Goal unknown", in_progress: progress.lifecycle === "ended" ? "Observed below target" : "Goal in progress", achieved: progress.basis === "confirmed" ? "Confirmed goal reached" : "Observed target reached", missed: "Confirmed goal not reached" };
  return <div className="space-y-2"><div className="flex flex-wrap gap-2 justify-between"><h3 className="font-semibold break-words">{cycle.title}</h3><span className="text-xs text-muted-foreground">{t(lifecycleLabels[progress.lifecycle])}</span></div><p className="text-xs text-muted-foreground">{dateTime(cycle.startsAt)} – {dateTime(cycle.endsAt)}</p>
    {observed && <p className="text-sm">{t("Observed stage")}: <bdi dir="ltr">{observed.stage === null ? t("Unknown") : `${number(observed.stage)}/${value(observed.stages)}`}</bdi> · {t(observed.goal === "achieved" ? "Observed target reached" : observed.goal === "unknown" ? "Goal unknown" : "Observed below target")}</p>}
    <p className="text-sm">{t(cycle.finalizedAt ? "Confirmed stage" : "Observed stage")}: <bdi dir="ltr">{stage}</bdi> · {t(goalLabels[progress.goal])}</p>
    <p className="text-sm">{t("Last observed club wins")}: {value(cycle.reportedTotalWins)}{cycle.finalizedAt && <> · {t("Confirmed final wins")}: {value(cycle.finalTotalWins)}</>}</p><p className="text-xs text-muted-foreground">{t(rewardLabels[cycle.rewardStatus])}</p>
    {cycle.capturePausedReason && <p className="text-xs text-amber-600 dark:text-amber-400">{t("Collection paused: source counters decreased.")}</p>}
  </div>;
}

export function MegaPigArchivedMember({ member, onPlayer }: { member: MegaPigArchiveMember; onPlayer: (tag: string) => void }) {
  const { t, number, dateTime } = useI18n();
  const counter = (label: string, value: number | null, observedAt: string | null, missing: boolean) => <div><dt className="text-xs text-muted-foreground">{t(label)}</dt><dd className="text-sm">{value === null ? t("Unknown") : number(value)}{value !== null && missing && <span className="text-xs text-muted-foreground"> · {t("Last known; missing from latest reading")}</span>}</dd><dd className="text-xs text-muted-foreground">{t("Observed")}: {dateTime(observedAt)}</dd></div>;
  return <article className="rounded border p-3 min-w-0 space-y-2"><div className="flex flex-wrap justify-between gap-2"><Button type="button" size="sm" variant="link" className="h-auto p-0 text-start whitespace-normal [overflow-wrap:anywhere]" onClick={() => onPlayer(member.playerTag)}>{formatBrawlName(member.playerName, t("Player"))}</Button>{!member.isCurrentMember && <span className="text-xs text-muted-foreground">{t("Former member")}</span>}</div><bdi dir="ltr" className="block text-xs text-muted-foreground">{member.playerTag}</bdi><dl className="grid grid-cols-2 gap-3">{counter("Wins", member.wins, member.winsObservedAt, member.latestWinsUnknown)}{counter("Tickets remaining", member.ticketsRemaining, member.ticketsObservedAt, member.latestTicketsUnknown)}</dl><p className="text-xs text-muted-foreground">{t("Last captured for this member")}: {dateTime(member.lastObservedAt)}</p></article>;
}

function mergedResponse(previous: MegaPigArchiveResponse, value: MegaPigArchiveResponse, mode: View["mode"]) {
  const field = mode === "cycles" ? "cycles" : mode === "readings" ? "observations" : mode === "cycle" ? "members" : "history";
  const rows = [...previous[field] || [], ...value[field] || []];
  const seen = new Set<string>();
  const combined = rows.filter(row => { const key = "id" in row ? row.id : "cycle" in row ? `${row.cycle.id}:${row.member.playerTag}` : row.playerTag; if (seen.has(key)) return false; seen.add(key); return true; });
  const readings = new Map([...previous.playerReadings || [], ...value.playerReadings || []].map(row => [row.observation.id, row]));
  return { ...previous, ...value, [field]: combined, ...(mode === "player" ? { playerReadings: [...readings.values()] } : {}) } as MegaPigArchiveResponse;
}

export function MegaPigArchivePanel({ initialPlayerTag = "" }: { initialPlayerTag?: string } = {}) {
  const { t, number, dateTime } = useI18n(), { isAdmin, isLoading: sessionLoading } = useAdminSession();
  const clubTag = canonicalTag(useAppStore(state => state.clubTag));
  const [view, setView] = useState<View>(() => { const tag = canonicalTag(initialPlayerTag); return /^#[0289PYLQGRJCUV]{2,19}$/.test(tag) ? { mode: "player", tag } : { mode: "cycles" }; }), [revision, setRevision] = useState(0), [edition, setEdition] = useState(0), [search, setSearch] = useState(() => view.mode === "player" ? view.tag : ""), [searchError, setSearchError] = useState(false);
  const key = `${clubTag}:${revision}:${viewKey(view)}`;
  const [snapshot, setSnapshot] = useState<{ key: string; value: MegaPigArchiveResponse } | null>(null), [latest, setLatest] = useState<{ key: string; value: MegaPigObservationSummary | null } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const read = useRef<AbortController | null>(null), blocked = useRef(true), paged = useRef(false);
  const load = useCallback((offset = 0) => {
    if (blocked.current || document.visibilityState === "hidden") return Promise.resolve(false);
    read.current?.abort(); const current = new AbortController(); read.current = current; setLoading(true); setError(false); setNow(Date.now());
    const params = new URLSearchParams();
    if (view.mode !== "cycles") params.set("mode", view.mode);
    if ("id" in view) params.set("id", view.id); if (view.mode === "player") params.set("player", view.tag);
    if (view.mode !== "reading") params.set("offset", String(offset));
    return archiveRequest<MegaPigArchiveResponse>(`/api/mega-pig-archive?${params}`, current).then(value => {
      if (current.signal.aborted || blocked.current || read.current !== current) return false;
      const collection = view.mode === "cycles" ? value.cycles : view.mode === "readings" ? value.observations : view.mode === "cycle" ? value.members : view.mode === "player" ? value.history : value.observation?.members;
      if (!value || canonicalTag(value.clubTag) !== clubTag || !Array.isArray(collection)
        || (view.mode === "cycle" && value.cycle?.id !== view.id) || (view.mode === "reading" && value.observation?.id !== view.id) || (view.mode === "player" && value.playerTag !== view.tag)
        || (value.nextOffset != null && (!Number.isInteger(value.nextOffset) || value.nextOffset <= offset))) throw new ArchiveRequestError("invalid_response");
      setSnapshot(previous => ({ key, value: offset && previous?.key === key ? mergedResponse(previous.value, value, view.mode) : value }));
      paged.current = offset > 0;
      if (value.latestObservation !== undefined) setLatest({ key: `${clubTag}:${revision}`, value: value.latestObservation });
      return true;
    }).catch(failure => { if (!current.signal.aborted && !blocked.current && read.current === current) { setError(true); if (failure instanceof ArchiveRequestError && ["unauthorized", "conflict", "not_found", "invalid_response"].includes(failure.code)) setSnapshot(null); } return false; }).finally(() => { if (read.current === current) { read.current = null; if (!current.signal.aborted && !blocked.current) setLoading(false); } });
  }, [view, clubTag, key, revision]);
  useEffect(() => {
    const clear = () => { blocked.current = true; read.current?.abort(); read.current = null; setSnapshot(null); setLatest(null); setSearch(""); setSearchError(false); setError(false); setRevision(value => value + 1); setView({ mode: "cycles" }); };
    const clubChanged = (event: Event) => { if ((event as CustomEvent<{ clubChanged?: boolean }>).detail?.clubChanged) clear(); };
    window.addEventListener("admin-session-changed", clear); window.addEventListener("club-data-updated", clubChanged);
    return () => { blocked.current = true; read.current?.abort(); window.removeEventListener("admin-session-changed", clear); window.removeEventListener("club-data-updated", clubChanged); };
  }, []);
  useEffect(() => {
    blocked.current = !isAdmin || sessionLoading || !clubTag;
    if (blocked.current) return;
    let cancelled = false; void Promise.resolve().then(() => { if (!cancelled) return load(); });
    const refresh = () => { if (!read.current && !paged.current) void load(); };
    const timer = setInterval(refresh, 120_000); window.addEventListener("focus", refresh); window.addEventListener("club-data-updated", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { cancelled = true; blocked.current = true; read.current?.abort(); read.current = null; clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("club-data-updated", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [isAdmin, sessionLoading, clubTag, revision, load]);

  if (!isAdmin || sessionLoading) return null;
  const data = snapshot?.key === key ? snapshot.value : null;
  const reading = latest?.key === `${clubTag}:${revision}` ? latest.value : null;
  const saved = (id: string) => { if (view.mode === "cycle" && view.id === id) void load().then(ok => { if (ok) setEdition(value => value + 1); }); else { setEdition(value => value + 1); setView({ mode: "cycle", id }); } };
  const reloadDraft = () => { void load().then(ok => { if (ok) setEdition(value => value + 1); }); };
  const openPlayer = (tag: string) => { setSearch(tag); setSearchError(false); setView({ mode: "player", tag }); };
  const detail = view.mode === "cycle" || view.mode === "reading";
  return <section id="mega-pig-history" className="rounded-lg border p-4 space-y-4 min-w-0 scroll-mt-20" aria-label={t("Mega Pig history")}>
    <header className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">{t("Mega Pig history")}</h2><p className="text-xs text-muted-foreground">{t("Saved source readings and confirmed cycles stay available when members leave.")}</p></div><Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>{t("Refresh history")}</Button></header>
    {detail ? <Button type="button" variant="outline" size="sm" onClick={() => setView({ mode: view.mode === "reading" ? "readings" : "cycles" })}>{t("Back to history")}</Button> : <div className="flex flex-wrap gap-2" role="group" aria-label={t("Mega Pig history view")}><Button type="button" size="sm" variant={view.mode === "cycles" ? "default" : "outline"} aria-pressed={view.mode === "cycles"} onClick={() => setView({ mode: "cycles" })}>{t("Cycles")}</Button><Button type="button" size="sm" variant={view.mode === "readings" ? "default" : "outline"} aria-pressed={view.mode === "readings"} onClick={() => setView({ mode: "readings" })}>{t("Saved readings")}</Button></div>}
    {!detail && <form className="flex gap-2 items-end" onSubmit={event => { event.preventDefault(); const tag = canonicalTag(search); if (!/^#[0289PYLQGRJCUV]{2,19}$/.test(tag)) { setSearchError(true); return; } openPlayer(tag); }}><label className="min-w-0 flex-1 text-xs">{t("Find a member across cycles by tag")}<Input dir="ltr" value={search} onChange={event => setSearch(event.target.value)} placeholder="#TAG"/></label><Button type="submit" variant="outline" size="sm">{t("Find")}</Button></form>}
    {searchError && <p role="alert" className="text-sm text-destructive">{t("Enter a valid player tag, not a player name.")}</p>}
    {loading && !data && <p role="status" className="text-sm">{t("Loading...")}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{t(data ? "History refresh failed. Showing the last saved view; use Refresh history to retry." : "Mega Pig history is unavailable. Use Refresh history to retry.")}</p>}
    {view.mode === "cycles" && <>
      <details key={`create:${clubTag}:${revision}:${edition}`} className="rounded border p-3"><summary className="cursor-pointer text-sm font-medium">{t("Add a Mega Pig cycle")}</summary><div className="mt-3"><MegaPigCycleForm reading={reading} onSaved={saved} onReload={reloadDraft}/></div></details>
      {data?.cycles?.length === 0 && <p className="text-sm text-muted-foreground">{t("No cycles yet. Saved readings are available even before cycle dates are confirmed.")}</p>}
      <div className="space-y-3">{data?.cycles?.map(cycle => <article key={cycle.id} className="rounded border p-3 space-y-3"><MegaPigCycleSummary cycle={cycle} now={now}/><Button type="button" size="sm" variant="outline" onClick={() => setView({ mode: "cycle", id: cycle.id })}>{t("Open cycle")}</Button></article>)}</div>
    </>}
    {view.mode === "readings" && <><p className="text-xs text-muted-foreground">{t("Source readings do not identify their game cycle. Fetch dates alone do not confirm a cycle.")}</p>{data?.observations?.length === 0 && <p className="text-sm text-muted-foreground">{t("No source readings have been saved yet.")}</p>}<div className="space-y-2">{data?.observations?.map(observation => <article key={observation.id} className="rounded border p-3 space-y-2"><p className="text-sm">{t("Reported total wins")}: {number(observation.totalWins)} · {t("Players reported by source")}: {number(observation.reportedPlayersPlayed)}</p><p className="text-xs text-muted-foreground">{t("Reading fetched")}: {dateTime(observation.lastFetchedAt)}</p><Button type="button" size="sm" variant="outline" onClick={() => setView({ mode: "reading", id: observation.id })}>{t("Open saved reading")}</Button></article>)}</div></>}
    {view.mode === "reading" && data?.observation && <div className="space-y-3"><p className="text-sm">{t("Reported total wins")}: {number(data.observation.totalWins)} · {t("Reading fetched")}: {dateTime(data.observation.lastFetchedAt)}</p><details className="rounded border p-3"><summary className="cursor-pointer text-sm font-medium">{t("Create a cycle from this reading")}</summary><div className="mt-3"><MegaPigCycleForm key={`${key}:${edition}`} reading={data.observation} onSaved={saved} onReload={reloadDraft}/></div></details><div className="grid gap-2 sm:grid-cols-2">{data.observation.members.map(member => <article key={member.playerTag} className="rounded border p-3 min-w-0 space-y-1"><Button type="button" variant="link" className="h-auto p-0 whitespace-normal text-start [overflow-wrap:anywhere]" onClick={() => openPlayer(member.playerTag)}>{formatBrawlName(member.playerName, t("Player"))}</Button><bdi dir="ltr" className="block text-xs text-muted-foreground">{member.playerTag}</bdi><p className="text-sm">{t("Wins")}: {member.reportedWins === null ? t("Unknown") : number(member.reportedWins)} · {t("Tickets remaining")}: {member.reportedTicketsRemaining === null ? t("Unknown") : number(member.reportedTicketsRemaining)}</p></article>)}</div></div>}
    {view.mode === "cycle" && data?.cycle && <div className="space-y-4"><MegaPigCycleSummary cycle={data.cycle} now={now}/><p className="text-xs text-muted-foreground">{t(data.cycle.finalizedAt || now >= Date.parse(data.cycle.endsAt) ? "Collection ended" : !data.cycle.captureEnabled ? "Automatic collection off" : now < Date.parse(data.cycle.startsAt) ? "Automatic collection scheduled" : "Automatic collection enabled")} · {t("Last captured reading")}: {dateTime(data.cycle.lastCapturedAt)}</p>
      {data.cycle.finalizedAt ? <details className="rounded border p-3"><summary className="cursor-pointer text-sm">{t("Reopen a confirmed result")}</summary><div className="mt-3"><MegaPigReopenForm key={`${key}:reopen:${edition}`} cycle={data.cycle} onSaved={saved} onReload={reloadDraft}/></div></details> : <><details className="rounded border p-3"><summary className="cursor-pointer text-sm">{t("Edit cycle and collection")}</summary><div className="mt-3"><MegaPigCycleForm key={`${key}:edit:${edition}`} cycle={data.cycle} reading={reading} onSaved={saved} onReload={reloadDraft}/></div></details>{now >= Date.parse(data.cycle.endsAt) && <details className="rounded border p-3"><summary className="cursor-pointer text-sm">{t("Confirm the final result")}</summary><div className="mt-3"><MegaPigFinalizeForm key={`${key}:final:${edition}`} cycle={data.cycle} onSaved={saved} onReload={reloadDraft}/></div></details>}</>}
      <h3 className="font-medium text-sm">{t("Retained member contributions")}</h3><p className="text-xs text-muted-foreground">{t("Departures keep the last captured contribution. Missing later values stay labelled as last known.")}</p>{data.members?.length === 0 && <p className="text-sm text-muted-foreground">{t("No member readings have been assigned to this cycle yet.")}</p>}<div className="grid gap-2 sm:grid-cols-2">{data.members?.map(member => <MegaPigArchivedMember key={member.playerTag} member={member} onPlayer={openPlayer}/>)}</div>
    </div>}
    {view.mode === "player" && <div className="space-y-3"><h3 className="font-medium text-sm">{t("Member history")} · <bdi dir="ltr">{view.tag}</bdi></h3>{data?.history?.length === 0 && <p className="text-sm text-muted-foreground">{t("No saved cycle contributions for this tag yet.")}</p>}{data?.history?.map(row => <article key={row.cycle.id} className="rounded border p-3 space-y-3"><MegaPigCycleSummary cycle={row.cycle} now={now}/><MegaPigArchivedMember member={row.member} onPlayer={openPlayer}/><Button type="button" size="sm" variant="outline" onClick={() => setView({ mode: "cycle", id: row.cycle.id })}>{t("Open cycle")}</Button></article>)}</div>}
    {view.mode === "player" && data && <details open={!data.history?.length} className="rounded border p-3"><summary className="cursor-pointer text-sm font-medium">{t("Saved source readings")}</summary><div className="mt-3 space-y-2"><p className="text-xs text-muted-foreground">{t("Source readings do not identify their game cycle. Fetch dates alone do not confirm a cycle.")}</p>{!data.playerReadings?.length && <p className="text-sm text-muted-foreground">{t("No saved source readings for this tag yet.")}</p>}{data.playerReadings?.map(row => <article key={row.observation.id} className="rounded border p-3 space-y-1 min-w-0"><p className="text-sm font-medium break-words">{formatBrawlName(row.member.playerName, t("Player"))} <bdi dir="ltr" className="text-xs text-muted-foreground">{row.member.playerTag}</bdi></p><p className="text-sm">{t("Wins")}: {row.member.reportedWins === null ? t("Unknown") : number(row.member.reportedWins)} · {t("Tickets remaining")}: {row.member.reportedTicketsRemaining === null ? t("Unknown") : number(row.member.reportedTicketsRemaining)}</p><p className="text-xs text-muted-foreground">{t("First fetched")}: {dateTime(row.observation.firstFetchedAt)}</p><p className="text-xs text-muted-foreground">{t("Last fetched from source")}: {dateTime(row.observation.lastFetchedAt)}</p></article>)}</div></details>}
    {data?.nextOffset != null && <Button type="button" variant="outline" disabled={loading} onClick={() => void load(data.nextOffset!)}>{t(loading ? "Loading..." : "Load more")}</Button>}
    <p className="text-xs text-muted-foreground">{t("Source readings do not prove attendance or reward receipt. Final results require your confirmation.")}</p>
  </section>;
}
