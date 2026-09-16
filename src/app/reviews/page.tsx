"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { DataConfidenceNotice } from "@/components/sync-health";
import { AdminGate } from "@/components/admin-gate";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { MemberReviewSheet, type MemberReview, type ReviewMember } from "@/components/member-review";
import { useI18n, LocalDate } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

function ReviewQueue() {
  const { t, number } = useI18n();
  const [members, setMembers] = useState<ReviewMember[]>([]);
  const [reviews, setReviews] = useState<MemberReview[]>([]);
  const [filter, setFilter] = useState("pending");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ReviewMember | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(false);
    try {
      const responses = await Promise.all([
        fetch("/api/member-reviews", { cache: "no-store" }),
        fetch("/api/members", { cache: "no-store" }),
      ]);
      if (responses.some(response => !response.ok)) throw new Error("Review unavailable");
      const [reviewData, memberData] = await Promise.all(responses.map(response => response.json()));
      if (sequence !== loadSequence.current) return;
      setReviews(reviewData.reviews || []);
      setMembers(memberData.members || []);
    } catch {
      if (sequence === loadSequence.current) setError(true);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener("member-reviews-updated", load);
    return () => window.removeEventListener("member-reviews-updated", load);
  }, [load]);

  const reviewMap = new Map(reviews.map(review => [review.player_tag, review]));
  const statusOf = (member: ReviewMember) => reviewMap.get(member.player_tag)?.status || "pending";
  const searchTerm = search.trim().toLowerCase();
  const visible = members.filter(member =>
    (filter === "all" || statusOf(member) === filter) &&
    (!searchTerm || `${member.player_name} ${member.player_tag}`.toLowerCase().includes(searchTerm))
  ).sort((a, b) => Number(b.activity_status === "inactive") - Number(a.activity_status === "inactive"));

  return <div className="mx-auto max-w-5xl space-y-5">
    <header>
      <h1 className="text-2xl font-bold">{t("Member reviews")}</h1>
      <p className="mt-1 text-muted-foreground">{t("Review activity and membership context before deciding what to do in the game.")}</p>
    </header>
    <DataConfidenceNotice />
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div role="group" aria-label={t("Review status")} className="flex flex-wrap gap-2">
        {["pending", "follow_up", "reviewed", "all"].map(value => <Button key={value} size="sm"
          variant={filter === value ? "default" : "outline"} aria-pressed={filter === value} onClick={() => setFilter(value)}>
          {t(value === "all" ? "All reviews" : value)}
          {!loading && !error && <span className="ms-1.5 opacity-70">{number(members.filter(member => value === "all" || statusOf(member) === value).length)}</span>}
        </Button>)}
      </div>
      <div className="relative sm:w-64">
        <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={event => setSearch(event.target.value)} placeholder={t("Search members...")}
          aria-label={t("Search members...")} className="ps-9" />
      </div>
    </div>
    {loading && <p role="status" className="py-8 text-center text-muted-foreground">{t("Loading...")}</p>}
    {error && <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">
      {t("Review unavailable")} <Button variant="ghost" onClick={load}>{t("Retry")}</Button>
    </div>}
    {!loading && !error && <div className="space-y-3">
      {visible.map(member => {
        const review = reviewMap.get(member.player_tag);
        return <article key={member.player_tag} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
          <div className="min-w-0 space-y-1">
            <Link href={`/members/${encodeURIComponent(member.player_tag)}`} className="font-semibold hover:underline"><bdi>{member.player_name}</bdi></Link>
            <p className="player-tag text-xs text-muted-foreground"><bdi>{member.player_tag}</bdi></p>
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="outline">{t(member.activity_status || "Unknown")}</Badge>
              <Badge variant="secondary">{t(review?.status || "pending")}</Badge>
            </div>
            {review?.follow_up_at && <p className="text-sm text-muted-foreground">{t("Follow-up date")}: <LocalDate value={review.follow_up_at} time /></p>}
          </div>
          <Button onClick={() => setSelected(member)}>{t("Review")}</Button>
        </article>;
      })}
      {visible.length === 0 && <p className="rounded-lg border py-10 text-center text-muted-foreground">{t("No members match these review filters.")}</p>}
    </div>}
    {selected && <MemberReviewSheet member={selected} open onOpenChange={open => { if (!open) setSelected(null); }} />}
  </div>;
}

export default function ReviewsPage() {
  return <LayoutWrapper><AdminGate><ReviewQueue /></AdminGate></LayoutWrapper>;
}
