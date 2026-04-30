"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAppStore } from "@/lib/store";
import { fetchJsonCached } from "@/lib/client-data-cache";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { SetupWizard } from "@/components/setup-wizard";
import { StatsCards } from "@/components/stats-cards";
import { ActivityTimeline } from "@/components/activity-timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Member, ClubEvent } from "@/types/database";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Crown,
  ListChecks,
  Minus,
  PencilLine,
  ShieldCheck,
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
  megaPig: {
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

function formatNumber(value: number | null | undefined) {
  return (value || 0).toLocaleString();
}

function formatDelta(value: number | null | undefined) {
  if (value == null) return "No data";
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${value.toLocaleString()}`;
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

function formatRelativeTime(value: string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  const diffMs = Math.max(Date.now() - date.getTime(), 0);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTime(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function getNextScheduledSync(intervalMinutes: number) {
  const interval = Math.max(intervalMinutes || 30, 1);
  const next = new Date();
  next.setSeconds(0, 0);
  const remainder = next.getMinutes() % interval;
  next.setMinutes(next.getMinutes() + (remainder === 0 ? interval : interval - remainder));
  return next;
}

function getSyncHealth(lastSyncTime: string | null) {
  if (!lastSyncTime) {
    return {
      label: "No sync recorded",
      detail: "Waiting for the first successful sync",
      tone: "text-yellow-300",
      icon: AlertTriangle,
      isStale: true,
    };
  }

  const date = new Date(lastSyncTime);
  if (Number.isNaN(date.getTime())) {
    return {
      label: "Invalid sync time",
      detail: "Last sync timestamp could not be read",
      tone: "text-red-300",
      icon: AlertTriangle,
      isStale: true,
    };
  }

  const minutesAgo = Math.floor(Math.max(Date.now() - date.getTime(), 0) / 60_000);
  if (minutesAgo <= 45) {
    return {
      label: "Healthy",
      detail: `Updated ${formatRelativeTime(lastSyncTime)}`,
      tone: "text-green-400",
      icon: CheckCircle2,
      isStale: false,
    };
  }

  if (minutesAgo <= 90) {
    return {
      label: "Delayed",
      detail: `Last sync ${formatRelativeTime(lastSyncTime)}`,
      tone: "text-yellow-300",
      icon: AlertTriangle,
      isStale: true,
    };
  }

  return {
    label: "Stale",
    detail: `Last sync ${formatRelativeTime(lastSyncTime)}`,
    tone: "text-red-300",
    icon: AlertTriangle,
    isStale: true,
  };
}

function ActivityBadge({ status }: { status: ActivityStatus }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${getActivityClass(status)}`}>
      {getActivityLabel(status)}
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
  if (members.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 p-4 text-center text-sm text-muted-foreground">
        {emptyText}
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
                <p className="text-xs text-muted-foreground">{member.player_tag}</p>
              </div>
            </div>

            <div className="shrink-0 text-right">
              {mode === "attention" ? (
                <div className="flex flex-col items-end gap-1">
                  <ActivityBadge status={member.activity_status} />
                  <span className={`text-xs ${getDeltaClass(progressValue)}`}>
                    {formatDelta(progressValue)} in {progressWindow}
                  </span>
                </div>
              ) : (
                <>
                  <p className="text-sm font-semibold">{formatNumber(member.trophies)}</p>
                  <p className={`text-xs ${getDeltaClass(progressValue)}`}>
                    {mode === "top" || mode === "no-progress"
                      ? `${formatDelta(progressValue)} in ${progressWindow}`
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

function SyncStatusCard({
  lastSyncTime,
  intervalMinutes,
}: {
  lastSyncTime: string | null;
  intervalMinutes: number;
}) {
  const syncHealth = getSyncHealth(lastSyncTime);
  const SyncIcon = syncHealth.icon;
  const nextSync = getNextScheduledSync(intervalMinutes);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock3 className="h-5 w-5 text-blue-400" />
          Sync Status
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Current status</span>
          <span className={`flex items-center gap-1.5 text-sm font-semibold ${syncHealth.tone}`}>
            <SyncIcon className="h-4 w-4" />
            {syncHealth.label}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Last sync</span>
          <span className="text-sm font-medium">{syncHealth.detail}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Next auto sync</span>
          <span className="text-sm font-medium">{formatTime(nextSync)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Source</span>
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <ShieldCheck className="h-4 w-4 text-green-400" />
            cron-job.org
          </span>
        </div>
      </CardContent>
    </Card>
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
          Recent Club Changes
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {items.map((item) => (
            <div key={item.label} className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <item.icon className={`h-4 w-4 ${item.className}`} />
                {item.label}
              </div>
              <p className="mt-2 text-2xl font-bold">{item.value}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Last 7 days</p>
      </CardContent>
    </Card>
  );
}

function DataFreshnessAlert({ lastSyncTime }: { lastSyncTime: string | null }) {
  const syncHealth = getSyncHealth(lastSyncTime);
  if (!syncHealth.isStale) return null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-100">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-300" />
      <div>
        <p className="font-semibold">Data freshness warning</p>
        <p className="text-yellow-100/80">
          {syncHealth.detail}. Check cron-job.org or click Sync Now from the sidebar if the data should be current.
        </p>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const {
    clubTag,
    apiKeyConfigured,
    requiredTrophies,
    lastSyncTime,
    isLoadingSettings,
    hasLoadedSettings,
    loadSettingsFromDB,
    setLastSyncTime,
  } = useAppStore();
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [insights, setInsights] = useState<ClubInsights | null>(null);
  const [hasRequestedInsights, setHasRequestedInsights] = useState(false);
  const [isInsightsLoading, setIsInsightsLoading] = useState(false);
  const attentionMembersRef = useRef<HTMLDivElement | null>(null);
  const hasCachedSetup = Boolean(clubTag && apiKeyConfigured);

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
      if (dashboardData.syncStatus.lastSyncTime) {
        setLastSyncTime(dashboardData.syncStatus.lastSyncTime);
      }
    } catch (error) {
      console.error("Error loading dashboard:", error);
    } finally {
      setIsLoading(false);
      setDataLoaded(true);
    }
  }, [setLastSyncTime]);

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
    if (!mounted || (isLoadingSettings && !hasCachedSetup)) return;

    if (clubTag && apiKeyConfigured) {
      setIsSetupComplete(true);
      if (!dataLoaded) {
        loadData();
      }
      if (!hasRequestedInsights) {
        loadInsights();
      }
    } else if (!isLoadingSettings) {
      setIsSetupComplete(false);
      setIsLoading(false);
    }
  }, [
    apiKeyConfigured,
    clubTag,
    dataLoaded,
    hasCachedSetup,
    hasRequestedInsights,
    isLoadingSettings,
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

  if (!mounted || (isLoadingSettings && !hasCachedSetup)) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }

  if (!isSetupComplete && !isLoading && !isLoadingSettings) {
    return <SetupWizard onComplete={() => setIsSetupComplete(true)} />;
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

          <DataFreshnessAlert lastSyncTime={dashboardData.syncStatus.lastSyncTime} />

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Trophy className="h-5 w-5 text-yellow-500" />
                  Club Conditions
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">
                  {requiredTrophies != null ? requiredTrophies.toLocaleString() : "--"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">Required trophies to join</p>
              </CardContent>
            </Card>

            <SyncStatusCard
              lastSyncTime={dashboardData.syncStatus.lastSyncTime}
              intervalMinutes={dashboardData.syncStatus.intervalMinutes}
            />

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
                    <span className="text-sm font-medium text-muted-foreground">Mega Pig Wins</span>
                  </div>
                  <p className="text-3xl font-bold">{insights.megaPig.totalWins.toLocaleString()}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {insights.megaPig.isTracked
                      ? `${insights.megaPig.totalBattles.toLocaleString()} Mega Pig battles tracked`
                      : "No Mega Pig battles found this week"}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Target className="h-4 w-4 text-blue-500" />
                    <span className="text-sm font-medium text-muted-foreground">Win Rate</span>
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
                    {insights.totalWins.toLocaleString()} wins / {insights.totalBattlesThisWeek.toLocaleString()} battles
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <button
                    type="button"
                    onClick={scrollToAttentionMembers}
                    disabled={insights.kickCount === 0}
                    className="w-full text-left disabled:cursor-default"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <UserX className="h-4 w-4 text-red-500" />
                      <span className="text-sm font-medium text-muted-foreground">Inactive Members</span>
                    </div>
                    <p className="text-3xl font-bold">{insights.kickCount}</p>
                    <p className={`mt-1 text-sm ${insights.kickCount > 0 ? "text-muted-foreground" : "font-medium text-green-500"}`}>
                      {insights.kickCount > 0 ? "Need review" : "No inactive members"}
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
                    <span className="text-sm font-medium text-muted-foreground">Weekly Battles</span>
                  </div>
                  <p className="text-3xl font-bold">{insights.thisWeekTotal.toLocaleString()}</p>
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
                    {insights.trendDiff}% vs previous week
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Crown className="h-4 w-4 text-yellow-500" />
                    <span className="text-sm font-medium text-muted-foreground">MVP of the Week</span>
                  </div>
                  <p className="truncate text-2xl font-bold">{insights.mvpName || "---"}</p>
                  {insights.mvpName ? (
                    <p className={`mt-1 flex items-center gap-1 text-sm font-medium ${getDeltaClass(insights.mvpTrophies)}`}>
                      <Trophy className="h-3.5 w-3.5" />
                      {formatDelta(insights.mvpTrophies)} net trophies
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-muted-foreground">No weekly trophy leader yet</p>
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
                  Needs Attention
                </CardTitle>
                <p className="text-sm text-muted-foreground">Inactive, low activity, or no 3-day progress</p>
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
                  Top Gainers This Week
                </CardTitle>
                <p className="text-sm text-muted-foreground">Best 7-day trophy progress</p>
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
                  No Progress
                </CardTitle>
                <p className="text-sm text-muted-foreground">Exactly 0 net trophies over 3 days</p>
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
                  <CardTitle>Top Members</CardTitle>
                  <p className="text-sm text-muted-foreground">Highest trophies with weekly movement</p>
                </div>
                <Link href="/members" className="shrink-0 text-sm font-medium text-primary hover:underline">
                  Open Members
                </Link>
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
