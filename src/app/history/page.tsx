"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { T, useI18n } from "@/components/locale-provider";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { TimeRangePicker } from "@/components/time-range-picker";
import { HistoryMemberCard } from "@/components/history-member-card";
import { hasRecordedReturn, HistoryMemberStatus, HistoryLatestEvent, HistoryPrivateNote, HistoryMemberDetailsSheet } from "@/components/history-member-details";
import { MemberReviewSheet } from "@/components/member-review";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import { useAdminSession } from "@/hooks/use-admin-session";
import type { TimeRangeKey } from "@/lib/time-range";
import type { MemberHistory } from "@/types/database";

export default function HistoryPage() {
  const { t, number } = useI18n();
  const { isAdmin, isLoading: sessionLoading } = useAdminSession();
  const [history, setHistory] = useState<MemberHistory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "current" | "former" | "returned">("all");
  const [timeRange, setTimeRange] = useState<TimeRangeKey | "all">("all");
  const [loadError, setLoadError] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [reviewMember, setReviewMember] = useState<MemberHistory | null>(null);
  const [detailMember, setDetailMember] = useState<MemberHistory | null>(null);
  const loadSequence = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const authBlocked = useRef(!isAdmin);
  const cancelRead = useCallback(() => { loadSequence.current++; readController.current?.abort(); }, []);

  const loadHistory = useCallback(async () => {
    const sequence = ++loadSequence.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setIsLoading(true); setLoadError(false);
    try {
      const data = await fetchJsonWithTimeout<{ history?: MemberHistory[] }>(`/api/history?range=${timeRange}`, {
        cache: "no-store", signal: controller.signal,
      });
      if (controller.signal.aborted || sequence !== loadSequence.current) return;
      const next = data.history || [];
      setHistory(next);
      setDetailMember(current => current ? next.find(member => member.player_tag === current.player_tag) || null : null);
    } catch (error) {
      if (controller.signal.aborted || sequence !== loadSequence.current) return;
      setLoadError(true); setHistory([]); setDetailMember(null);
      console.error("Error loading history:", error);
    } finally {
      if (!controller.signal.aborted && sequence === loadSequence.current) setIsLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    const resetSession = () => {
      authBlocked.current = true;
      cancelRead();
      setHistory([]); setReviewMember(null); setDetailMember(null);
      setSessionRevision(value => value + 1);
    };
    window.addEventListener("admin-session-changed", resetSession);
    return () => {
      authBlocked.current = true; cancelRead();
      window.removeEventListener("admin-session-changed", resetSession);
    };
  }, [cancelRead]);

  useEffect(() => {
    if (sessionLoading) return;
    authBlocked.current = !isAdmin;
    void loadHistory();
    return cancelRead;
  }, [loadHistory, isAdmin, sessionLoading, sessionRevision, cancelRead]);

  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent).detail?.clubChanged === true) {
        cancelRead(); setHistory([]); setDetailMember(null); setReviewMember(null);
      }
      if (!sessionLoading) void loadHistory();
    };
    window.addEventListener("club-data-updated", refresh);
    window.addEventListener("member-reviews-updated", refresh);
    return () => {
      window.removeEventListener("club-data-updated", refresh);
      window.removeEventListener("member-reviews-updated", refresh);
    };
  }, [loadHistory, sessionLoading, cancelRead]);

  const filteredHistory = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return history.filter(member => (!query || member.player_name.toLowerCase().includes(query) || member.player_tag.toLowerCase().includes(query))
      && (filter === "all" || filter === "current" && member.is_current_member || filter === "former" && !member.is_current_member || filter === "returned" && hasRecordedReturn(member)));
  }, [history, searchQuery, filter]);
  const currentCount = filteredHistory.filter(member => member.is_current_member).length;
  const formerCount = filteredHistory.length - currentCount;
  const returningCount = filteredHistory.filter(hasRecordedReturn).length;
  const canReview = isAdmin && !sessionLoading && !authBlocked.current;
  const openReview = (member: MemberHistory) => { if (isAdmin && !sessionLoading && !authBlocked.current) setReviewMember(member); };

  return <LayoutWrapper><div className="space-y-5">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
      <div><h1 className="text-2xl font-bold">{t("Member History")}</h1><p className="mt-1 text-sm text-muted-foreground">{t(timeRange === "all" ? "All recorded members, including those who left." : "Members with a recorded membership event in this period.")}</p></div>
      <TimeRangePicker value={timeRange} onChange={range => { if (range !== timeRange) { setIsLoading(true); setDetailMember(null); setTimeRange(range); } }} includeAll />
    </div>
    {loadError && <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm">{t("Could not load member history.")} <Button variant="ghost" onClick={loadHistory}>{t("Retry")}</Button></div>}
    <Card>
      <CardHeader className="gap-4 p-4">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <CardTitle className="text-lg">{t("Members")}</CardTitle>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative"><Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input placeholder={t("Search players...")} aria-label={t("Search players...")} value={searchQuery} onChange={event => setSearchQuery(event.target.value)} className="w-full ps-10 sm:w-64" /></div>
            <select aria-label={t("Membership status")} value={filter} onChange={event => setFilter(event.target.value as typeof filter)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <option value="all">{t("All Members")}</option><option value="current">{t("Current Members")}</option><option value="former">{t("Former Members")}</option><option value="returned">{t("Previously returned")}</option>
            </select>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-3 border-t pt-3 text-sm">
          {([["Matching members", filteredHistory.length], ["Current in results", currentCount], ["Former in results", formerCount]] as const).map(([label, count]) => <div key={label}><dt className="text-xs text-muted-foreground">{t(label)}</dt><dd className="mt-1 text-lg font-semibold">{isLoading || loadError ? "—" : number(count)}</dd></div>)}
        </dl>
        {!isLoading && !loadError && returningCount > 0 && <p className="text-xs text-muted-foreground">{t("Previously returned: {count} of these members", { count: number(returningCount) })}</p>}
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {isLoading ? <p role="status" className="py-8 text-center text-sm text-muted-foreground">{t("Loading...")}</p> : loadError ? null : <>
          <div className="space-y-3 md:hidden">{filteredHistory.length ? filteredHistory.map(member => <HistoryMemberCard key={member.player_tag} member={member} isAdmin={canReview} onReview={() => openReview(member)} />) : <p className="py-6 text-center text-sm text-muted-foreground">{t("No member history found")}</p>}</div>
          <div className="hidden overflow-x-auto md:block"><Table className="min-w-[760px]">
            <TableHeader><TableRow>{["Player", "Current status", "Latest recorded event", "Private notes", "Details"].map(label => <TableHead key={label}>{t(label)}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{filteredHistory.length === 0 ? <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">{t("No member history found")}</TableCell></TableRow> : filteredHistory.map(member => <TableRow key={member.player_tag}>
              <TableCell><Link href={`/members/${encodeURIComponent(member.player_tag)}`} className="font-medium"><bdi>{member.player_name}</bdi></Link><p className="text-xs text-muted-foreground"><bdi dir="ltr">{member.player_tag}</bdi></p></TableCell>
              <TableCell><HistoryMemberStatus member={member} /></TableCell>
              <TableCell><HistoryLatestEvent member={member} /></TableCell>
              <TableCell className="max-w-64"><HistoryPrivateNote member={member} isAdmin={canReview} onReview={() => openReview(member)} /></TableCell>
              <TableCell><Button variant="ghost" size="sm" onClick={() => setDetailMember(member)} aria-label={t("Details for {player}", { player: member.player_name })}>{t("Details")}</Button></TableCell>
            </TableRow>)}</TableBody>
          </Table></div>
        </>}
      </CardContent>
    </Card>
    <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer font-medium">{t("Understanding member history")}</summary><div className="mt-3 space-y-2 text-xs text-muted-foreground">
      <p>{t("First observed is the earliest retained evidence, not the actual join date. Counts cover the tracked history only.")}</p>
      <p>{t("Previously returned can include current and former members; it is not a separate membership status.")}</p>
      <p><T text="Private member notes can record why someone left or was removed. These reasons are entered by administrators." /></p>
      {!canReview && <Link href="/reviews" className="inline-block text-primary underline">{t("Sign in to view or add member notes")}</Link>}
    </div></details>
  </div>
    {detailMember && <HistoryMemberDetailsSheet key={detailMember.player_tag} member={detailMember} isAdmin={canReview} onClose={() => setDetailMember(null)} />}
    {canReview && reviewMember && <MemberReviewSheet key={reviewMember.player_tag} member={reviewMember} open onOpenChange={open => { if (!open) setReviewMember(null); }} />}
  </LayoutWrapper>;
}
