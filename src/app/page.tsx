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

export default function DashboardPage() {
  const { clubTag, apiKey, isLoadingSettings, hasLoadedSettings, loadSettingsFromDB } = useAppStore();
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<ClubEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);

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
      const [membersRes, eventsRes] = await Promise.all([
        fetch("/api/members"),
        fetch("/api/events"),
      ]);

      if (membersRes.ok) {
        const data = await membersRes.json();
        setMembers(data.members || []);
      }

      if (eventsRes.ok) {
        const data = await eventsRes.json();
        setEvents(data.events || []);
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
