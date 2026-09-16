"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAdminSession } from "@/hooks/use-admin-session";
import { useI18n, LocalDate } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { invalidateJsonCache } from "@/lib/client-data-cache";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import { TimeRangePicker } from "@/components/time-range-picker";
import { TIME_RANGES, type TimeRangeKey, type TrophyPeriodMetric } from "@/lib/time-range";

export type MemberReview = { player_tag: string; status: "pending" | "reviewed" | "follow_up"; follow_up_at: string | null; notes: string | null; updated_at: string };
export type ReviewMember = { player_tag: string; player_name: string; activity_status?: string; last_battle_at?: string | null; trophies?: number; is_current_member?: boolean; first_seen?: string | null; last_left_at?: string | null; times_joined?: number | null; times_left?: number | null } & Partial<Record<TrophyPeriodMetric, number | null>>;

const localDateInput = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function reviewEnvelope(value: { review: MemberReview | null }) {
  if (!value || !Object.prototype.hasOwnProperty.call(value, "review") || (value.review !== null && (typeof value.review !== "object" || !value.review))) throw new Error("Review unavailable");
  return value;
}

export function MemberReviewButton({ member, initialRange = "7d" }: { member: ReviewMember; initialRange?: TimeRangeKey }) {
  const { isAdmin } = useAdminSession();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!isAdmin) return <Button asChild variant="outline" size="sm"><Link href={`/reviews?member=${encodeURIComponent(member.player_tag)}`}>{t("Member notes")}</Link></Button>;
  return <><Button variant="outline" size="sm" onClick={() => setOpen(true)}>{t("Member notes")}</Button>{open && <MemberReviewSheet key={member.player_tag} member={member} initialRange={initialRange} open onOpenChange={setOpen} />}</>;
}

export function MemberReviewSheet({ member, open, onOpenChange, initialRange = "7d" }: { member: ReviewMember; open: boolean; onOpenChange: (open: boolean) => void; initialRange?: TimeRangeKey }) {
  const { t, direction, number, delta } = useI18n();
  const [range, setRange] = useState<TimeRangeKey>(initialRange);
  const [status, setStatus] = useState<MemberReview["status"]>("pending");
  const [notes, setNotes] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [context, setContext] = useState<ReviewMember>(member);
  const [history, setHistory] = useState<{ first_seen: string | null; times_joined: number | null; times_left: number | null } | null>(() => ({ first_seen: member.first_seen ?? null, times_joined: member.times_joined ?? null, times_left: member.times_left ?? null }));
  const [stale, setStale] = useState(true);
  const [possibleGap, setPossibleGap] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState<string | null>(null);
  const [contextUnavailable, setContextUnavailable] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<{ review: MemberReview | null } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0), latestSequence = useRef(0), pendingSave = useRef(false);
  const load = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    const request = ++sequence.current;
    setLoading(true); setReady(false); setError(""); setSaved(false); setSaving(false); pendingSave.current = false;
    setStale(true); setPossibleGap(false);
    setConflict(false); setLatest(null); setContextUnavailable(false);
    const options = { cache: "no-store" as const, signal: current.signal };
    // Activity is supporting context. A missing former profile must never make
    // an existing private note inaccessible or turn it into a blank overwrite.
    void Promise.allSettled([
      fetchJsonWithTimeout<{ member?: ReviewMember; memberHistory?: typeof history }>(`/api/members/${encodeURIComponent(member.player_tag)}`, options),
      fetchJsonWithTimeout<{ latestFullRun?: { scope?: string; status?: string; warnings?: string[] }; latestRun?: { scope?: string; status?: string; warnings?: string[] }; fullFreshness?: string; freshness?: string; battleFreshness?: string; battleCoverage?: { status?: string } }>("/api/sync/status", options),
    ]).then(([detail, sync]) => {
      if (current.signal.aborted || sequence.current !== request) return;
      if (detail.status === "fulfilled" && detail.value.member) {
        setContext(detail.value.member); if (detail.value.memberHistory) setHistory(detail.value.memberHistory);
      }
      setContextUnavailable(detail.status === "rejected" || !detail.value.member || sync.status === "rejected");
      if (sync.status === "fulfilled") {
        const value = sync.value;
        const fullRun = value.latestFullRun ?? (value.latestRun?.scope === "full" && value.latestRun.status !== "running" ? value.latestRun : null);
        const battleWarning = fullRun?.warnings?.some(code => code === "battle_logs_incomplete" || code === "battle_logs_rate_limited");
        setStale((value.fullFreshness ?? value.freshness) !== "fresh" || value.battleFreshness !== "fresh" || Boolean(battleWarning) || Boolean(fullRun && fullRun.status !== "succeeded"));
        setPossibleGap(value.battleCoverage?.status === "possible_gap");
      } else setStale(true);
    });
    try {
      const { review } = reviewEnvelope(await fetchJsonWithTimeout<{ review: MemberReview | null }>(`/api/member-reviews?player_tag=${encodeURIComponent(member.player_tag)}`, options));
      if (current.signal.aborted || sequence.current !== request) return;
      setStatus(review?.status || "pending"); setNotes(review?.notes || ""); setFollowUp(localDateInput(review?.follow_up_at || null));
      setRevision(review?.updated_at || null);
      setReady(true);
    } catch { if (!current.signal.aborted && sequence.current === request) setError("Review unavailable"); }
    finally { if (!current.signal.aborted && sequence.current === request) setLoading(false); }
  }, [member.player_tag]);
  useEffect(() => { if (open) void load(); return () => { controller.current?.abort(); }; }, [load, open]);

  const loadLatest = async () => {
    const current = controller.current; if (!current || current.signal.aborted) return;
    const request = ++latestSequence.current;
    try {
      const value = reviewEnvelope(await fetchJsonWithTimeout<{ review: MemberReview | null }>(`/api/member-reviews?player_tag=${encodeURIComponent(member.player_tag)}`, { cache: "no-store", signal: current.signal }));
      if (!current.signal.aborted && latestSequence.current === request) setLatest(value);
    } catch { if (!current.signal.aborted && latestSequence.current === request) setError("Review unavailable"); }
  };
  const resolveConflict = (useSaved: boolean) => {
    if (!latest) return;
    setRevision(latest.review?.updated_at || null);
    if (useSaved) { setNotes(latest.review?.notes || ""); setStatus(latest.review?.status || "pending"); setFollowUp(localDateInput(latest.review?.follow_up_at || null)); }
    setConflict(false); setLatest(null); setError(""); setSaved(false);
  };

  const save = async () => {
    const current = controller.current;
    if (!ready || loading || pendingSave.current || conflict || !current || current.signal.aborted) return;
    if (status === "follow_up" && (!followUp || Number.isNaN(new Date(followUp).getTime()))) { setError(t("Follow-up date is required.")); return; }
    pendingSave.current = true; setSaving(true); setError(""); setSaved(false);
    try {
      const response = await fetchJsonWithTimeout<{ review?: MemberReview }>("/api/member-reviews", { method: "PATCH", signal: current.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player_tag: member.player_tag, status, notes, expected_updated_at: revision, follow_up_at: status === "follow_up" ? new Date(followUp).toISOString() : null }) });
      if (current.signal.aborted) return;
      if (response.review) { setRevision(response.review.updated_at); setNotes(response.review.notes || ""); }
      invalidateJsonCache("/api/history");
      window.dispatchEvent(new CustomEvent("member-reviews-updated"));
      setSaved(true);
    } catch (cause) {
      if (current.signal.aborted) return;
      if (cause instanceof Error && cause.message === "Review changed. Reload before saving.") { setConflict(true); setError("Review changed. Reload before saving."); await loadLatest(); }
      else setError("Review unavailable");
    } finally { if (controller.current === current) pendingSave.current = false; if (!current.signal.aborted) setSaving(false); }
  };

  const period = TIME_RANGES[range];
  const progress = context[period.metric];
  const reason = context.activity_status === "inactive" ? "No recently recorded activity"
    : context.activity_status === "minimal" ? "Low activity"
    : progress == null ? "Not enough history"
    : progress <= 0 ? "No trophy progress in the selected period" : "Manual review";

  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side={direction === "rtl" ? "left" : "right"} className="w-full overflow-y-auto sm:max-w-lg">
    <SheetHeader><SheetTitle>{t("Member notes")}: <bdi>{member.player_name}</bdi></SheetTitle><SheetDescription><span className="player-tag">{member.player_tag}</span> · {t("Private notes and follow-ups for current and former members.")}</SheetDescription></SheetHeader>
    <div className="space-y-5 py-5">
      {loading ? <p role="status">{t("Loading...")}</p> : ready && <>
        <label className="block space-y-2"><span className="font-semibold">{t("Member notes / departure reason")}</span><textarea aria-label={t("Member notes / departure reason")} placeholder={t("For example: left to join friends; removed for inactivity on 16 September.")} maxLength={1000} disabled={saving} value={notes} onChange={event => { setNotes(event.target.value); setSaved(false); }} rows={6} className="w-full rounded border bg-background p-3" /><span className="block text-xs text-muted-foreground">{t("Only administrators can read these notes.")} {t("Departure reasons are entered manually; the game does not report who left or was kicked.")}</span></label>
        {member.last_left_at && <p className="text-sm">{t("Last recorded departure")}: <LocalDate value={member.last_left_at} time /></p>}
        {contextUnavailable && <p role="status" className="text-sm text-muted-foreground">{t("Activity details are unavailable. You can still edit this member's notes.")}</p>}
        {possibleGap && <p role="status" className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{t("A possible gap remains in the recorded battle history.")} {t("A fresh fetch does not recover earlier battles that may be absent. Review recorded activity with this limitation in mind.")}</p>}
        {stale && <p role="status" className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{t("Data is stale. Refresh the club before judging inactivity.")}</p>}
        <section className="space-y-3 rounded border p-3"><h3 className="font-semibold">{t("Review context")}</h3><TimeRangePicker value={range} onChange={setRange} /><p>{t("Review reason")}: {t(reason)}</p><p>{t("Recent activity")}: {t(context.activity_status || "Unknown")}</p><p>{t("Last Battle")}: {context.last_battle_at ? <LocalDate value={context.last_battle_at} time /> : t("No recorded battles")}</p><p>{t("Trophy progress · {period}", { period: t(period.label) })}: {progress == null ? t("Not enough history") : delta(progress)}</p></section>
        <section className="space-y-2 rounded border p-3"><h3 className="font-semibold">{t("Membership context")}</h3><p>{t("First observed")}: <LocalDate value={history?.first_seen} /></p><p>{t("Observed joins")}: {history?.times_joined == null ? t("Unknown") : number(history.times_joined)} · {t("Observed departures")}: {history?.times_left == null ? t("Unknown") : number(history.times_left)}</p><p className="text-xs text-muted-foreground">{t("Counts cover the retained tracking period.")}</p></section>
        <label className="block space-y-2"><span>{t("Review status")}</span><select disabled={saving} className="h-10 w-full rounded border bg-background px-3" value={status} onChange={event => { setStatus(event.target.value as MemberReview["status"]); setSaved(false); }}><option value="pending">{t("Pending")}</option><option value="reviewed">{t("Reviewed")}</option><option value="follow_up">{t("Follow up")}</option></select></label>
        {status === "follow_up" && <label className="block space-y-2"><span>{t("Follow-up date")}</span><input disabled={saving} type="datetime-local" dir="ltr" value={followUp} onChange={event => { setFollowUp(event.target.value); setSaved(false); }} className="h-10 w-full rounded border bg-background px-3" /></label>}
        <Button onClick={save} disabled={saving || conflict}>{t(saving ? "Saving..." : "Save review")}</Button>
      </>}
      {error && <div role="alert" className="text-sm text-destructive">{t(error)}{loading ? null : <Button variant="ghost" onClick={conflict ? loadLatest : ready ? save : load} disabled={saving}>{t("Retry")}</Button>}</div>}
      {conflict && latest && <section className="space-y-3 rounded border p-3"><h3 className="font-semibold">{t("Latest saved notes")}</h3><p className="whitespace-pre-wrap break-words text-sm">{latest.review?.notes || t("No private notes")}</p><p className="text-sm">{t("Your draft is still in the editor. Choose which version to keep.")}</p><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => resolveConflict(true)}>{t("Use saved version")}</Button><Button variant="outline" onClick={() => resolveConflict(false)}>{t("Keep my draft")}</Button></div></section>}
      {saved && <p role="status" className="text-sm text-green-500">{t("Review saved")}</p>}
    </div>
  </SheetContent></Sheet>;
}
