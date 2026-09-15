"use client";

import { useCallback, useEffect, useState } from "react";
import { DataConfidenceNotice } from "@/components/sync-health";
import { AdminGate } from "@/components/admin-gate";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { MemberReviewSheet, type MemberReview, type ReviewMember } from "@/components/member-review";
import { useI18n, LocalDate } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";

function ReviewQueue() {
  const { t } = useI18n();
  const [members, setMembers] = useState<ReviewMember[]>([]);
  const [reviews, setReviews] = useState<MemberReview[]>([]);
  const [filter, setFilter] = useState("pending");
  const [selected, setSelected] = useState<ReviewMember | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      setError("");
      const responses = await Promise.all([fetch("/api/member-reviews", { cache: "no-store" }), fetch("/api/members", { cache: "no-store" })]);
      if (responses.some(response => !response.ok)) throw new Error(t("Review unavailable"));
      const [reviewData, memberData] = await Promise.all(responses.map(response => response.json()));
      setReviews(reviewData.reviews || []); setMembers(memberData.members || []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("Review unavailable")); }
    finally { setLoading(false); }
  }, [t]);
  useEffect(() => { void load(); window.addEventListener("member-reviews-updated", load); return () => window.removeEventListener("member-reviews-updated", load); }, [load]);
  const reviewMap = new Map(reviews.map(review => [review.player_tag, review]));
  const visible = members.filter(member => filter === "all" || (reviewMap.get(member.player_tag)?.status || "pending") === filter).sort((a, b) => Number(b.activity_status === "inactive") - Number(a.activity_status === "inactive"));
  return <div className="mx-auto max-w-5xl space-y-5"><DataConfidenceNotice /><h1 className="text-2xl font-bold">{t("Member reviews")}</h1><p className="text-muted-foreground">{t("Review activity and membership context before deciding what to do in the game.")}</p>
    <div className="flex flex-wrap gap-2">{["all", "pending", "reviewed", "follow_up"].map(value => <Button key={value} variant={filter === value ? "default" : "outline"} onClick={() => setFilter(value)}>{t(value === "all" ? "All reviews" : value)}</Button>)}</div>
    {loading && <p role="status">{t("Loading...")}</p>}{error && <p role="alert" className="text-destructive">{error} <Button variant="ghost" onClick={load}>{t("Retry")}</Button></p>}
    {!loading && !error && <div className="space-y-3">{visible.map(member => { const review = reviewMap.get(member.player_tag); return <article key={member.player_tag} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"><div><h2 className="font-semibold"><bdi>{member.player_name}</bdi></h2><p className="player-tag text-xs text-muted-foreground">{member.player_tag}</p><p className="text-sm">{t(member.activity_status || "Unknown")} · {t(review?.status || "pending")}</p>{review?.follow_up_at && <p className="text-sm">{t("Follow-up date")}: <LocalDate value={review.follow_up_at} time /></p>}</div><Button onClick={() => setSelected(member)}>{t("Review")}</Button></article>; })}{visible.length === 0 && <p className="py-8 text-center text-muted-foreground">{t("No review needed")}</p>}</div>}
    {selected && <MemberReviewSheet member={selected} open onOpenChange={open => { if (!open) setSelected(null); }} />}
  </div>;
}

export default function ReviewsPage() { return <LayoutWrapper><AdminGate><ReviewQueue /></AdminGate></LayoutWrapper>; }
