"use client";
import { T, useI18n } from "@/components/locale-provider";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAppStore } from "@/lib/store";
import { fetchJsonCached } from "@/lib/client-data-cache";
import { DataConfidenceNotice, SyncHealthCard } from "@/components/sync-health";
import { MemberReviewButton } from "@/components/member-review";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { SetupWizard } from "@/components/setup-wizard";
import { StatsCards } from "@/components/stats-cards";
import { ActivityTimeline } from "@/components/activity-timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Member, ClubEvent } from "@/types/database";
import {
  Activity,
  ArrowUpRight,
  Crown,
  ListChecks,
  Minus,
  PencilLine,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
  UserMinus,
  UserPlus,
  UserX,
} from "lucide-react";

type ActivityStatus = "active" | "minimal" | "inactive";

interface DashboardMember extends Member {
  trophies_24h: number | null;
  trophies_3d: number | null;
  trophies_7d: number | null;
  activity_status: ActivityStatus;
  last_battle_at: string | null;
}

interface DashboardResponse {
  summary: {
    totalMembers: number;
    totalTrophies: number;
    activeMembers: number;
    avgTrophies: number;
  };
  topMembers: DashboardMember[];
  topGainers: DashboardMember[];
  noProgressMembers: DashboardMember[];
  attentionMembers: DashboardMember[];
  changeSummary: {
    joins: number;
    leaves: number;
    nameChanges: number;
    roleChanges: number;
    since: string;
  };
  syncStatus: {
    lastSyncTime: string | null;
    source: string;
    intervalMinutes: number;
  };
  recentEvents: ClubEvent[];
  generatedAt?: string;
}

interface ClubInsights {
  megaBoss: {
    isTracked: boolean;
    totalWins: number;
    totalBattles: number;
    rankReached: string | null;
    lastBattleAt: string | null;
  };
  winRate: number;
  totalWins: number;
  totalBattlesThisWeek: number;
  kickList: { tag: string; name: string; lastActive: string | null }[];
  kickCount: number;
  thisWeekTotal: number;
  prevWeekTotal: number;
  trendDiff: number;
  trendDirection: "up" | "down" | "flat";
  mvpName: string | null;
  mvpTrophies: number;
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index}>
            <CardContent className="h-28 animate-pulse p-6">
              <div className="h-4 w-24 rounded bg-muted" />
              <div className="mt-5 h-7 w-20 rounded bg-muted/70" />
              <div className="mt-3 h-3 w-28 rounded bg-muted/50" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Card key={index}>
            <CardContent className="h-40 animate-pulse p-6">
              <div className="h-4 w-32 rounded bg-muted" />
              <div className="mt-6 h-10 rounded bg-muted/60" />
              <div className="mt-3 h-10 rounded bg-muted/40" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function InsightsSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      {Array.from({ length: 5 }).map((_, index) => (
        <Card key={index}>
          <CardContent className="h-32 animate-pulse p-4">
            <div className="h-4 w-24 rounded bg-muted" />
            <div className="mt-5 h-8 w-16 rounded bg-muted/70" />
            <div className="mt-3 h-3 w-32 rounded bg-muted/50" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}





function getDeltaClass(value: number | null | undefined) {
  if (value == null || value === 0) return "text-muted-foreground";
  return value > 0 ? "text-green-500" : "text-red-400";
}

function getActivityLabel(status: ActivityStatus) {
  if (status === "active") return "Active";
  if (status === "minimal") return "Low activity";
  return "Inactive";
}

function getActivityClass(status: ActivityStatus) {
  if (status === "active") return "border-green-500/30 bg-green-500/10 text-green-400";
  if (status === "minimal") return "border-yellow-500/30 bg-yellow-500/10 text-yellow-300";
  return "border-red-500/30 bg-red-500/10 text-red-300";
}



function ActivityBadge({ status }: { status: ActivityStatus }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${getActivityClass(status)}`}>
      <T text={getActivityLabel(status)} />
    </span>
  );
}

function MemberSignalList({
  members,
  emptyText,
  mode,
}: {
  members: DashboardMember[];
  emptyText: string;
  mode: "gain" | "no-progress" | "attention" | "top";
}) {
  const { delta: formatDelta, number: formatNumber } = useI18n();
  if (members.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 p-4 text-center text-sm text-muted-foreground">
        <T text={emptyText} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {members.map((member, index) => {
        const progressValue = mode === "attention" || mode === "no-progress"
          ? member.trophies_3d
          : member.trophies_7d;
        const progressWindow = mode === "attention" || mode === "no-progress" ? "3d" : "7d";

        return (
          <div
            key={member.player_tag}
            className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5"
          >
            <div className="flex min-w-0 items-center gap-3">
              {mode === "top" && (
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-xs font-bold text-primary">
                  {index + 1}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{member.player_name || "Unknown player"}</p>
                <p className="text-xs text-muted-foreground"><bdi dir="ltr">{member.player_tag}</bdi></p>
              </div>
            </div>

            <div className="shrink-0 text-end">
              {mode === "attention" ? (
                <div className="flex flex-col items-end gap-1">
                  <ActivityBadge status={member.activity_status} /><MemberReviewButton member={member} />
                  <span className={`text-xs ${getDeltaClass(progressValue)}`}>
                    <T text="{change} in {days} days" values={{change:formatDelta(progressValue),days: progressWindow === "3d" ? 3 : 7}} />
                  </span>
                </div>
              ) : (
                <>
                  <p className="text-sm font-semibold">{formatNumber(member.trophies)}</p>
                  <p className={`text-xs ${getDeltaClass(progressValue)}`}>
                    {mode === "top" || mode === "no-progress"
                      ? <T text="{change} in {days} days" values={{change:formatDelta(progressValue),days: progressWindow === "3d" ? 3 : 7}} />
                      : formatDelta(progressValue)}
                  </p>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RecentChangesCard({
  changeSummary,
}: {
  changeSummary: DashboardResponse["changeSummary"];
}) {
  const items = [
    { label: "Joined", value: changeSummary.joins, icon: UserPlus, className: "text-green-400" },
    { label: "Left", value: changeSummary.leaves, icon: UserMinus, className: "text-red-400" },
    { label: "Names", value: changeSummary.nameChanges, icon: PencilLine, className: "text-blue-400" },
    { label: "Roles", value: changeSummary.roleChanges, icon: Crown, className: "text-yellow-400" },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-5 w-5 text-green-400" />
          <T text=" Recent Club Changes " /></CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {items.map((item) => (
            <div key={item.label} className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <item.icon className={`h-4 w-4 ${item.className}`} />
                {<T text={item.label} />}
              </div>
              <p className="mt-2 text-2xl font-bold">{item.value}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground"><T text="Last 7 days" /></p>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { number, delta: formatDelta } = useI18n();
  const {
    clubTag,
    apiKeyConfigured,
    requiredTrophies,
    lastSyncTime,
    isLoadingSettings,
    hasLoadedSettings,
    loadSettingsFromDB,
  } = useAppStore();
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [insights, setInsights] = useState<ClubInsights | null>(null);
  const [hasRequestedInsights, setHasRequestedInsights] = useState(false);
  const [isInsightsLoading, setIsInsightsLoading] = useState(false);
  const attentionMembersRef = useRef<HTMLDivElement | null>(null);
  const isSetupComplete = hasLoadedSettings && Boolean(clubTag && apiKeyConfigured && lastSyncTime);

  useEffect(() => {
    setMounted(true);
    if (!hasLoadedSettings) {
      loadSettingsFromDB();
    }
  }, [hasLoadedSettings, loadSettingsFromDB]);

  const loadData = useCallback(async (force = false) => {
    try {
      if (!force) {
        setIsLoading(true);
      }
      const dashboardData = await fetchJsonCached<DashboardResponse>("/api/dashboard", {
        staleMs: 30_000,
        force,
      });

      setDashboard(dashboardData);
    } catch (error) {
      console.error("Error loading dashboard:", error);
    } finally {
      setIsLoading(false);
      setDataLoaded(true);
    }
  }, []);

  const loadInsights = useCallback(async (force = false) => {
    try {
      setIsInsightsLoading(true);
      const data = await fetchJsonCached<{ insights: ClubInsights | null }>("/api/insights", {
        staleMs: 30_000,
        force,
      });
      setInsights(data.insights || null);
    } catch (error) {
      console.error("Error loading insights:", error);
    } finally {
      setIsInsightsLoading(false);
      setHasRequestedInsights(true);
    }
  }, []);

  useEffect(() => {
    if (!mounted || isLoadingSettings || !hasLoadedSettings) return;

    if (isSetupComplete) {
      if (!dataLoaded) {
        loadData();
      }
      if (!hasRequestedInsights) {
        loadInsights();
      }
    } else if (!isLoadingSettings) {
      setIsLoading(false);
    }
  }, [
    dataLoaded,
    hasLoadedSettings,
    hasRequestedInsights,
    isLoadingSettings,
    isSetupComplete,
    loadData,
    loadInsights,
    mounted,
  ]);

  useEffect(() => {
    const handleClubDataUpdated = () => {
      loadData(true);
      loadInsights(true);
    };
    window.addEventListener("club-data-updated", handleClubDataUpdated);
    return () => window.removeEventListener("club-data-updated", handleClubDataUpdated);
  }, [loadData, loadInsights]);

  const scrollToAttentionMembers = () => {
    attentionMembersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const dashboardData = useMemo(() => {
    const summary = dashboard?.summary;
    const totalMembers = summary?.totalMembers ?? 0;
    const totalTrophies = summary?.totalTrophies ?? 0;
    const activeMembers = summary?.activeMembers ?? 0;
    const avgTrophies = summary?.avgTrophies ?? 0;

    return {
      totalMembers,
      totalTrophies,
      activeMembers,
      avgTrophies,
      topMembers: dashboard?.topMembers ?? [],
      topGainers: dashboard?.topGainers ?? [],
      noProgressMembers: dashboard?.noProgressMembers ?? [],
      attentionMembers: dashboard?.attentionMembers ?? [],
      recentEvents: dashboard?.recentEvents ?? [],
      changeSummary: dashboard?.changeSummary ?? {
        joins: 0,
        leaves: 0,
        nameChanges: 0,
        roleChanges: 0,
        since: "",
      },
      syncStatus: {
        lastSyncTime: dashboard?.syncStatus.lastSyncTime || lastSyncTime,
        intervalMinutes: dashboard?.syncStatus.intervalMinutes ?? 30,
      },
    };
  }, [dashboard, lastSyncTime]);

  if (!mounted || isLoadingSettings || !hasLoadedSettings) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }

  if (!isSetupComplete && !isLoading && !isLoadingSettings) {
    return <SetupWizard />;
  }

  return (
    <LayoutWrapper>
      {isLoading ? (
        <DashboardSkeleton />
      ) : (
        <div className="space-y-6">
          <StatsCards
            totalMembers={dashboardData.totalMembers}
            totalTrophies={dashboardData.totalTrophies}
            activeMembers={dashboardData.activeMembers}
            avgTrophies={dashboardData.avgTrophies}
          />

          <DataConfidenceNotice />

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Trophy className="h-5 w-5 text-yellow-500" />
                  <T text=" Club Conditions " /></CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">
                  {requiredTrophies != null ? number(requiredTrophies) : "--"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground"><T text="Required trophies to join" /></p>
              </CardContent>
            </Card>

            <SyncHealthCard />

            <RecentChangesCard changeSummary={dashboardData.changeSummary} />
          </div>

          {isInsightsLoading && !insights ? (
            <InsightsSkeleton />
          ) : insights ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <Card>
                <CardContent className="pt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Trophy className="h-4 w-4 text-yellow-500" />
                    <span className="text-sm font-medium text-muted-foreground"><T text="Mega Boss Wins" /></span>
                  </div>
                  <p className="text-3xl font-bold">{number(insights.megaBoss.totalWins)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {insights.megaBoss.isTracked
                      ? <T text="{value0} Mega Boss battles tracked" values={{ value0: String(number(insights.megaBoss.totalBattles)) }} />
                      : <T text="No Mega Boss battles found this week" />}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Target className="h-4 w-4 text-blue-500" />
                    <span className="text-sm font-medium text-muted-foreground"><T text="Win Rate" /></span>
                  </div>
                  <p
                    className={`text-3xl font-bold ${
                      insights.winRate >= 55
                        ? "text-green-500"
                        : insights.winRate >= 45
                          ? "text-foreground"
                          : "text-red-500"
                    }`}
                  >
                    {insights.winRate}%
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {number(insights.totalWins)} <T text=" wins / " />{number(insights.totalBattlesThisWeek)} <T text=" battles " /></p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <button
                    type="button"
                    onClick={scrollToAttentionMembers}
                    disabled={insights.kickCount === 0}
                    className="w-full text-start disabled:cursor-default"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <UserX className="h-4 w-4 text-red-500" />
                      <span className="text-sm font-medium text-muted-foreground"><T text="Inactive Members" /></span>
                    </div>
                    <p className="text-3xl font-bold">{insights.kickCount}</p>
                    <p className={`mt-1 text-sm ${insights.kickCount > 0 ? "text-muted-foreground" : "font-medium text-green-500"}`}>
                      {insights.kickCount > 0 ? <T text="Need review" /> : <T text="No inactive members" />}
                    </p>
                  </button>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="mb-2 flex items-center gap-2">
                    {insights.trendDirection === "up" ? (
                      <TrendingUp className="h-4 w-4 text-green-500" />
                    ) : insights.trendDirection === "down" ? (
                      <TrendingDown className="h-4 w-4 text-red-500" />
                    ) : (
                      <Minus className="h-4 w-4 text-yellow-500" />
                    )}
                    <span className="text-sm font-medium text-muted-foreground"><T text="Weekly Battles" /></span>
                  </div>
                  <p className="text-3xl font-bold">{number(insights.thisWeekTotal)}</p>
                  <p
                    className={`mt-1 text-sm ${
                      insights.trendDirection === "up"
                        ? "text-green-500"
                        : insights.trendDirection === "down"
                          ? "text-red-400"
                          : "text-muted-foreground"
                    }`}
                  >
                    {insights.trendDiff > 0 ? "+" : ""}
                    {insights.trendDiff}<T text="% vs previous week " /></p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Crown className="h-4 w-4 text-yellow-500" />
                    <span className="text-sm font-medium text-muted-foreground"><T text="MVP of the Week" /></span>
                  </div>
                  <p className="truncate text-2xl font-bold">{insights.mvpName || "---"}</p>
                  {insights.mvpName ? (
                    <p className={`mt-1 flex items-center gap-1 text-sm font-medium ${getDeltaClass(insights.mvpTrophies)}`}>
                      <Trophy className="h-3.5 w-3.5" />
                      {formatDelta(insights.mvpTrophies)} <T text=" net trophies " /></p>
                  ) : (
                    <p className="mt-1 text-sm text-muted-foreground"><T text="No weekly trophy leader yet" /></p>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}

          <div ref={attentionMembersRef} className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ListChecks className="h-5 w-5 text-yellow-400" />
                  <T text=" Needs Attention " /></CardTitle>
                <p className="text-sm text-muted-foreground"><T text="Inactive, low activity, or no 3-day progress" /></p>
              </CardHeader>
              <CardContent>
                <MemberSignalList
                  members={dashboardData.attentionMembers}
                  mode="attention"
                  emptyText="No urgent member issues found."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ArrowUpRight className="h-5 w-5 text-green-400" />
                  <T text=" Top Gainers This Week " /></CardTitle>
                <p className="text-sm text-muted-foreground"><T text="Best 7-day trophy progress" /></p>
              </CardHeader>
              <CardContent>
                <MemberSignalList
                  members={dashboardData.topGainers}
                  mode="gain"
                  emptyText="No positive 7-day trophy changes yet."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Minus className="h-5 w-5 text-yellow-400" />
                  <T text=" No Progress " /></CardTitle>
                <p className="text-sm text-muted-foreground"><T text="Exactly 0 net trophies over 3 days" /></p>
              </CardHeader>
              <CardContent>
                <MemberSignalList
                  members={dashboardData.noProgressMembers}
                  mode="no-progress"
                  emptyText="No members are stuck at 0 progress."
                />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <div>
                  <CardTitle><T text="Top Members" /></CardTitle>
                  <p className="text-sm text-muted-foreground"><T text="Highest trophies with weekly movement" /></p>
                </div>
                <Link href="/members" className="shrink-0 text-sm font-medium text-primary hover:underline">
                  <T text=" Open Members " /></Link>
              </CardHeader>
              <CardContent>
                <MemberSignalList
                  members={dashboardData.topMembers}
                  mode="top"
                  emptyText="No current members found."
                />
              </CardContent>
            </Card>

            <ActivityTimeline events={dashboardData.recentEvents} />
          </div>
        </div>
      )}
    </LayoutWrapper>
  );
}
