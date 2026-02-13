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
import { Progress } from "@/components/ui/progress";
import { Member, ClubEvent } from "@/types/database";
import { HeartPulse, ShieldCheck, Swords, Clock } from "lucide-react";

interface ClubInsights {
  retentionRate: number;
  recentJoins: number;
  totalLeaves: number;
  avgBattlesPerMember: number;
  totalWeeklyBattles: number;
  weeklyActivePlayers: number;
  weeklyActivityRate: number;
  peakHour: string | null;
  healthScore: number;
  healthLabel: string;
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
            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
              <Card className="relative overflow-hidden">
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-center gap-2 mb-2">
                    <HeartPulse className="h-4 w-4 text-rose-500" />
                    <span className="text-xs font-medium text-muted-foreground">Club Health</span>
                  </div>
                  <p className="text-2xl font-bold">{insights.healthScore}</p>
                  <Progress value={insights.healthScore} className="h-1.5 mt-2" />
                  <p className={`text-xs mt-1 font-medium ${
                    insights.healthScore >= 80 ? "text-green-500" :
                    insights.healthScore >= 60 ? "text-blue-500" :
                    insights.healthScore >= 40 ? "text-yellow-500" : "text-red-500"
                  }`}>{insights.healthLabel}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-center gap-2 mb-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-500" />
                    <span className="text-xs font-medium text-muted-foreground">Retention</span>
                  </div>
                  <p className="text-2xl font-bold">{insights.retentionRate}%</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {insights.recentJoins} joined last 30d
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Swords className="h-4 w-4 text-blue-500" />
                    <span className="text-xs font-medium text-muted-foreground">Avg Battles/Week</span>
                  </div>
                  <p className="text-2xl font-bold">{insights.avgBattlesPerMember}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {insights.totalWeeklyBattles.toLocaleString()} total this week
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Clock className="h-4 w-4 text-purple-500" />
                    <span className="text-xs font-medium text-muted-foreground">Peak Activity</span>
                  </div>
                  <p className="text-2xl font-bold">{insights.peakHour || "---"}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {insights.weeklyActivityRate}% active this week
                  </p>
                </CardContent>
              </Card>
            </div>
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
