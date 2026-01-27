"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TrophyChart, ActivityPieChart, MemberBarChart } from "@/components/charts";
import { formatNumber, formatDate } from "@/lib/utils";
import { Download, RefreshCw, TrendingUp, TrendingDown, Users, Trophy } from "lucide-react";

interface WeeklyReport {
  generatedAt: string;
  period: {
    start: string;
    end: string;
  };
  summary: {
    totalMembers: number;
    totalTrophies: number;
    avgTrophies: number;
    activeMembers: number;
    activityRate: number;
  };
  topGainers: { playerTag: string; playerName: string; trophyChange: number }[];
  topLosers: { playerTag: string; playerName: string; trophyChange: number }[];
  activityDistribution: { active: number; minimal: number; inactive: number };
  recentEvents: { event_type: string; player_name: string; event_time: string }[];
  trophyTrend: { date: string; trophies: number }[];
}

export default function ReportsPage() {
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadReport();
  }, []);

  const loadReport = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/reports/weekly");
      if (response.ok) {
        const data = await response.json();
        setReport(data);
      }
    } catch (error) {
      console.error("Error loading report:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExportPDF = () => {
    // For simplicity, we'll export as text/html that can be printed to PDF
    if (!report) return;

    const content = `
      <html>
        <head>
          <title>Club Weekly Report - ${formatDate(report.generatedAt)}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            h1 { color: #333; }
            .stat { margin: 10px 0; }
            table { border-collapse: collapse; width: 100%; margin: 20px 0; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #f4f4f4; }
          </style>
        </head>
        <body>
          <h1>Club Weekly Report</h1>
          <p>Generated: ${formatDate(report.generatedAt)}</p>
          <p>Period: ${formatDate(report.period.start)} - ${formatDate(report.period.end)}</p>
          
          <h2>Summary</h2>
          <div class="stat">Total Members: ${report.summary.totalMembers}</div>
          <div class="stat">Total Trophies: ${formatNumber(report.summary.totalTrophies)}</div>
          <div class="stat">Average Trophies: ${formatNumber(report.summary.avgTrophies)}</div>
          <div class="stat">Active Members: ${report.summary.activeMembers} (${report.summary.activityRate}%)</div>
          
          <h2>Top Trophy Gainers</h2>
          <table>
            <tr><th>Player</th><th>Change</th></tr>
            ${report.topGainers.map(p => `<tr><td>${p.playerName}</td><td>+${p.trophyChange}</td></tr>`).join('')}
          </table>
          
          <h2>Most Trophy Lost</h2>
          <table>
            <tr><th>Player</th><th>Change</th></tr>
            ${report.topLosers.map(p => `<tr><td>${p.playerName}</td><td>${p.trophyChange}</td></tr>`).join('')}
          </table>
        </body>
      </html>
    `;

    const blob = new Blob([content], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `club-report-${new Date().toISOString().split("T")[0]}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="flex h-screen bg-background">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <Header />
          <main className="flex-1 flex items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
          </main>
        </div>
      </div>
    );
  }

  const activityData = report
    ? [
        { name: "Active", value: report.activityDistribution.active || 1, color: "#22c55e" },
        { name: "Inactive", value: report.activityDistribution.inactive || 1, color: "#ef4444" },
      ]
    : [];

  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold">Weekly Report</h1>
              {report && (
                <p className="text-muted-foreground">
                  {formatDate(report.period.start)} - {formatDate(report.period.end)}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={loadReport}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <Button onClick={handleExportPDF}>
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </div>
          </div>

          {report && (
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Total Members</CardTitle>
                    <Users className="h-4 w-4 text-blue-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{report.summary.totalMembers}</div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Total Trophies</CardTitle>
                    <Trophy className="h-4 w-4 text-yellow-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {formatNumber(report.summary.totalTrophies)}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Activity Rate</CardTitle>
                    <TrendingUp className="h-4 w-4 text-green-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{report.summary.activityRate}%</div>
                    <p className="text-xs text-muted-foreground">
                      {report.summary.activeMembers} active members
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Avg Trophies</CardTitle>
                    <Trophy className="h-4 w-4 text-purple-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {formatNumber(report.summary.avgTrophies)}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Charts */}
              <div className="grid gap-6 md:grid-cols-2">
                <ActivityPieChart data={activityData} />
                {report.trophyTrend.length > 0 && (
                  <TrophyChart data={report.trophyTrend} />
                )}
              </div>

              {/* Top Gainers & Losers */}
              <div className="grid gap-6 md:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <TrendingUp className="h-5 w-5 text-green-500" />
                      Top Trophy Gainers
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {report.topGainers.map((player, index) => (
                        <div
                          key={player.playerTag}
                          className="flex items-center justify-between p-3 rounded-lg bg-green-500/10"
                        >
                          <div className="flex items-center gap-3">
                            <span className="font-bold text-lg">{index + 1}</span>
                            <div>
                              <p className="font-medium">{player.playerName}</p>
                              <p className="text-xs text-muted-foreground">
                                {player.playerTag}
                              </p>
                            </div>
                          </div>
                          <span className="font-bold text-green-500">
                            +{formatNumber(player.trophyChange)}
                          </span>
                        </div>
                      ))}
                      {report.topGainers.length === 0 && (
                        <p className="text-muted-foreground text-center py-4">
                          No data available
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <TrendingDown className="h-5 w-5 text-red-500" />
                      Most Trophies Lost
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {report.topLosers.map((player, index) => (
                        <div
                          key={player.playerTag}
                          className="flex items-center justify-between p-3 rounded-lg bg-red-500/10"
                        >
                          <div className="flex items-center gap-3">
                            <span className="font-bold text-lg">{index + 1}</span>
                            <div>
                              <p className="font-medium">{player.playerName}</p>
                              <p className="text-xs text-muted-foreground">
                                {player.playerTag}
                              </p>
                            </div>
                          </div>
                          <span className="font-bold text-red-500">
                            {formatNumber(player.trophyChange)}
                          </span>
                        </div>
                      ))}
                      {report.topLosers.length === 0 && (
                        <p className="text-muted-foreground text-center py-4">
                          No data available
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Recent Events */}
              <Card>
                <CardHeader>
                  <CardTitle>Recent Club Events</CardTitle>
                  <CardDescription>Join/leave activity this week</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {report.recentEvents.map((event, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className={
                              event.event_type === "join" ? "text-green-500" : "text-red-500"
                            }
                          >
                            {event.event_type === "join" ? "➡️" : "⬅️"}
                          </span>
                          <span className="font-medium">{event.player_name}</span>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {event.event_type === "join" ? "Joined" : "Left"} •{" "}
                          {formatDate(event.event_time)}
                        </div>
                      </div>
                    ))}
                    {report.recentEvents.length === 0 && (
                      <p className="text-muted-foreground text-center py-4">
                        No events this week
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
