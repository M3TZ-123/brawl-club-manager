"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAppStore } from "@/lib/store";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { SetupWizard } from "@/components/setup-wizard";
import { StatsCards } from "@/components/stats-cards";
import { MembersTable } from "@/components/members-table";
import { ActivityTimeline } from "@/components/activity-timeline";
import { ActivityPieChart, MemberBarChart } from "@/components/charts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Member, ClubEvent } from "@/types/database";
import { Trophy, UserX, TrendingUp, TrendingDown, Minus, Crown, Target } from "lucide-react";

interface ClubInsights {
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
  const { clubTag, apiKey, isLoadingSettings, hasLoadedSettings, loadSettingsFromDB } = useAppStore();
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<ClubEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [insights, setInsights] = useState<ClubInsights | null>(null);

  useEffect(() => {
    setMounted(true);
    // Load settings from database on mount (only if not already loaded)
    if (!hasLoadedSettings) {
      loadSettingsFromDB();
    }
  }, [hasLoadedSettings, loadSettingsFromDB]);

  useEffect(() => {
    if (!mounted || isLoadingSettings) return;
    
    if (clubTag && apiKey) {
      setIsSetupComplete(true);
      if (!dataLoaded) {
        loadData();
      }
    } else {
      setIsLoading(false);
    }
  }, [clubTag, apiKey, mounted, isLoadingSettings, dataLoaded]);

  const loadData = async () => {
    try {
      const [membersRes, eventsRes, insightsRes] = await Promise.all([
        fetch("/api/members"),
        fetch("/api/events"),
        fetch("/api/insights"),
      ]);

      if (membersRes.ok) {
        const data = await membersRes.json();
        setMembers(data.members || []);
      }

      if (eventsRes.ok) {
        const data = await eventsRes.json();
        setEvents(data.events || []);
      }

      if (insightsRes.ok) {
        const data = await insightsRes.json();
        setInsights(data.insights || null);
      }
    } catch (error) {
      console.error("Error loading data:", error);
    } finally {
      setIsLoading(false);
      setDataLoaded(true);
    }
  };

  if (!mounted || isLoadingSettings) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isSetupComplete && !isLoading) {
    return <SetupWizard onComplete={() => setIsSetupComplete(true)} />;
  }

  const totalTrophies = members.reduce((sum, m) => sum + m.trophies, 0);
  const activeMembers = members.filter((m) => m.is_active).length;
  const avgTrophies = members.length > 0 ? Math.round(totalTrophies / members.length) : 0;

  const activityData = [
    { name: "Active", value: activeMembers, color: "#22c55e" },
    { name: "Inactive", value: Math.max(members.length - activeMembers, 0), color: "#ef4444" },
  ];

  const topMembers = members.slice(0, 10).map((m) => ({
    name: m.player_name,
    trophies: m.trophies,
  }));

  return (
    <LayoutWrapper>
      {isLoading ? (
        <div className="flex items-center justify-center h-full">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Stats Overview */}
          <StatsCards
            totalMembers={members.length}
            totalTrophies={totalTrophies}
            activeMembers={activeMembers}
            avgTrophies={avgTrophies}
          />

          {/* Club Insights */}
          {insights && (
            <>
              <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
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
                      {insights.totalWins}W this week
                    </p>
                  </CardContent>
                </Card>

                {/* Kick List */}
                <Card>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center gap-2 mb-2">
                      <UserX className="h-4 w-4 text-red-500" />
                      <span className="text-xs font-medium text-muted-foreground">Kick List</span>
                    </div>
                    <p className="text-2xl font-bold">{insights.kickCount}</p>
                    {insights.kickCount > 0 ? (
                      <p className="text-xs text-muted-foreground mt-1">
                        Inactive members
                      </p>
                    ) : (
                      <p className="text-xs text-green-500 mt-1 font-medium">All members active</p>
                    )}
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
                      <span className="text-xs font-medium text-muted-foreground">Activity Trend</span>
                    </div>
                    <p className={`text-2xl font-bold ${
                      insights.trendDirection === "up" ? "text-green-500" :
                      insights.trendDirection === "down" ? "text-red-500" : ""
                    }`}>
                      {insights.trendDiff > 0 ? "+" : ""}{insights.trendDiff}%
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {insights.thisWeekTotal} vs {insights.prevWeekTotal} last week
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
                    {insights.mvpTrophies > 0 && (
                      <p className="text-xs text-green-500 mt-1 font-medium flex items-center gap-1">
                        <Trophy className="h-3 w-3" /> +{insights.mvpTrophies.toLocaleString()} trophies
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Kick List Details */}
              {insights.kickCount > 0 && (
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
                              <span className="text-sm font-medium truncate">{k.name}</span>
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
              )}
            </>
          )}

          {/* Charts Row */}
          <div className="grid gap-6 md:grid-cols-2">
            <ActivityPieChart data={activityData} />
            <MemberBarChart data={topMembers} />
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
                  <MembersTable members={members.slice(0, 10)} showPagination={false} />
                </CardContent>
              </Card>
            </div>
            <div>
              <ActivityTimeline events={events.slice(0, 5)} />
            </div>
          </div>
        </div>
      )}
    </LayoutWrapper>
  );
}
