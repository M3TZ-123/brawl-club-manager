"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ListChecks, Swords, Target, Trophy } from "lucide-react";
import { T, useI18n } from "@/components/locale-provider";
import { useAppStore } from "@/lib/store";
import { fetchJsonCached } from "@/lib/client-data-cache";
import { TIME_RANGES, type TimeRangeKey } from "@/lib/time-range";
import { DataConfidenceNotice } from "@/components/sync-health";
import { TimeRangePicker } from "@/components/time-range-picker";
import { MemberReviewButton } from "@/components/member-review";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { SetupWizard } from "@/components/setup-wizard";
import { StatsCards } from "@/components/stats-cards";
import { ActivityTimeline } from "@/components/activity-timeline";
import { ClubIdentity } from "@/components/club-identity";
import { ClubGrowthPeriod } from "@/components/club-growth-period";
import { ClubStrength } from "@/components/club-strength";
import { ClubGoalsOverview } from "@/components/club-goals-overview";
import { ClubJoinSummary } from "@/components/club-join-summary";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Member, ClubEvent } from "@/types/database";

interface DashboardMember extends Member {
  trophies_24h: number | null;
  trophies_3d: number | null;
  trophies_7d: number | null;
  trophies_30d: number | null;
  trophies_90d: number | null;
  activity_status: "active" | "minimal" | "inactive";
  last_battle_at: string | null;
}

interface DashboardResponse {
  summary: { totalMembers: number; totalTrophies: number; activeMembers: number; avgTrophies: number; trophyProgressKnownMembers?: number };
  topMembers: DashboardMember[];
  topGainers: DashboardMember[];
  attentionMembers: DashboardMember[];
  changeSummary: { joins: number; leaves: number; nameChanges: number; roleChanges: number; since: string };
  recentEvents: ClubEvent[];
}

interface ClubInsights {
  megaBoss: { isTracked: boolean; totalWins: number; totalBattles: number };
  winRate: number;
  totalWins: number;
  totalBattlesThisWeek: number;
  thisWeekTotal: number;
  prevWeekTotal: number;
  trendDiff: number;
  trendDirection: "up" | "down" | "flat";
  mvpName: string | null;
  mvpTrophies: number;
  period?: { start: string; end: string };
}

function DashboardSkeleton() {
  return <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="Loading">
    {Array.from({ length: 4 }, (_, index) => <Card key={index}><CardContent className="h-28 animate-pulse p-5">
      <div className="h-4 w-24 rounded bg-muted" /><div className="mt-5 h-7 w-20 rounded bg-muted/70" />
    </CardContent></Card>)}
  </div>;
}

function MemberSignalList({ members, range, attention = false, numbered = false, emptyText }: {
  members: DashboardMember[]; range: TimeRangeKey; attention?: boolean; numbered?: boolean; emptyText: string;
}) {
  const { delta, number, t } = useI18n();
  if (!members.length) return <p className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">{t(emptyText)}</p>;
  return <div className="divide-y divide-border/60">{members.map((member, index) => {
    const change = member[TIME_RANGES[range].metric];
    const status = member.activity_status;
    return <div key={member.player_tag} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <Link href={`/members/${encodeURIComponent(member.player_tag)}`} className="flex min-w-0 items-center gap-3 hover:text-primary">
        {numbered && <span className="w-5 shrink-0 text-sm font-semibold text-muted-foreground">{number(index + 1)}</span>}
        <div className="min-w-0"><p className="truncate text-sm font-semibold">{member.player_name}</p>
          <p className="text-xs text-muted-foreground"><bdi dir="ltr">{member.player_tag}</bdi></p></div>
      </Link>
      <div className="shrink-0 text-end">
        {attention ? <div className="mb-1 flex items-center justify-end gap-2"><span className={`text-xs ${status === "inactive" ? "text-red-400" : status === "minimal" ? "text-amber-400" : "text-muted-foreground"}`}>
          {t(status === "inactive" ? "Inactive" : status === "minimal" ? "Low activity" : "Active")}</span><MemberReviewButton member={member} initialRange={range} /></div>
          : numbered && <p className="text-sm font-medium">{number(member.trophies)}</p>}
        <p className={`text-sm font-medium ${change == null || change === 0 ? "text-muted-foreground" : change > 0 ? "text-green-500" : "text-red-400"}`}>
          {change == null ? t("Not enough history") : delta(change)}
        </p>
      </div>
    </div>;
  })}</div>;
}

export default function DashboardPage() {
  const { t, number, delta, reportDate } = useI18n();
  const { clubTag, apiKeyConfigured, requiredTrophies, lastSyncTime, isLoadingSettings, hasLoadedSettings, loadSettingsFromDB } = useAppStore();
  const [range, setRange] = useState<TimeRangeKey>("7d");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [insights, setInsights] = useState<ClubInsights | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [insightsError, setInsightsError] = useState(false);
  const generation = useRef(0);
  const isSetupComplete = hasLoadedSettings && Boolean(clubTag && apiKeyConfigured && lastSyncTime);

  useEffect(() => { if (!hasLoadedSettings) void loadSettingsFromDB(); }, [hasLoadedSettings, loadSettingsFromDB]);
  const invalidatePending = useCallback(() => { generation.current++; }, []);

  const loadData = useCallback((force = false) => {
    const request = ++generation.current;
    return Promise.allSettled([
      fetchJsonCached<DashboardResponse>(`/api/dashboard?range=${range}`, { staleMs: 30_000, force }),
      fetchJsonCached<{ insights: ClubInsights | null; period?: ClubInsights["period"] }>(`/api/insights?range=${range}`, { staleMs: 30_000, force }),
    ]).then(([summary, detail]) => {
    if (request !== generation.current) return;
    setError(summary.status !== "fulfilled");
    setInsightsError(detail.status !== "fulfilled");
    if (summary.status === "fulfilled") setDashboard(summary.value);
    if (detail.status === "fulfilled") setInsights(detail.value.insights ? { ...detail.value.insights, period: detail.value.period } : null);
    setLoadedKey(`${clubTag}:${range}`);
    setIsLoading(false);
    });
  }, [range, clubTag]);

  useEffect(() => {
    if (isLoadingSettings || !hasLoadedSettings || !isSetupComplete) return;
    loadData();
    const refresh = () => { void loadData(true); };
    window.addEventListener("club-data-updated", refresh);
    return () => { invalidatePending(); window.removeEventListener("club-data-updated", refresh); };
  }, [isLoadingSettings, hasLoadedSettings, isSetupComplete, loadData, invalidatePending]);

  if (isLoadingSettings || !hasLoadedSettings) return <div className="flex min-h-screen items-center justify-center"><div className="h-10 w-10 animate-spin rounded-full border-b-2 border-primary" /></div>;
  if (!isSetupComplete) return <SetupWizard />;

  return <LayoutWrapper><div className="space-y-6">
    <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-start">
      <div><h1 className="text-2xl font-bold">{t("Club overview")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("Activity, progress and changes in your club.")}</p>
        {requiredTrophies != null && <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Trophy className="h-3.5 w-3.5" />{t("Entry requirement: {count} trophies", { count: number(requiredTrophies) })}</p>}
      </div>
      <TimeRangePicker value={range} onChange={value => { if (value === range) return; generation.current++; setRange(value); setDashboard(null); setInsights(null); setError(false); setInsightsError(false); setIsLoading(true); }} />
    </div>
    <DataConfidenceNotice />
    <ClubGoalsOverview />
    <div className="grid gap-4 xl:grid-cols-2"><ClubIdentity /><ClubJoinSummary /></div>
    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <p>{t("Could not refresh the dashboard. Please try again.")}</p><Button variant="outline" size="sm" onClick={() => loadData(true)}>{t("Retry")}</Button>
    </div>}
    {isLoading || loadedKey !== `${clubTag}:${range}` ? <DashboardSkeleton /> : dashboard && <>
      <StatsCards {...dashboard.summary} />
      <div className="grid gap-4 xl:grid-cols-2"><ClubGrowthPeriod /><ClubStrength /></div>
      {insightsError && <p role="status" className="text-sm text-muted-foreground">{t("Battle statistics are temporarily unavailable.")}</p>}
      {insights && <section aria-label={t("Battle summary")} className="space-y-2">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card><CardContent className="p-5"><p className="flex items-center gap-2 text-sm text-muted-foreground"><Swords className="h-4 w-4" />{t("Recorded battles")}</p>
            <p className="mt-2 text-3xl font-bold">{number(insights.thisWeekTotal)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{insights.prevWeekTotal > 0 ? t("{change}% vs previous period", { change: delta(insights.trendDiff) }) : t("Previous period has no recorded battles")}</p>
          </CardContent></Card>
          <Card><CardContent className="p-5"><p className="flex items-center gap-2 text-sm text-muted-foreground"><Target className="h-4 w-4" />{t("Win Rate")}</p>
            <p className="mt-2 text-3xl font-bold">{insights.totalBattlesThisWeek > 0 ? `${number(insights.winRate)}%` : "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("{wins} wins / {battles} battles", { wins: number(insights.totalWins), battles: number(insights.totalBattlesThisWeek) })}</p>
          </CardContent></Card>
        </div>
        <p className="text-xs text-muted-foreground">{insights.period ? `${reportDate(insights.period.start)} – ${reportDate(insights.period.end)} · ` : ""}{t("Battle totals use UTC calendar days.")}</p>
        {insights.megaBoss.isTracked && <p className="text-sm text-muted-foreground">{t("Mega Boss: {wins} wins in {battles} recorded battles", { wins: number(insights.megaBoss.totalWins), battles: number(insights.megaBoss.totalBattles) })}</p>}
      </section>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ArrowUpRight className="h-5 w-5 text-green-500" />{t("Top trophy gains")}</CardTitle><p className="text-xs text-muted-foreground">{t(TIME_RANGES[range].label)}</p></CardHeader>
          <CardContent><MemberSignalList members={dashboard.topGainers || []} range={range} emptyText={dashboard.summary?.trophyProgressKnownMembers === 0 && dashboard.summary.totalMembers > 0 ? "Not enough history to compare trophies for this period." : "No positive trophy progress recorded for this period."} /></CardContent></Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ListChecks className="h-5 w-5 text-amber-500" />{t("Needs Attention")}</CardTitle><p className="text-xs text-muted-foreground">{t("Recent activity and trophy progress in the selected period.")}</p></CardHeader>
          <CardContent><MemberSignalList members={dashboard.attentionMembers || []} range={range} attention emptyText="No urgent member issues found." /></CardContent></Card>
      </div>
      <Card><CardHeader className="pb-3"><CardTitle className="text-base">{t("Club changes")}</CardTitle><p className="text-xs text-muted-foreground">{t(range === "24h" ? "Today (UTC)" : TIME_RANGES[range].label)}</p></CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">{([
          ["Joined", dashboard.changeSummary?.joins], ["Left", dashboard.changeSummary?.leaves],
          ["Names", dashboard.changeSummary?.nameChanges], ["Roles", dashboard.changeSummary?.roleChanges],
        ] as const).map(([label, count]) => <div key={label}><p className="text-xs text-muted-foreground">{t(label)}</p><p className="mt-1 text-2xl font-semibold">{number(count ?? 0)}</p></div>)}</CardContent></Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader className="flex flex-row items-center justify-between gap-3"><div><CardTitle className="text-base">{t("Trophy leaders")}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{t("Current trophies and progress in the selected period")}</p></div><Link href="/members" className="text-sm font-medium text-primary hover:underline"><T text="Open Members" /></Link></CardHeader>
          <CardContent><MemberSignalList members={dashboard.topMembers || []} range={range} numbered emptyText="No current members found." /></CardContent></Card>
        <ActivityTimeline events={dashboard.recentEvents || []} />
      </div>
    </>}
  </div></LayoutWrapper>;
}
