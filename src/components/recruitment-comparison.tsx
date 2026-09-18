"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAdminSession } from "@/hooks/use-admin-session";
import { useI18n } from "@/components/locale-provider";
import { MemberReviewButton } from "@/components/member-review";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import { compareMembers, comparisonReasonLabels as reasonLabels, sortComparisonMembers } from "@/lib/member-comparison";
import type { ComparisonBucket, ComparisonCandidate, ComparisonMember, ComparisonSubject, MemberComparisonRange, MemberComparisonResponse } from "@/lib/member-comparison-types";
import type { Candidate } from "@/lib/recruitment-data";
import { TIME_RANGES } from "@/lib/time-range";

export type ComparisonSelection = { memberTag?: string; candidateTag?: string; range?: string };
type Subject = ComparisonMember | ComparisonCandidate;
type Order = "review" | "activity" | "attendance";
const ranges: MemberComparisonRange[] = ["7d", "30d", "90d"];
const buckets: Record<ComparisonBucket, string> = { review: "Review first", followup: "Follow up", noConcern: "No supported concern", protected: "Protected", insufficient: "Insufficient evidence" };
const confidenceLabels = { sufficient: "Sufficient observed evidence", limited: "Limited evidence", insufficient: "Insufficient evidence" };
const metricLabels = { activeDays: "Observed active days", eventAttendance: "Recorded attendance", trophies: "Trophies", power11: "Power 11 brawlers", rankedPoints: "Ranked points" };
const comparisonLimits = { unknown: "Comparable data is missing", stale: "Refresh the profiles before comparing this value", different_season: "Ranked seasons are different or unknown", different_exposure: "The players have different observation windows", candidate_commitment_unknown: "Candidate activity and event reliability are unknown", comparable: "" };
const tagValue = (value?: string) => value?.trim() ? `#${value.trim().replace(/^#/, "").toUpperCase()}` : "";
const selectedRange = (value?: string): MemberComparisonRange => ranges.includes(value as MemberComparisonRange) ? value as MemberComparisonRange : "7d";
const initialSubjects = (selection?: ComparisonSelection): [ComparisonSubject | null, ComparisonSubject | null] => {
  const member = tagValue(selection?.memberTag), candidate = tagValue(selection?.candidateTag);
  return member ? [{ kind: "member", tag: member }, candidate ? { kind: "candidate", tag: candidate } : null] : [null, candidate ? { kind: "candidate", tag: candidate } : null];
};
const subjectKey = (subject: ComparisonSubject | null) => subject ? `${subject.kind}:${subject.tag}` : "";
const parseSubject = (value: string): ComparisonSubject | null => {
  const [kind, tag] = value.split(":");
  return (kind === "member" || kind === "candidate") && tag ? { kind, tag } : null;
};
const subjectFrom = (data: MemberComparisonResponse, selected: ComparisonSubject | null): Subject | undefined => selected ? (selected.kind === "member" ? data.members : data.candidates).find(row => row.tag === selected.tag) : undefined;

export function RecruitmentComparison({ active, initialSelection, onAddCandidate, onCandidateUpdated }: {
  active: boolean; initialSelection?: ComparisonSelection; onAddCandidate: () => void; onCandidateUpdated: (candidate: Candidate) => void;
}) {
  const { t, number, delta, dateTime, reportDate } = useI18n();
  const { isAdmin, isLoading: sessionLoading } = useAdminSession();
  const [range, setRange] = useState<MemberComparisonRange>(() => selectedRange(initialSelection?.range));
  const [selection, setSelection] = useState<[ComparisonSubject | null, ComparisonSubject | null]>(() => initialSubjects(initialSelection));
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ComparisonBucket | "all">("all");
  const [order, setOrder] = useState<Order>("review");
  const [snapshot, setSnapshot] = useState<{ range: MemberComparisonRange; value: MemberComparisonResponse; expiresAt: number } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(false), [profileError, setProfileError] = useState(false);
  const [refreshingProfile, setRefreshingProfile] = useState<string | null>(null), [sessionRevision, setSessionRevision] = useState(0);
  const read = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null), blocked = useRef(true), mounted = useRef(false);
  const callbacks = useRef({ onCandidateUpdated }); callbacks.current = { onCandidateUpdated };

  const load = useCallback(() => {
    if (blocked.current) return;
    read.current?.abort(); const current = new AbortController(); read.current = current;
    setLoading(true); setError(false);
    return fetchJsonWithTimeout<MemberComparisonResponse>(`/api/member-comparison?range=${range}`, { cache: "no-store", signal: current.signal }).then(value => {
      if (current.signal.aborted || blocked.current) return;
      if (!value || value.period?.key !== range || !Array.isArray(value.members) || !Array.isArray(value.candidates) || !value.policy || !value.groups || typeof value.clubTag !== "string") throw new Error("Invalid comparison response");
      const receivedAt = Date.now(), today = new Date(receivedAt);
      const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
      setSnapshot({ range, value, expiresAt: Math.min(receivedAt + 120_000, midnight) });
    }).catch(() => { if (!current.signal.aborted && !blocked.current) { setSnapshot(null); setError(true); } })
      .finally(() => { if (!current.signal.aborted && !blocked.current) setLoading(false); });
  }, [range]);

  useEffect(() => {
    mounted.current = true;
    const changed = () => {
      blocked.current = true; read.current?.abort(); write.current?.abort(); setSnapshot(null); setSelection([null, null]);
      setSearch(""); setError(false); setProfileError(false); setRefreshingProfile(null); setSessionRevision(value => value + 1);
    };
    const clubChanged = (event: Event) => {
      if (!(event as CustomEvent<{ clubChanged?: boolean }>).detail?.clubChanged) return;
      read.current?.abort(); write.current?.abort(); setSnapshot(null); setSelection([null, null]);
      setSearch(""); setProfileError(false); setError(false); setRefreshingProfile(null);
    };
    window.addEventListener("admin-session-changed", changed);
    window.addEventListener("club-data-updated", clubChanged);
    return () => { mounted.current = false; blocked.current = true; read.current?.abort(); write.current?.abort(); window.removeEventListener("admin-session-changed", changed); window.removeEventListener("club-data-updated", clubChanged); };
  }, []);

  useEffect(() => {
    blocked.current = !active || !isAdmin || sessionLoading;
    if (blocked.current) return;
    if (document.visibilityState !== "hidden") void load();
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ clubChanged?: boolean; datasets?: string[] }>).detail;
      if (detail?.datasets && !detail.clubChanged && !detail.datasets.some(value => ["roster", "battles", "ranked", "settings"].includes(value))) return;
      if (document.visibilityState === "hidden") return;
      void load();
    };
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("club-data-updated", changed); window.addEventListener("club-administration-updated", changed); window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => {
      blocked.current = true; read.current?.abort(); write.current?.abort();
      window.removeEventListener("club-data-updated", changed); window.removeEventListener("club-administration-updated", changed); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible);
    };
  }, [active, isAdmin, sessionLoading, sessionRevision, load]);

  useEffect(() => {
    if (!active || !isAdmin || sessionLoading || !snapshot) return;
    // A comparison is an as-of snapshot: re-read its evidence instead of changing
    // generatedAt locally, which would incorrectly move its completed-day window.
    const timer = setTimeout(() => {
      if (blocked.current) return;
      setSnapshot(null);
      if (document.visibilityState !== "hidden") void load();
    }, Math.max(0, snapshot.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [active, isAdmin, sessionLoading, snapshot, load]);

  const refreshProfile = async (tag: string) => {
    if (blocked.current || (write.current && !write.current.signal.aborted)) return;
    const current = new AbortController(); write.current = current; setRefreshingProfile(tag); setProfileError(false);
    try {
      const result = await fetchJsonWithTimeout<{ candidate: Candidate }>("/api/recruitment", { method: "POST", signal: current.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player_tag: tag }) });
      if (current.signal.aborted || blocked.current) return;
      if (result.candidate?.player_tag !== tag) throw new Error("Invalid candidate response");
      callbacks.current.onCandidateUpdated(result.candidate); await load();
    } catch { if (!current.signal.aborted && !blocked.current) setProfileError(true); }
    finally { if (write.current === current) { write.current = null; if (mounted.current) setRefreshingProfile(null); } }
  };

  if (!active || !isAdmin || sessionLoading) return null;
  const data = snapshot?.range === range && snapshot.expiresAt > Date.now() ? snapshot.value : null;
  const [leftSelection, rightSelection] = selection;
  const left = data ? subjectFrom(data, leftSelection) : undefined, right = data ? subjectFrom(data, rightSelection) : undefined;
  const samePlayer = Boolean(leftSelection && rightSelection && leftSelection.tag === rightSelection.tag);
  const pair = data && left && right && !samePlayer ? compareMembers(data, left, right) : null;
  const text = search.trim().toLowerCase();
  const members = data ? sortComparisonMembers(data.members, order).filter(member => (filter === "all" || member.assessment.bucket === filter) && (!text || `${member.name} ${member.tag}`.toLowerCase().includes(text))) : [];
  const unknownNumber = (value: number | null) => value == null ? t("Unknown") : number(value);
  const confidenceText = (member: ComparisonMember) => {
    const confidence = t(confidenceLabels[member.assessment.confidence]);
    return confidence === t(buckets[member.assessment.bucket]) ? null : confidence;
  };
  const choice = (position: 0 | 1, value: string) => { setSelection(previous => position === 0 ? [parseSubject(value), previous[1]] : [previous[0], parseSubject(value)]); setProfileError(false); };
  const picker = (position: 0 | 1) => <label className="block min-w-0 space-y-1 text-sm"><span>{t(position === 0 ? "First player" : "Compare with")}</span><select className="h-10 w-full min-w-0 rounded border bg-background px-2" value={subjectKey(selection[position])} onChange={event => choice(position, event.target.value)}>
    <option value="">{t("Choose a player")}</option>
    {selection[position] && !subjectFrom(data!, selection[position]) && <option value={subjectKey(selection[position])}>{selection[position]!.tag}</option>}
    <optgroup label={t("Current Members")}>{data?.members.map(member => <option key={member.tag} value={`member:${member.tag}`} disabled={member.tag === selection[1 - position]?.tag}>{member.name} · {member.tag}</option>)}</optgroup>
    <optgroup label={t("Candidates")}>{data?.candidates.map(candidate => <option key={candidate.tag} value={`candidate:${candidate.tag}`} disabled={candidate.tag === selection[1 - position]?.tag}>{candidate.name} · {candidate.tag}</option>)}</optgroup>
  </select></label>;
  const subjectSummary = (subject: Subject) => <div className="min-w-0 space-y-2 rounded-lg border p-3" key={`${subject.kind}:${subject.tag}`}>
    <p className="break-words font-semibold"><bdi>{subject.name}</bdi></p><p className="text-xs text-muted-foreground"><bdi dir="ltr">{subject.tag}</bdi> · {t(subject.kind === "member" ? "Current member" : "Candidate")}</p>
    {subject.kind === "member" ? <><p className="text-sm">{[t(buckets[subject.assessment.bucket]), confidenceText(subject)].filter(Boolean).join(" · ")}</p><MemberReviewButton member={{ player_tag: subject.tag, player_name: subject.name, is_current_member: true }} initialRange={range}/></>
      : <><p className="text-xs text-muted-foreground">{t("Candidate activity and event reliability are unknown")}</p><Button size="sm" variant="outline" disabled={Boolean(refreshingProfile)} onClick={() => void refreshProfile(subject.tag)}>{t(refreshingProfile === subject.tag ? "Loading..." : "Load profile")}</Button></>}
  </div>;

  return <div className="mx-auto max-w-5xl space-y-4 min-w-0">
    <header className="flex flex-wrap items-start justify-between gap-3"><h2 className="text-xl font-bold">{t("Review the roster before deciding")}</h2><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>{t("Refresh")}</Button><Button variant="outline" size="sm" onClick={onAddCandidate}>{t("Add candidate")}</Button></div></header>
    <div role="group" aria-label={t("Comparison period")} className="flex flex-wrap gap-2">{ranges.map(value => <Button key={value} size="sm" variant={range === value ? "default" : "outline"} aria-pressed={range === value} onClick={() => { setRange(value); setProfileError(false); setRefreshingProfile(null); }}>{t(TIME_RANGES[value].shortLabel)}</Button>)}</div>
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"><span>{t("Completed days only · UTC")}</span>{data && <bdi dir="ltr">{reportDate(data.period.start)} – {reportDate(new Date(Date.parse(data.period.end) - 1))}</bdi>}</p>
    {loading && <p role="status" className="text-sm text-muted-foreground">{t("Loading comparison…")}</p>}
    {error && <p role="alert" className="rounded border border-destructive/30 p-3 text-sm">{t("Comparison could not be loaded. Try again.")} <Button variant="ghost" size="sm" onClick={() => void load()}>{t("Retry")}</Button></p>}
    {profileError && <p role="alert" className="text-sm text-destructive">{t("Candidate refresh failed. Previous profile data is preserved.")}</p>}
    {data && <>
      {!leftSelection && !rightSelection ? <>
        {data.members.length > 0 && data.groups.review === 0 && data.groups.followup === 0 && data.groups.noConcern === 0 && <div role="status" className="space-y-2 rounded border p-3 text-sm"><p>{t("More tracked activity or completed-event attendance is needed before prioritizing members.")}</p><Link href="/club-planning" className="inline-block text-primary underline underline-offset-4">{t("Record event attendance")}</Link></div>}
        <div className="grid gap-3 sm:grid-cols-3"><label className="space-y-1 text-sm"><span>{t("Search members...")}</span><Input value={search} onChange={event => setSearch(event.target.value)} /></label><label className="space-y-1 text-sm"><span>{t("Review group")}</span><select className="h-10 w-full rounded border bg-background px-2" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">{t("All Members")} ({number(data.members.length)})</option>{Object.entries(buckets).map(([value, label]) => <option key={value} value={value}>{t(label)} ({number(data.groups[value as ComparisonBucket])})</option>)}</select></label><label className="space-y-1 text-sm"><span>{t("Sort by")}</span><select className="h-10 w-full rounded border bg-background px-2" value={order} onChange={event => setOrder(event.target.value as Order)}><option value="review">{t("Review priority")}</option><option value="activity">{t("Observed activity")}</option><option value="attendance">{t("Documented attendance")}</option></select></label></div>
        <Button variant="outline" size="sm" onClick={() => setSelection([data.members[0] ? { kind: "member", tag: data.members[0].tag } : data.candidates[0] ? { kind: "candidate", tag: data.candidates[0].tag } : null, null])} disabled={!data.members.length && !data.candidates.length}>{t("Compare two players")}</Button>
        {!members.length && <p className="rounded border border-dashed p-5 text-sm text-muted-foreground">{t(data.members.length ? "No members match these filters." : "No current members found.")}</p>}
        <div className="space-y-2">{members.map(member => <article key={member.tag} className="rounded-lg border bg-card p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h3 className="break-words font-semibold"><bdi>{member.name}</bdi></h3><p className="text-xs text-muted-foreground"><bdi dir="ltr">{member.tag}</bdi> · {t(buckets[member.assessment.bucket])}</p></div><Button size="sm" variant="outline" onClick={() => setSelection([{ kind: "member", tag: member.tag }, null])}>{t("Compare")}</Button></div>
          <div className="mt-2 grid gap-1 text-sm sm:grid-cols-2"><p>{member.activity.evaluatedDays ? t("{active} active days / {evaluated} evaluated", { active: number(member.activity.observedActiveDays), evaluated: number(member.activity.evaluatedDays) }) : t("No evaluable activity days")}</p><p>{member.events.knownSample ? t("Events: {present} present · {absent} absent", { present: number(member.events.present), absent: number(member.events.absent) }) : t("No documented attendance")}</p></div>
          {(confidenceText(member) || member.events.unresolved > 0) && <p className="mt-1 text-xs text-muted-foreground">{[confidenceText(member), member.events.unresolved > 0 ? t("{count} event records unresolved", { count: number(member.events.unresolved) }) : null].filter(Boolean).join(" · ")}</p>}
          <ul className="mt-2 space-y-1 text-sm">{member.assessment.reasons.slice(0, 2).map(reason => <li key={reason}>{t(reasonLabels[reason])}</li>)}</ul>
          {(member.assessment.reasons.length > 2 || member.assessment.limitations.length > 0) && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("Evidence and limitations")}</summary><ul className="mt-2 space-y-1">{[...new Set([...member.assessment.reasons.slice(2), ...member.assessment.limitations])].map(reason => <li key={reason}>{t(reasonLabels[reason])}</li>)}</ul></details>}
        </article>)}</div>
      </> : <>
        <Button size="sm" variant="outline" onClick={() => { setSelection([null, null]); setProfileError(false); }}>{t("Back to roster review")}</Button>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{picker(0)}{picker(1)}</div>
        {samePlayer && <p role="status" className="text-sm">{t("Choose two different players.")}</p>}
        {((leftSelection && !left) || (rightSelection && !right)) && <p role="status" className="text-sm">{t("A selected player is unavailable for this comparison.")}</p>}
        <div className="grid grid-cols-2 gap-3">{left && subjectSummary(left)}{right && subjectSummary(right)}</div>
        {(!leftSelection || !rightSelection) && <p className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t("Choose another current member or a candidate to compare the available evidence.")}</p>}
        {pair && left && right && <>
          {!pair.commitmentComparable && <p role="status" className="rounded border p-3 text-sm">{t("This comparison does not establish who will be more active or reliable.")}</p>}
          {(left.kind === "member" && left.protection.active || right.kind === "member" && right.protection.active) && <p className="text-sm">{t("A selected member is protected. Review their circumstances individually.")}</p>}
          <section className="divide-y rounded-lg border" aria-label={t("Player comparison")}>{pair.metrics.map(metric => <div key={metric.key} className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3"><h3 className="col-span-2 text-sm font-medium sm:col-span-1">{t(metricLabels[metric.key])}</h3>{[left, right].map((subject, index) => <div key={subject.tag} className="min-w-0 text-sm"><span className="sr-only">{subject.name}: </span><p className="font-semibold">{metric.key === "eventAttendance" ? subject.kind === "member" ? subject.events.knownSample ? `${number(subject.events.present)} / ${number(subject.events.knownSample)}` : t("Unknown") : t("Unknown") : unknownNumber(index === 0 ? metric.left : metric.right)}</p>{metric.key === "rankedPoints" && <p className="text-xs text-muted-foreground">{subject.profile.rank ? t(subject.profile.rank) : t("Unknown")}</p>}<p className="text-xs text-muted-foreground">{metric.key === "activeDays" ? subject.kind === "member" ? t("{count} evaluated days", { count: number(subject.activity.evaluatedDays) }) : t("No tracked candidate activity") : metric.key === "eventAttendance" ? t("Present / documented attendance") : dateTime(index === 0 ? metric.leftCheckedAt : metric.rightCheckedAt)}</p></div>)}
            {!metric.comparable && <p className="col-span-2 text-xs text-muted-foreground sm:col-span-3">{t(comparisonLimits[metric.reason])}</p>}
            {metric.comparable && metric.delta !== null && ["trophies", "power11"].includes(metric.key) && <p className="col-span-2 text-xs sm:col-span-3">{t("Second player minus first")}: {delta(metric.delta)}</p>}
          </div>)}</section>
          <div className="grid gap-3 sm:grid-cols-2">{[left, right].filter((subject): subject is ComparisonMember => subject.kind === "member").map(member => <details key={member.tag} className="rounded border p-3 text-sm">
            <summary className="cursor-pointer font-medium">{t("Evidence for {name}", { name: member.name })}</summary>
            <div className="mt-2 space-y-2">
              <p>{t("{unknown} unknown days · {excused} excused days", { unknown: number(member.activity.unknownDays), excused: number(member.activity.excusedDays) })}</p>
              <p>{t("Events: {present} present · {absent} absent", { present: number(member.events.present), absent: number(member.events.absent) })}</p>
              <p>{t("{unresolved} unresolved · {excused} excused event records", { unresolved: number(member.events.unresolved), excused: number(member.events.excused) })}</p>
              {member.events.evidence.length > 0 && <ul className="space-y-2 rounded border p-2" aria-label={t("Documented event attendance")}>{member.events.evidence.map(event => <li key={event.eventId}>
                <p className="break-words font-medium">{event.title}</p><p className="text-xs text-muted-foreground">{dateTime(event.endedAt)} · {t(event.attendance === "present" ? "Present" : "Absent")}</p>
              </li>)}</ul>}
              <p>{t("Last observed")}: {dateTime(member.activity.checkedAt)}</p>
              {member.protection.observationSource === "roster_snapshot" && member.protection.observedSince && <p>{t("Observed in this club since")}: {dateTime(member.protection.observedSince)}</p>}
              {member.protection.absenceUntil && <p>{t("Declared absence until")}: {dateTime(member.protection.absenceUntil)}</p>}
              {member.protection.graceUntil && <p>{t("Grace period until")}: {dateTime(member.protection.graceUntil)}</p>}
              <ul className="space-y-1">{[...new Set([...member.assessment.reasons, ...member.assessment.limitations])].map(reason => <li key={reason}>{t(reasonLabels[reason])}</li>)}</ul>
            </div>
          </details>)}</div>
          {pair.rosterImpact && <section className="space-y-2 rounded border p-3 text-sm"><h3 className="font-medium">{t("Possible roster snapshot change")}</h3><p className="text-xs text-muted-foreground">{t("Candidate minus current member")}</p><p>{t("Trophies")}: {pair.rosterImpact.trophies == null ? t("Unknown") : delta(pair.rosterImpact.trophies)} · {t("Power 11 brawlers")}: {pair.rosterImpact.power11 == null ? t("Unknown") : delta(pair.rosterImpact.power11)}</p><p className="text-xs text-muted-foreground">{t("A snapshot difference is not a forecast or a recommendation to remove a member.")}</p></section>}
        </>}
      </>}
      <details className="rounded border p-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">{t("How this review works")}</summary><div className="mt-2 space-y-2"><p>{t("Review groups stay separate. Sorting only changes the order within each group.")}</p><p>{t("Activity sorting allows for possible activity on unknown days; attendance sorting uses the recorded absence share.")}</p><p>{t("Activity uses completed UTC days. Missing days can contain activity; they are never treated as certain inactivity.")}</p><p>{t("Activity review needs at least {days} evaluated days and {coverage}% of eligible days. The reference is {active} active days per week.", { days: number(data.policy.minEvaluatedDays), coverage: number(data.policy.minEvaluatedFraction * 100), active: number(data.policy.targetActiveDaysPerWeek) })}</p><p>{t("Repeated event absence requires at least {sample} documented events and {absences} recorded absences.", { sample: number(data.policy.minKnownEvents), absences: number(data.policy.repeatedAbsences) })}</p><p>{t("Only assigned, completed events with recorded attendance are assessed. Invited, confirmed and missing records are not absences.")}</p><p>{t("Leadership, current declared absence and new-member grace require an individual review.")}</p><p>{t("Profile differences require recent observations. Ranked points require the same known season.")}</p><p>{t("Last updated")}: {dateTime(data.generatedAt)}</p></div></details>
    </>}
  </div>;
}
