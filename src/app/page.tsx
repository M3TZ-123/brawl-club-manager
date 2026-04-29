"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAppStore } from "@/lib/store";
import { fetchJsonCached } from "@/lib/client-data-cache";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { SetupWizard } from "@/components/setup-wizard";
import { StatsCards } from "@/components/stats-cards";
import { ActivityTimeline } from "@/components/activity-timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Member, ClubEvent } from "@/types/database";
import { Trophy, UserX, TrendingUp, TrendingDown, Minus, Crown, Target, Copy, Check } from "lucide-react";

function ChartSkeleton() {
  return (
    <Card>
      <CardContent className="h-[320px] animate-pulse p-6">
        <div className="h-5 w-32 rounded bg-muted" />
        <div className="mt-6 h-56 rounded bg-muted/60" />
      </CardContent>
    </Card>
  );
}

function MembersPreviewSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="h-10 animate-pulse rounded bg-muted/60" />
      ))}
    </div>
  );
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
      <div className="grid gap-6 md:grid-cols-2">
        <ChartSkeleton />
        <ChartSkeleton />
      </div>
    </div>
  );
}

function InsightsSkeleton() {
  return (
    <div className="grid gap-4 grid-cols-2 lg:grid-cols-5">
      {Array.from({ length: 5 }).map((_, index) => (
        <Card key={index}>
          <CardContent className="h-28 animate-pulse p-4">
            <div className="h-4 w-20 rounded bg-muted" />
            <div className="mt-5 h-7 w-14 rounded bg-muted/70" />
            <div className="mt-3 h-3 w-24 rounded bg-muted/50" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

const ActivityPieChart = dynamic(
  () => import("@/components/charts").then((mod) => mod.ActivityPieChart),
  { ssr: false, loading: () => <ChartSkeleton /> }
);

const MemberBarChart = dynamic(
  () => import("@/components/charts").then((mod) => mod.MemberBarChart),
  { ssr: false, loading: () => <ChartSkeleton /> }
);

const MembersTable = dynamic(
  () => import("@/components/members-table").then((mod) => mod.MembersTable),
  { loading: () => <MembersPreviewSkeleton /> }
);

interface DashboardResponse {
  summary: {
    totalMembers: number;
    totalTrophies: number;
    activeMembers: number;
    avgTrophies: number;
  };
  topMembers: Member[];
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

export default function DashboardPage() {
  const {
    clubTag,
    apiKeyConfigured,
    requiredTrophies,
    isLoadingSettings,
    hasLoadedSettings,
    loadSettingsFromDB,
  } = useAppStore();
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [insights, setInsights] = useState<ClubInsights | null>(null);
  const [hasRequestedInsights, setHasRequestedInsights] = useState(false);
  const [isInsightsLoading, setIsInsightsLoading] = useState(false);
  const [copiedTag, setCopiedTag] = useState<string | null>(null);
  const inactiveMembersRef = useRef<HTMLDivElement | null>(null);
  const copyResetTimeoutRef = useRef<number | null>(null);
  const hasCachedSetup = Boolean(clubTag && apiKeyConfigured);

  useEffect(() => {
    setMounted(true);
    // Load settings from database on mount (only if not already loaded)
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

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
    };
  }, []);

  const scrollToInactiveMembers = () => {
    inactiveMembersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleCopyTag = async (tag: string) => {
    try {
      await navigator.clipboard.writeText(tag);
      setCopiedTag(tag);
      if (copyResetTimeoutRef.current) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopiedTag((current) => (current === tag ? null : current));
        copyResetTimeoutRef.current = null;
      }, 1200);
    } catch (error) {
      console.error("Failed to copy player tag:", error);
    }
  };

  const dashboardData = useMemo(() => {
    const summary = dashboard?.summary;
    const totalMembers = summary?.totalMembers ?? 0;
    const totalTrophies = summary?.totalTrophies ?? 0;
    const activeMembers = summary?.activeMembers ?? 0;
    const avgTrophies = summary?.avgTrophies ?? 0;
    const topMembers = dashboard?.topMembers ?? [];
    const recentEvents = dashboard?.recentEvents ?? [];

    return {
      totalMembers,
      totalTrophies,
      activeMembers,
      avgTrophies,
      activityData: [
        { name: "Active", value: activeMembers, color: "#22c55e" },
        { name: "Inactive", value: Math.max(totalMembers - activeMembers, 0), color: "#ef4444" },
      ],
      topMembers: topMembers.map((m) => ({
        name: m.player_name,
        trophies: m.trophies,
      })),
      dashboardMembers: topMembers,
      recentEvents,
    };
  }, [dashboard]);

  if (!mounted || (isLoadingSettings && !hasCachedSetup)) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
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
          {/* Stats Overview */}
          <StatsCards
            totalMembers={dashboardData.totalMembers}
            totalTrophies={dashboardData.totalTrophies}
            activeMembers={dashboardData.activeMembers}
            avgTrophies={dashboardData.avgTrophies}
          />

          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-1">
                <Trophy className="h-4 w-4 text-yellow-500" />
                <span className="text-xs font-medium text-muted-foreground">Club Conditions</span>
              </div>
              <p className="text-2xl font-bold">
                {requiredTrophies != null ? requiredTrophies.toLocaleString() : "—"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Required trophies to join</p>
            </CardContent>
          </Card>

          {/* Club Insights */}
          {isInsightsLoading && !insights ? (
            <InsightsSkeleton />
          ) : insights && (
            <>
              <div className="grid gap-4 grid-cols-2 lg:grid-cols-5">
                {/* Mega Pig */}
                <Card>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Trophy className="h-4 w-4 text-yellow-500" />
                      <span className="text-xs font-medium text-muted-foreground">Mega Pig Battles</span>
                    </div>
                    <p className="text-2xl font-bold">{insights.megaPig.totalWins.toLocaleString()} wins</p>
                    {insights.megaPig.isTracked ? (
                      <p className="text-xs text-muted-foreground mt-1">
                        Out of {insights.megaPig.totalBattles.toLocaleString()} member battles this week
                        {insights.megaPig.rankReached ? ` · Rank ${insights.megaPig.rankReached}` : ""}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-1">
                        No Mega Pig battles found this week
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* Win Rate */}
                <Card>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Target className="h-4 w-4 text-blue-500" />
                      <span className="text-xs font-medium text-muted-foreground">Win Rate</span>
                    </div>
                    <p className={`text-2xl font-bold ${
                      insights.winRate >= 55 ? "text-green-500" :
                      insights.winRate >= 45 ? "text-foreground" : "text-red-500"
                    }`}>{insights.winRate}%</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {insights.totalWins.toLocaleString()} wins from {insights.totalBattlesThisWeek.toLocaleString()} battles this week
                    </p>
                  </CardContent>
                </Card>

                {/* Kick List */}
                <Card>
                  <CardContent className="pt-4 pb-3">
                    <button
                      type="button"
                      onClick={scrollToInactiveMembers}
                      disabled={insights.kickCount === 0}
                      className="w-full text-left disabled:cursor-default"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <UserX className="h-4 w-4 text-red-500" />
                        <span className="text-xs font-medium text-muted-foreground">Inactive Members</span>
                      </div>
                      <p className="text-2xl font-bold">{insights.kickCount}</p>
                      {insights.kickCount > 0 ? (
                        <p className="text-xs text-muted-foreground mt-1">
                          Members with no recent activity
                        </p>
                      ) : (
                        <p className="text-xs text-green-500 mt-1 font-medium">No inactive members</p>
                      )}
                    </button>
                  </CardContent>
                </Card>

                {/* Activity Trend */}
                <Card>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center gap-2 mb-2">
                      {insights.trendDirection === "up" ? (
                        <TrendingUp className="h-4 w-4 text-green-500" />
                      ) : insights.trendDirection === "down" ? (
                        <TrendingDown className="h-4 w-4 text-red-500" />
                      ) : (
                        <Minus className="h-4 w-4 text-yellow-500" />
                      )}
                      <span className="text-xs font-medium text-muted-foreground">Battle Activity</span>
                    </div>
                    <p className={`text-2xl font-bold ${
                      insights.trendDirection === "up" ? "text-green-500" :
                      insights.trendDirection === "down" ? "text-red-500" : ""
                    }`}>
                      {insights.trendDiff > 0 ? "+" : ""}{insights.trendDiff}%
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {insights.thisWeekTotal.toLocaleString()} battles vs {insights.prevWeekTotal.toLocaleString()} previous week
                    </p>
                  </CardContent>
                </Card>

                {/* MVP of the Week */}
                <Card>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Crown className="h-4 w-4 text-yellow-500" />
                      <span className="text-xs font-medium text-muted-foreground">MVP of the Week</span>
                    </div>
                    <p className="text-lg font-bold truncate">{insights.mvpName || "---"}</p>
                    {insights.mvpName && (
                      <p className={`text-xs mt-1 font-medium flex items-center gap-1 ${
                        insights.mvpTrophies >= 0 ? "text-green-500" : "text-red-500"
                      }`}>
                        <Trophy className="h-3 w-3" /> {insights.mvpTrophies > 0 ? "+" : ""}
                        {insights.mvpTrophies.toLocaleString()} net trophies
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Kick List Details */}
              {insights.kickCount > 0 && (
                <div id="inactive-members" ref={inactiveMembersRef}>
                  <Card>
                    <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-2 mb-4">
                      <UserX className="h-4 w-4 text-red-500" />
                      <span className="text-sm font-medium">Inactive Members</span>
                      <span className="text-xs text-muted-foreground ml-auto">Last Active</span>
                    </div>
                    <div className="space-y-0 divide-y divide-border/50">
                      {insights.kickList.map((k) => {
                        let inactiveLabel = "No records";
                        let severity: "high" | "medium" | "low" = "low";
                        if (k.lastActive) {
                          const diff = Date.now() - new Date(k.lastActive).getTime();
                          const days = Math.floor(diff / (1000 * 60 * 60 * 24));
                          if (days === 0) inactiveLabel = "Today";
                          else if (days === 1) inactiveLabel = "1 day ago";
                          else if (days < 7) inactiveLabel = `${days} days ago`;
                          else if (days < 14) inactiveLabel = "1 week ago";
                          else if (days < 30) inactiveLabel = `${Math.floor(days / 7)} weeks ago`;
                          else inactiveLabel = `${Math.floor(days / 30)}+ months ago`;
                          
                          if (days >= 14) severity = "high";
                          else if (days >= 7) severity = "medium";
                        } else {
                          severity = "high";
                        }
                        return (
                          <div key={k.tag} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className={`h-2 w-2 rounded-full shrink-0 ${
                                severity === "high" ? "bg-red-500" :
                                severity === "medium" ? "bg-orange-500" : "bg-yellow-500"
                              }`} />
                              <div className="min-w-0">
                                <span className="text-sm font-medium truncate block">{k.name}</span>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs text-muted-foreground">{k.tag}</span>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-5 w-5"
                                    onClick={() => handleCopyTag(k.tag)}
                                    aria-label={`Copy tag ${k.tag}`}
                                  >
                                    {copiedTag === k.tag ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                                  </Button>
                                </div>
                              </div>
                            </div>
                            <span className={`text-xs whitespace-nowrap ml-3 ${
                              severity === "high" ? "text-red-400" :
                              severity === "medium" ? "text-orange-400" : "text-muted-foreground"
                            }`}>{inactiveLabel}</span>
                          </div>
                        );
                      })}
                    </div>
                    </CardContent>
                  </Card>
                </div>
              )}
            </>
          )}

          {/* Charts Row */}
          <div className="grid gap-6 md:grid-cols-2">
            <ActivityPieChart data={dashboardData.activityData} />
            <MemberBarChart data={dashboardData.topMembers} />
          </div>

          {/* Members and Activity */}
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle>Club Members</CardTitle>
                  <Link href="/members" className="text-sm text-primary hover:underline">
                    View All →
                  </Link>
                </CardHeader>
                <CardContent>
                  <MembersTable members={dashboardData.dashboardMembers} showPagination={false} />
                </CardContent>
              </Card>
            </div>
            <div>
              <ActivityTimeline events={dashboardData.recentEvents} />
            </div>
          </div>
        </div>
      )}
    </LayoutWrapper>
  );
}
