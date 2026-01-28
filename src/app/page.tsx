"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";
import { SetupWizard } from "@/components/setup-wizard";
import { StatsCards } from "@/components/stats-cards";
import { MembersTable } from "@/components/members-table";
import { ActivityTimeline } from "@/components/activity-timeline";
import { ActivityPieChart, MemberBarChart } from "@/components/charts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Member, ClubEvent } from "@/types/database";

export default function DashboardPage() {
  const { clubTag, apiKey, isLoadingSettings, loadSettingsFromDB } = useAppStore();
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<ClubEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Load settings from database on mount
    loadSettingsFromDB();
  }, []);

  useEffect(() => {
    if (!mounted || isLoadingSettings) return;
    
    if (clubTag && apiKey) {
      setIsSetupComplete(true);
      loadData();
    } else {
      setIsLoading(false);
    }
  }, [clubTag, apiKey, mounted, isLoadingSettings]);

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
    { name: "Active", value: activeMembers || 1, color: "#22c55e" },
    { name: "Inactive", value: Math.max(members.length - activeMembers, 0) || 1, color: "#ef4444" },
  ];

  const topMembers = members.slice(0, 10).map((m) => ({
    name: m.player_name,
    trophies: m.trophies,
  }));

  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
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
                    <CardHeader>
                      <CardTitle>Club Members</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <MembersTable members={members.slice(0, 10)} />
                    </CardContent>
                  </Card>
                </div>
                <div>
                  <ActivityTimeline events={events.slice(0, 5)} />
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
