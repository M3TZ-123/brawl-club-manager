"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { AdminGate } from "@/components/admin-gate";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { MemberReviewSheet, type MemberReview, type ReviewMember } from "@/components/member-review";
import { useI18n, LocalDate, T } from "@/components/locale-provider";
import { useAdminSession } from "@/hooks/use-admin-session";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import type { MemberHistory } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ClubAdministrationSettings } from "@/components/club-administration-settings";
import { memberReviewStatusLabel } from "@/lib/member-review-labels";

type QueueMember = ReviewMember & { is_current_member: boolean };
type HistorySummary = { player_tag: string; entry_count: number; latest_at: string };
const REVIEW_PAGE_SIZE = 12;

function ReviewQueue() {
  const { t, number } = useI18n();
  const { isAdmin, isLoading: sessionLoading } = useAdminSession();
  const searchParams = useSearchParams();
  const requestedTag = searchParams.get("member")?.trim().toUpperCase() || "";
  const [members, setMembers] = useState<QueueMember[]>([]);
  const [reviews, setReviews] = useState<MemberReview[]>([]);
  const [historySummaries, setHistorySummaries] = useState<HistorySummary[]>([]);
  const [filter, setFilter] = useState("all");
  const [membership, setMembership] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selected, setSelected] = useState<QueueMember | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [linkMissing, setLinkMissing] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const loadSequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const openedTag = useRef("");
  const cancelRead = useCallback(() => { controller.current?.abort(); loadSequence.current++; }, []);

  const load = useCallback(async () => {
    if (!isAdmin || sessionLoading) return;
    const sequence = ++loadSequence.current;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setLoading(true);
    setError(false);
    try {
      const [reviewData, memberData, historyData] = await Promise.all([
        fetchJsonWithTimeout<{ reviews: MemberReview[]; historySummaries: HistorySummary[] }>("/api/member-reviews?include_history=1", { cache: "no-store", signal: current.signal }),
        fetchJsonWithTimeout<{ members: ReviewMember[] }>("/api/members", { cache: "no-store", signal: current.signal }),
        fetchJsonWithTimeout<{ history: MemberHistory[] }>("/api/history?range=all", { cache: "no-store", signal: current.signal }),
      ]);
      if (current.signal.aborted || sequence !== loadSequence.current) return;
      if (!Array.isArray(memberData.members) || !Array.isArray(historyData.history)) throw new Error("Review unavailable");
      const combined = new Map<string, QueueMember>(historyData.history.map(member => [member.player_tag, { ...member }]));
      for (const member of memberData.members || []) combined.set(member.player_tag, { ...combined.get(member.player_tag), ...member, is_current_member: true });
      const rows = [...combined.values()];
      if (!Array.isArray(reviewData.reviews) || !Array.isArray(reviewData.historySummaries)) throw new Error("Review unavailable");
      setReviews(reviewData.reviews); setHistorySummaries(reviewData.historySummaries); setMembers(rows);
      const requestedMember = rows.find(member => member.player_tag.toUpperCase() === requestedTag);
      setLinkMissing(Boolean(requestedTag && !requestedMember));
      if (openedTag.current !== requestedTag) {
        openedTag.current = requestedTag;
        setSelected(requestedMember ?? null);
        if (requestedMember) { setFilter("all"); setMembership("all"); setSearch(""); setPage(1); }
      }
    } catch {
      if (!current.signal.aborted && sequence === loadSequence.current) setError(true);
    } finally {
      if (!current.signal.aborted && sequence === loadSequence.current) setLoading(false);
    }
  }, [isAdmin, sessionLoading, requestedTag]);

  useEffect(() => {
    const resetSession = () => {
      cancelRead(); openedTag.current = "";
      setMembers([]); setReviews([]); setHistorySummaries([]); setSelected(null); setLinkMissing(false); setError(false);
      setPage(1); setSettingsOpen(false);
      setSessionRevision(value => value + 1);
    };
    window.addEventListener("admin-session-changed", resetSession);
    return () => {
      cancelRead();
      window.removeEventListener("admin-session-changed", resetSession);
    };
  }, [cancelRead]);

  useEffect(() => {
    void load();
    const refresh = (event: Event) => {
      if ((event as CustomEvent).detail?.clubChanged === true) {
        cancelRead(); setMembers([]); setReviews([]); setHistorySummaries([]); setSelected(null); setSettingsOpen(false); setPage(1);
        // A deep link already handled in this session must not reopen an old-club draft.
      }
      void load();
    };
    window.addEventListener("member-reviews-updated", refresh);
    window.addEventListener("club-administration-updated", refresh);
    window.addEventListener("club-data-updated", refresh);
    return () => {
      cancelRead();
      window.removeEventListener("member-reviews-updated", refresh);
      window.removeEventListener("club-administration-updated", refresh);
      window.removeEventListener("club-data-updated", refresh);
    };
  }, [load, sessionRevision, cancelRead]);

  const reviewMap = new Map(reviews.map(review => [review.player_tag, review]));
  const historyMap = new Map(historySummaries.map(summary => [summary.player_tag, summary]));
  const searchTerm = search.trim().toLowerCase();
  const scoped = members.filter(member => (membership === "all" || member.is_current_member === (membership === "current")) &&
    (!searchTerm || `${member.player_name} ${member.player_tag} ${reviewMap.get(member.player_tag)?.notes || ""}`.toLowerCase().includes(searchTerm)));
  const hasSavedNotes = (tag: string) => Boolean(reviewMap.get(tag)?.notes?.trim() || (historyMap.get(tag)?.entry_count ?? 0) > 0);
  const matches = (tag: string, value: string) => value === "all" || (value === "saved" ? hasSavedNotes(tag) : reviewMap.get(tag)?.status === "follow_up");
  const timestamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  const updated = (tag: string) => Math.max(reviewMap.get(tag)?.notes?.trim() ? timestamp(reviewMap.get(tag)?.updated_at) : 0, timestamp(historyMap.get(tag)?.latest_at));
  const visible = scoped.filter(member => matches(member.player_tag, filter)).sort((a, b) => {
    const ar = reviewMap.get(a.player_tag), br = reviewMap.get(b.player_tag);
    const af = ar?.status === "follow_up", bf = br?.status === "follow_up";
    if (af !== bf) return Number(bf) - Number(af);
    if (af && bf) {
      const byDate = timestamp(ar?.follow_up_at) - timestamp(br?.follow_up_at);
      if (byDate) return byDate;
    }
    return updated(b.player_tag) - updated(a.player_tag) || Number(b.is_current_member) - Number(a.is_current_member) ||
      a.player_name.localeCompare(b.player_name) || a.player_tag.localeCompare(b.player_tag);
  });
  const pageCount = Math.max(1, Math.ceil(visible.length / REVIEW_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const displayed = visible.slice((currentPage - 1) * REVIEW_PAGE_SIZE, currentPage * REVIEW_PAGE_SIZE);

  if (!isAdmin || sessionLoading) return null;
  return <div className="mx-auto max-w-5xl space-y-5">
    <header className="flex flex-wrap items-center gap-3">
      <h1 className="text-2xl font-bold">{t("Member notes")}</h1>
      <Badge variant="outline">{t("Administrators only")}</Badge>
    </header>
    <div className="space-y-3">
      <div role="group" aria-label={t("Notes filters")} className="flex flex-wrap gap-2">
        {["all", "saved", "follow_up"].map(value => <Button key={value} size="sm"
          variant={filter === value ? "default" : "outline"} aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(1); }}>
          {t(value === "all" ? "All members" : value === "saved" ? "Saved notes" : "Follow-ups")}
          {!loading && !error && <span className="ms-1.5 opacity-70">{number(scoped.filter(member => matches(member.player_tag, value)).length)}</span>}
        </Button>)}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row"><div className="relative min-w-0 flex-1">
        <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder={t("Search by name, tag or current note...")}
          aria-label={t("Search members...")} className="ps-9" />
      </div>
      <select aria-label={t("Membership status")} value={membership} onChange={event => { setMembership(event.target.value); setPage(1); }} className="h-10 rounded-md border bg-background px-3 text-sm">
        <option value="all">{t("All Members")}</option><option value="current">{t("Current Members")}</option><option value="former">{t("Former Members")}</option>
      </select></div>
    </div>
    {loading && <p role="status" className="py-8 text-center text-muted-foreground">{t("Loading...")}</p>}
    {error && <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">
      {t("Review unavailable")} <Button variant="ghost" onClick={load}>{t("Retry")}</Button>
    </div>}
    {!loading && !error && linkMissing && <p role="status" className="rounded-lg border p-4 text-sm">{t("No member record was found for this link.")}</p>}
    {!loading && !error && <div id="review-members" className="space-y-3">
      {visible.length > 0 && <p role="status" className="text-sm text-muted-foreground">{t(visible.length === 1 ? "1 matching member" : "{total} matching members", { total: number(visible.length) })}</p>}
      <div className="overflow-hidden rounded-lg border bg-card divide-y">
      {displayed.map(member => {
        const review = reviewMap.get(member.player_tag);
        const summary = historyMap.get(member.player_tag);
        return <article key={member.player_tag} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 p-3 sm:grid-cols-[minmax(12rem,1fr)_minmax(0,1.5fr)_auto] sm:px-4">
          <div className="min-w-0 space-y-1">
            <Link href={`/members/${encodeURIComponent(member.player_tag)}`} className="break-words font-semibold hover:underline"><bdi>{member.player_name}</bdi></Link>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><bdi dir="ltr">{member.player_tag}</bdi>
              <Badge variant={member.is_current_member ? "outline" : "destructive"}>{t(member.is_current_member ? "Current" : "Former")}</Badge>
            </div>
          </div>
          <div className="col-span-2 row-start-2 min-w-0 space-y-1 sm:col-span-1 sm:row-start-auto">
            {review?.notes?.trim() ? <p className="line-clamp-2 break-words text-sm">{review.notes}</p> : !summary?.entry_count && <p className="text-sm text-muted-foreground">{t("No saved notes")}</p>}
            {Boolean(summary?.entry_count) && <p className="text-xs text-muted-foreground">{t(summary!.entry_count === 1 ? "Dated history: 1 entry" : "Dated history: {count} entries", { count: number(summary!.entry_count) })}</p>}
            {review?.status === "follow_up" ? <p className="text-xs text-primary">{t("Follow-up date")}: {timestamp(review.follow_up_at) ? <LocalDate value={review.follow_up_at} time /> : t("Date missing")}</p>
              : review?.status === "reviewed" ? <p className="text-xs text-muted-foreground">{t(memberReviewStatusLabel(review.status))}</p> : null}
            {updated(member.player_tag) > 0 && <p className="text-xs text-muted-foreground">{t("Last saved")}: <LocalDate value={new Date(updated(member.player_tag)).toISOString()} time /></p>}
          </div>
          <Button variant="outline" size="sm" className="col-start-2 row-start-1 sm:col-start-3" onClick={() => setSelected(member)} aria-label={t("Open notes for {name}", { name: member.player_name })}>{t("Open notes")}</Button>
        </article>;
      })}
      {visible.length === 0 && <div role="status" className="space-y-2 p-8 text-center"><p className="font-medium">{t(filter === "saved" ? "No saved notes in this selection." : filter === "follow_up" ? "No follow-ups in this selection." : "No matching members.")}</p><p className="text-sm text-muted-foreground">{t(filter === "all" ? "Try another search or membership filter." : "Open a member from All members to add a note or schedule a follow-up.")}</p></div>}
      </div>
      {pageCount > 1 && <nav aria-label={t("Member notes pages")} className="flex items-center justify-between gap-3"><Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>{t("Previous")}</Button><p className="text-sm text-muted-foreground">{t("Page {page} of {total}", { page: number(currentPage), total: number(pageCount) })}</p><Button variant="outline" size="sm" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>{t("Next")}</Button></nav>}
    </div>}
    <details className="rounded-lg border p-3 text-sm" onToggle={event => setSettingsOpen(event.currentTarget.open)}><summary className="cursor-pointer text-muted-foreground">{t("Review alert settings")}</summary>{settingsOpen && <div className="mt-3"><ClubAdministrationSettings graceOnly /></div>}</details>
    {selected && <MemberReviewSheet key={selected.player_tag} member={selected} open onOpenChange={open => { if (!open) setSelected(null); }} />}
  </div>;
}

export default function ReviewsPage() {
  return <LayoutWrapper><AdminGate><Suspense fallback={<p role="status"><T text="Loading..." /></p>}><ReviewQueue /></Suspense></AdminGate></LayoutWrapper>;
}
