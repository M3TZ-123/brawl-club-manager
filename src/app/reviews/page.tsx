"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { DataConfidenceNotice } from "@/components/sync-health";
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

type QueueMember = ReviewMember & { is_current_member: boolean };

function ReviewQueue() {
  const { t, number } = useI18n();
  const { isAdmin, isLoading: sessionLoading } = useAdminSession();
  const searchParams = useSearchParams();
  const requestedTag = searchParams.get("member")?.trim().toUpperCase() || "";
  const [members, setMembers] = useState<QueueMember[]>([]);
  const [reviews, setReviews] = useState<MemberReview[]>([]);
  const [filter, setFilter] = useState("pending");
  const [membership, setMembership] = useState("all");
  const [search, setSearch] = useState("");
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
        fetchJsonWithTimeout<{ reviews: MemberReview[] }>("/api/member-reviews", { cache: "no-store", signal: current.signal }),
        fetchJsonWithTimeout<{ members: ReviewMember[] }>("/api/members", { cache: "no-store", signal: current.signal }),
        fetchJsonWithTimeout<{ history: MemberHistory[] }>("/api/history?range=all", { cache: "no-store", signal: current.signal }),
      ]);
      if (current.signal.aborted || sequence !== loadSequence.current) return;
      const combined = new Map<string, QueueMember>((historyData.history || []).map(member => [member.player_tag, { ...member }]));
      for (const member of memberData.members || []) combined.set(member.player_tag, { ...combined.get(member.player_tag), ...member, is_current_member: true });
      const rows = [...combined.values()];
      setReviews(reviewData.reviews || []); setMembers(rows);
      const requestedMember = rows.find(member => member.player_tag.toUpperCase() === requestedTag);
      setLinkMissing(Boolean(requestedTag && !requestedMember));
      if (openedTag.current !== requestedTag) {
        openedTag.current = requestedTag;
        setSelected(requestedMember ?? null);
        if (requestedMember) { setFilter("all"); setMembership("all"); setSearch(""); }
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
      setMembers([]); setReviews([]); setSelected(null); setLinkMissing(false); setError(false);
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
    window.addEventListener("member-reviews-updated", load);
    window.addEventListener("club-data-updated", load);
    return () => {
      cancelRead();
      window.removeEventListener("member-reviews-updated", load);
      window.removeEventListener("club-data-updated", load);
    };
  }, [load, sessionRevision, cancelRead]);

  const reviewMap = new Map(reviews.map(review => [review.player_tag, review]));
  const statusOf = (member: ReviewMember) => reviewMap.get(member.player_tag)?.status || "pending";
  const membershipRows = members.filter(member => membership === "all" || member.is_current_member === (membership === "current"));
  const searchTerm = search.trim().toLowerCase();
  const visible = membershipRows.filter(member =>
    (filter === "all" || statusOf(member) === filter) &&
    (!searchTerm || `${member.player_name} ${member.player_tag}`.toLowerCase().includes(searchTerm))
  ).sort((a, b) => Number(b.activity_status === "inactive") - Number(a.activity_status === "inactive"));

  if (!isAdmin || sessionLoading) return null;
  return <div className="mx-auto max-w-5xl space-y-5">
    <header>
      <h1 className="text-2xl font-bold">{t("Member notes")}</h1>
      <p className="mt-1 text-muted-foreground">{t("Private notes and follow-ups for current and former members.")}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t("Private member notes can record why someone left or was removed. These reasons are entered by administrators.")}</p>
    </header>
    <DataConfidenceNotice />
    <div className="space-y-3">
      <div role="group" aria-label={t("Review status")} className="flex flex-wrap gap-2">
        {["pending", "follow_up", "reviewed", "all"].map(value => <Button key={value} size="sm"
          variant={filter === value ? "default" : "outline"} aria-pressed={filter === value} onClick={() => setFilter(value)}>
          {t(value === "all" ? "All reviews" : value)}
          {!loading && !error && <span className="ms-1.5 opacity-70">{number(membershipRows.filter(member => value === "all" || statusOf(member) === value).length)}</span>}
        </Button>)}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row"><div className="relative min-w-0 flex-1">
        <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={event => setSearch(event.target.value)} placeholder={t("Search members...")}
          aria-label={t("Search members...")} className="ps-9" />
      </div>
      <select aria-label={t("Membership status")} value={membership} onChange={event => setMembership(event.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
        <option value="all">{t("All Members")}</option><option value="current">{t("Current Members")}</option><option value="former">{t("Former Members")}</option>
      </select></div>
    </div>
    {loading && <p role="status" className="py-8 text-center text-muted-foreground">{t("Loading...")}</p>}
    {error && <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">
      {t("Review unavailable")} <Button variant="ghost" onClick={load}>{t("Retry")}</Button>
    </div>}
    {!loading && !error && linkMissing && <p role="status" className="rounded-lg border p-4 text-sm">{t("No member record was found for this link.")}</p>}
    {!loading && !error && <div className="space-y-3">
      {visible.map(member => {
        const review = reviewMap.get(member.player_tag);
        return <article key={member.player_tag} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
          <div className="min-w-0 flex-1 space-y-1">
            <Link href={`/members/${encodeURIComponent(member.player_tag)}`} className="break-words font-semibold hover:underline"><bdi>{member.player_name}</bdi></Link>
            <p className="text-xs text-muted-foreground"><bdi dir="ltr">{member.player_tag}</bdi></p>
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant={member.is_current_member ? "outline" : "destructive"}>{t(member.is_current_member ? "Current" : "Former")}</Badge>
              {member.is_current_member && <Badge variant="outline">{t(member.activity_status || "Unknown")}</Badge>}
              <Badge variant="secondary">{t(review?.status || "pending")}</Badge>
            </div>
            {review?.notes && <p className="line-clamp-2 break-words text-sm text-muted-foreground">{review.notes}</p>}
            {review?.follow_up_at && <p className="text-sm text-muted-foreground">{t("Follow-up date")}: <LocalDate value={review.follow_up_at} time /></p>}
          </div>
          <Button onClick={() => setSelected(member)}>{t("Member notes")}</Button>
        </article>;
      })}
      {visible.length === 0 && <p className="rounded-lg border py-10 text-center text-muted-foreground">{t("No members match these review filters.")}</p>}
    </div>}
    {selected && <MemberReviewSheet key={selected.player_tag} member={selected} open onOpenChange={open => { if (!open) setSelected(null); }} />}
  </div>;
}

export default function ReviewsPage() {
  return <LayoutWrapper><AdminGate><Suspense fallback={<p role="status"><T text="Loading..." /></p>}><ReviewQueue /></Suspense></AdminGate></LayoutWrapper>;
}
