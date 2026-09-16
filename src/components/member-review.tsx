"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdminSession } from "@/hooks/use-admin-session";
import { useI18n, LocalDate } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { invalidateJsonCache } from "@/lib/client-data-cache";
import { TimeRangePicker } from "@/components/time-range-picker";
import { TIME_RANGES, type TimeRangeKey, type TrophyPeriodMetric } from "@/lib/time-range";

export type MemberReview = { player_tag: string; status: "pending" | "reviewed" | "follow_up"; follow_up_at: string | null; notes: string | null; updated_at: string };
export type ReviewMember = { player_tag: string; player_name: string; activity_status?: string; last_battle_at?: string | null; trophies?: number } & Partial<Record<TrophyPeriodMetric, number | null>>;

const localDateInput = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function MemberReviewButton({ member, initialRange = "7d" }: { member: ReviewMember; initialRange?: TimeRangeKey }) {
  const { isAdmin } = useAdminSession();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!isAdmin) return null;
  return <><Button variant="outline" size="sm" onClick={() => setOpen(true)}>{t("Review member")}</Button>{open && <MemberReviewSheet member={member} initialRange={initialRange} open onOpenChange={setOpen} />}</>;
}

export function MemberReviewSheet({ member, open, onOpenChange, initialRange = "7d" }: { member: ReviewMember; open: boolean; onOpenChange: (open: boolean) => void; initialRange?: TimeRangeKey }) {
  const { t, direction, number, delta } = useI18n();
  const [range, setRange] = useState<TimeRangeKey>(initialRange);
  const [status, setStatus] = useState<MemberReview["status"]>("pending");
  const [notes, setNotes] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [context, setContext] = useState<ReviewMember>(member);
  const [history, setHistory] = useState<{ first_seen: string | null; times_joined: number | null; times_left: number | null } | null>(null);
  const [stale, setStale] = useState(true);
  const [possibleGap, setPossibleGap] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setReady(false); setError(""); setSaved(false);
    try {
      const responses = await Promise.all([
        fetch(`/api/member-reviews?player_tag=${encodeURIComponent(member.player_tag)}`, { cache: "no-store" }),
        fetch(`/api/members/${encodeURIComponent(member.player_tag)}`, { cache: "no-store" }),
        fetch("/api/sync/status", { cache: "no-store" }),
      ]);
      if (responses.some(response => !response.ok)) throw new Error("Review unavailable");
      const [{ review }, detail, sync] = await Promise.all(responses.map(response => response.json()));
      if (!detail.member) throw new Error("Review unavailable");
      setStatus(review?.status || "pending"); setNotes(review?.notes || ""); setFollowUp(localDateInput(review?.follow_up_at || null));
      setContext(detail.member);
      setHistory(detail.memberHistory || null);
      const fullRun = sync.latestFullRun ?? (sync.latestRun?.scope === "full" && sync.latestRun.status !== "running" ? sync.latestRun : null);
      const battleWarning = Array.isArray(fullRun?.warnings) && fullRun.warnings.some((code: string) => code === "battle_logs_incomplete" || code === "battle_logs_rate_limited");
      setStale((sync.fullFreshness ?? sync.freshness) !== "fresh" || sync.battleFreshness !== "fresh" || Boolean(battleWarning) || Boolean(fullRun && fullRun.status !== "succeeded"));
      setPossibleGap(sync.battleCoverage?.status === "possible_gap");
      setReady(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Review unavailable"); }
    finally { setLoading(false); }
  }, [member.player_tag]);
  useEffect(() => { if (open) void load(); }, [load, open]);

  const save = async () => {
    if (!ready || loading || saving) return;
    if (status === "follow_up" && (!followUp || Number.isNaN(new Date(followUp).getTime()))) { setError(t("Follow-up date is required.")); return; }
    setSaving(true); setError(""); setSaved(false);
    try {
      const response = await fetch("/api/member-reviews", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player_tag: member.player_tag, status, notes, follow_up_at: status === "follow_up" ? new Date(followUp).toISOString() : null }) });
      if (!response.ok) throw new Error(t("Review unavailable"));
      invalidateJsonCache("/api/history");
      window.dispatchEvent(new CustomEvent("member-reviews-updated"));
      setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("Review unavailable")); }
    finally { setSaving(false); }
  };

  const period = TIME_RANGES[range];
  const progress = context[period.metric];
  const reason = context.activity_status === "inactive" ? "No recently recorded activity"
    : context.activity_status === "minimal" ? "Low activity"
    : progress == null ? "Not enough history"
    : progress <= 0 ? "No trophy progress in the selected period" : "Manual review";

  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side={direction === "rtl" ? "left" : "right"} className="w-full overflow-y-auto sm:max-w-lg">
    <SheetHeader><SheetTitle>{t("Review member")}: <bdi>{member.player_name}</bdi></SheetTitle><SheetDescription><span className="player-tag">{member.player_tag}</span> · {t("Review activity and membership context before deciding what to do in the game.")}</SheetDescription></SheetHeader>
    <div className="space-y-5 py-5">
      {loading ? <p role="status">{t("Loading...")}</p> : ready && <>
        {possibleGap && <p role="status" className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{t("A possible gap remains in the recorded battle history.")} {t("A fresh fetch does not recover earlier battles that may be absent. Review recorded activity with this limitation in mind.")}</p>}
        {stale && <p role="status" className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{t("Data is stale. Refresh the club before judging inactivity.")}</p>}
        <section className="space-y-3 rounded border p-3"><h3 className="font-semibold">{t("Review context")}</h3><TimeRangePicker value={range} onChange={setRange} /><p>{t("Review reason")}: {t(reason)}</p><p>{t("Recent activity")}: {t(context.activity_status || "Unknown")}</p><p>{t("Last Battle")}: {context.last_battle_at ? <LocalDate value={context.last_battle_at} time /> : t("No recorded battles")}</p><p>{t("Trophy progress · {period}", { period: t(period.label) })}: {progress == null ? t("Not enough history") : delta(progress)}</p></section>
        <section className="space-y-2 rounded border p-3"><h3 className="font-semibold">{t("Membership context")}</h3><p>{t("First observed")}: <LocalDate value={history?.first_seen} /></p><p>{t("Observed joins")}: {history?.times_joined == null ? t("Unknown") : number(history.times_joined)} · {t("Observed departures")}: {history?.times_left == null ? t("Unknown") : number(history.times_left)}</p><p className="text-xs text-muted-foreground">{t("Counts cover the retained tracking period.")}</p></section>
        <label className="block space-y-2"><span>{t("Review status")}</span><select className="h-10 w-full rounded border bg-background px-3" value={status} onChange={event => setStatus(event.target.value as MemberReview["status"])}><option value="pending">{t("Pending")}</option><option value="reviewed">{t("Reviewed")}</option><option value="follow_up">{t("Follow up")}</option></select></label>
        {status === "follow_up" && <label className="block space-y-2"><span>{t("Follow-up date")}</span><input type="datetime-local" dir="ltr" value={followUp} onChange={event => setFollowUp(event.target.value)} className="h-10 w-full rounded border bg-background px-3" /></label>}
        <label className="block space-y-2"><span>{t("Private notes")}</span><textarea maxLength={1000} value={notes} onChange={event => setNotes(event.target.value)} rows={5} className="w-full rounded border bg-background p-3" /><span className="block text-xs text-muted-foreground">{t("Only administrators can read these notes.")}</span></label>
        <Button onClick={save} disabled={saving}>{t(saving ? "Saving..." : "Save review")}</Button>
      </>}
      {error && <div role="alert" className="text-sm text-destructive">{t(error)}{loading ? null : <Button variant="ghost" onClick={ready ? save : load} disabled={saving}>{t("Retry")}</Button>}</div>}
      {saved && <p role="status" className="text-sm text-green-500">{t("Review saved")}</p>}
    </div>
  </SheetContent></Sheet>;
}
