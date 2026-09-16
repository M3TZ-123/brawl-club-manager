"use client";

import Link from "next/link";
import { useState } from "react";
import { useI18n, LocalDate } from "@/components/locale-provider";
import { MembershipTimeline } from "@/components/membership-timeline";
import { Button } from "@/components/ui/button";
import { MemberHistory } from "@/types/database";

export function HistoryMemberCard({ member, isAdmin, onReview }: { member: MemberHistory; isAdmin: boolean; onReview: () => void }) {
  const { t, number } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return <article className="rounded-lg border p-4"><details onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer"><span className="flex flex-wrap items-center justify-between gap-2"><bdi className="font-semibold">{member.player_name}</bdi><span className="text-xs text-muted-foreground">{t(member.is_current_member ? "Current" : "Former")}</span></span><bdi dir="ltr" className="text-xs text-muted-foreground">{member.player_tag}</bdi><span className="block mt-2 text-sm text-primary">{t("Details")}</span></summary>
    {expanded && <div className="mt-4 space-y-4"><dl className="grid grid-cols-2 gap-3 text-sm">
      <div><dt className="text-muted-foreground">{t("First observed")}</dt><dd><LocalDate value={member.first_seen} /></dd></div>
      <div><dt className="text-muted-foreground">{t("Left At")}</dt><dd><LocalDate value={member.last_left_at} time /></dd></div>
      <div><dt className="text-muted-foreground">{t("Recorded joins")}</dt><dd>{member.times_joined == null ? t("Unknown") : number(member.times_joined)}</dd></div>
      <div><dt className="text-muted-foreground">{t("Recorded departures")}</dt><dd>{member.times_left == null ? t("Unknown") : number(member.times_left)}</dd></div>
      <div><dt className="text-muted-foreground">{t("Role at departure")}</dt><dd>{member.role_at_leave ? t(member.role_at_leave) : t("Unknown")}</dd></div>
      <div><dt className="text-muted-foreground">{t("Trophies at departure")}</dt><dd>{member.trophies_at_leave == null ? t("Unknown") : number(member.trophies_at_leave)}</dd></div>
    </dl>{isAdmin && <div><p className="text-sm font-medium">{t("Private notes")}</p><p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{member.notes || t("No private notes")}</p></div>}
    <Button asChild variant="outline"><Link href={`/members/${encodeURIComponent(member.player_tag)}`}>{t("Open Profile")}</Link></Button>
    <MembershipTimeline playerTag={member.player_tag} /></div>}
  </details><div className="mt-3">{isAdmin
    ? <Button variant="outline" size="sm" onClick={onReview}>{t("Member notes")}</Button>
    : <Button asChild variant="outline" size="sm"><Link href={`/reviews?member=${encodeURIComponent(member.player_tag)}`}>{t("Sign in for member notes")}</Link></Button>}
  </div></article>;
}
