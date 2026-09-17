"use client";

import Link from "next/link";
import { useI18n, LocalDate } from "@/components/locale-provider";
import { MembershipTimeline } from "@/components/membership-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { clubRoleLabel } from "@/lib/club-role";
import type { MemberHistory } from "@/types/database";

export function hasRecordedReturn(member: MemberHistory) {
  return (member.times_joined ?? 0) > 1 || (member.times_left ?? 0) > 1 || (member.is_current_member && (member.times_left ?? 0) > 0);
}

export function HistoryMemberStatus({ member }: { member: MemberHistory }) {
  const { t } = useI18n();
  return <div className="flex flex-wrap gap-1.5">
    <Badge variant={member.is_current_member ? "success" : "secondary"}>{t(member.is_current_member ? "Current" : "Former")}</Badge>
    {hasRecordedReturn(member) && <Badge variant="outline">{t("Previously returned")}</Badge>}
  </div>;
}

export function HistoryLatestEvent({ member }: { member: MemberHistory }) {
  const { t } = useI18n();
  const event = member.latest_membership_event;
  if (!event) return <p className="text-sm text-muted-foreground">{t("No dated membership event")}</p>;
  const label = event.type === "join" ? "Joined club" : event.type === "leave" ? "Left club" : "First observed";
  return <div className="space-y-1 text-sm"><p>{t(label)}</p><p className="text-xs text-muted-foreground"><LocalDate value={event.at} time /></p>
    {event.source !== "recorded" && <p className="text-xs text-muted-foreground">{t(event.source === "reconstructed" ? "Reconstructed" : "Unknown source")}</p>}
  </div>;
}

export function HistoryPrivateNote({ member, isAdmin, onReview }: { member: MemberHistory; isAdmin: boolean; onReview: () => void }) {
  const { t } = useI18n();
  if (!isAdmin) return <Button asChild variant="outline" size="sm"><Link href={`/reviews?member=${encodeURIComponent(member.player_tag)}`}>{t("Sign in for member notes")}</Link></Button>;
  return <div className="space-y-2">
    <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{member.notes || t("No private notes")}</p>
    <Button variant="outline" size="sm" onClick={onReview}>{t("Member notes")}</Button>
  </div>;
}

export function HistoryMemberDetails({ member, isAdmin }: { member: MemberHistory; isAdmin: boolean }) {
  const { t, number } = useI18n();
  return <div className="space-y-4">
    <dl className="grid grid-cols-2 gap-3 text-sm">
      <div><dt className="text-muted-foreground">{t("First observed")}</dt><dd><LocalDate value={member.first_seen} time /></dd></div>
      <div><dt className="text-muted-foreground">{t("Last recorded departure")}</dt><dd><LocalDate value={member.last_left_at} time /></dd></div>
      <div><dt className="text-muted-foreground">{t("Recorded joins")}</dt><dd>{member.times_joined == null ? t("Unknown") : number(member.times_joined)}</dd></div>
      <div><dt className="text-muted-foreground">{t("Recorded departures")}</dt><dd>{member.times_left == null ? t("Unknown") : number(member.times_left)}</dd></div>
      <div><dt className="text-muted-foreground">{t("Role at departure")}</dt><dd>{t(clubRoleLabel(member.role_at_leave))}</dd></div>
      <div><dt className="text-muted-foreground">{t("Trophies at departure")}</dt><dd>{member.trophies_at_leave == null ? t("Unknown") : number(member.trophies_at_leave)}</dd></div>
    </dl>
    <div className="flex flex-wrap gap-2">
      <Button asChild variant="outline" size="sm"><Link href={`/members/${encodeURIComponent(member.player_tag)}`}>{t("Open Profile")}</Link></Button>
      {isAdmin && <Button asChild variant="outline" size="sm"><Link href={`/club-planning?member=${encodeURIComponent(member.player_tag)}#mega-pig-history`}>{t("Mega Pig history")}</Link></Button>}
    </div>
    <MembershipTimeline playerTag={member.player_tag} />
  </div>;
}

export function HistoryMemberDetailsSheet({ member, isAdmin, onClose }: { member: MemberHistory; isAdmin: boolean; onClose: () => void }) {
  const { t, direction } = useI18n();
  return <Sheet open onOpenChange={open => { if (!open) onClose(); }}><SheetContent side={direction === "rtl" ? "left" : "right"} className="w-full overflow-y-auto sm:max-w-lg">
    <SheetHeader><SheetTitle><bdi>{member.player_name}</bdi> · {t("Details")}</SheetTitle><SheetDescription><bdi dir="ltr">{member.player_tag}</bdi></SheetDescription></SheetHeader>
    <div className="space-y-4 py-5"><HistoryMemberStatus member={member} /><HistoryLatestEvent member={member} /><HistoryMemberDetails member={member} isAdmin={isAdmin} /></div>
  </SheetContent></Sheet>;
}
