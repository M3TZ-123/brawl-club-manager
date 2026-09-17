"use client";

import Link from "next/link";
import { useState } from "react";
import { useI18n } from "@/components/locale-provider";
import { HistoryMemberStatus, HistoryLatestEvent, HistoryPrivateNote, HistoryMemberDetails } from "@/components/history-member-details";
import type { MemberHistory } from "@/types/database";

export function HistoryMemberCard({ member, isAdmin, onReview }: { member: MemberHistory; isAdmin: boolean; onReview: () => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return <article className="space-y-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><Link href={`/members/${encodeURIComponent(member.player_tag)}`} className="break-words font-semibold"><bdi>{member.player_name}</bdi></Link><p className="text-xs text-muted-foreground"><bdi dir="ltr">{member.player_tag}</bdi></p></div>
      <HistoryMemberStatus member={member} />
    </div>
    <div><p className="mb-1 text-xs text-muted-foreground">{t("Latest recorded event")}</p><HistoryLatestEvent member={member} /></div>
    <HistoryPrivateNote member={member} isAdmin={isAdmin} onReview={onReview} />
    <details onToggle={event => setExpanded(event.currentTarget.open)} className="border-t pt-3">
      <summary className="cursor-pointer text-sm font-medium text-primary">{t("Details")}</summary>
      {expanded && <div className="pt-4"><HistoryMemberDetails member={member} isAdmin={isAdmin} /></div>}
    </details>
  </article>;
}
