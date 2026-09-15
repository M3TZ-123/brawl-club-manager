"use client";
import { T, useI18n } from "@/components/locale-provider";


import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DataConfidenceNotice } from "@/components/sync-health";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fetchJsonCached, invalidateJsonCache } from "@/lib/client-data-cache";

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
    weeklyWins: number;
    weeklyBattles: number;
    weeklyWinRate: number;
  };
  topGainers: { playerTag: string; playerName: string; trophyChange: number }[];
  topLosers: { playerTag: string; playerName: string; trophyChange: number }[];
  topLosersMode?: "losses" | "lowest_progress";
  activityDistribution: { active: number; minimal: number; inactive: number };
  recentEvents: { event_type: string; player_name: string; event_time: string }[];
  trophyTrend: { date: string; trophies: number }[];
}

function escapeHtml(value: unknown) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}



function ReportChartSkeleton() {
  return (
    <Card>
      <CardContent className="h-[320px] animate-pulse p-6">
        <div className="h-5 w-32 rounded bg-muted" />
        <div className="mt-6 h-56 rounded bg-muted/60" />
      </CardContent>
    </Card>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Card key={index}>
            <CardContent className="h-28 animate-pulse p-6">
              <div className="h-4 w-24 rounded bg-muted" />
              <div className="mt-5 h-7 w-20 rounded bg-muted/70" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <ReportChartSkeleton />
        <ReportChartSkeleton />
      </div>
    </div>
  );
}

const TrophyChart = dynamic(
  () => import("@/components/charts").then((mod) => mod.TrophyChart),
  { ssr: false, loading: () => <ReportChartSkeleton /> }
);

const ActivityPieChart = dynamic(
  () => import("@/components/charts").then((mod) => mod.ActivityPieChart),
  { ssr: false, loading: () => <ReportChartSkeleton /> }
);

export default function ReportsPage() {
  const { t, locale, direction } = useI18n();
  const { date: formatDate, reportDate: formatReportDate, number: formatNumber } = useI18n();
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadReport = useCallback(async (force = false) => {
    if (force) {
      setIsRefreshing(true);
      invalidateJsonCache("/api/reports/weekly");
    } else {
      setIsLoading(true);
    }
    try {
      const data = await fetchJsonCached<WeeklyReport>("/api/reports/weekly", {
        staleMs: 60_000,
        force,
      });
      setReport(data);
    } catch (error) {
      console.error("Error loading report:", error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  useEffect(() => {
    const handleClubDataUpdated = () => {
      loadReport(true);
    };
    window.addEventListener("club-data-updated", handleClubDataUpdated);
    return () => window.removeEventListener("club-data-updated", handleClubDataUpdated);
  }, [loadReport]);

  const handleExportReport = () => {
    // For simplicity, we'll export as text/html that can be printed to PDF
    if (!report) return;
    const generatedAt = escapeHtml(formatDate(report.generatedAt));
    const periodStart = escapeHtml(formatReportDate(report.period.start));
    const periodEnd = escapeHtml(formatReportDate(report.period.end));

    const content = `
      <html lang="${locale}" dir="${direction}">
        <head>
          <title>${escapeHtml(t("Club Weekly Report"))} - ${generatedAt}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            h1 { color: #333; }
            .stat { margin: 10px 0; }
            table { border-collapse: collapse; width: 100%; margin: 20px 0; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: start; }
            th { background-color: #f4f4f4; }
          </style>
        </head>
        <body>
          <h1>${escapeHtml(t("Club Weekly Report"))}</h1>
          <p>${escapeHtml(t("Generated"))}: ${generatedAt}</p>
          <p>${escapeHtml(t("Period"))}: ${periodStart} - ${periodEnd} (UTC)</p>
          <p>${escapeHtml(t("Reports use UTC day boundaries. Other times use your device timezone."))}</p>
          
          <h2>${escapeHtml(t("Summary"))}</h2>
          <div class="stat">${escapeHtml(t("Total Members"))}: ${report.summary.totalMembers}</div>
          <div class="stat">${escapeHtml(t("Total Trophies"))}: ${formatNumber(report.summary.totalTrophies)}</div>
          <div class="stat">${escapeHtml(t("Average Trophies"))}: ${formatNumber(report.summary.avgTrophies)}</div>
          <div class="stat">${escapeHtml(t("Active Members"))}: ${report.summary.activeMembers} (${report.summary.activityRate}%)</div>
          
          <h2>${escapeHtml(t("Top Trophy Gainers"))}</h2>
          <table>
            <tr><th>${escapeHtml(t("Player"))}</th><th>${escapeHtml(t("Change"))}</th></tr>
            ${report.topGainers.map((p) => `<tr><td>${escapeHtml(p.playerName)}</td><td>+${escapeHtml(formatNumber(p.trophyChange))}</td></tr>`).join("")}
          </table>
          
          <h2>${escapeHtml(t("Most Trophy Lost"))}</h2>
          <table>
            <tr><th>${escapeHtml(t("Player"))}</th><th>${escapeHtml(t("Change"))}</th></tr>
            ${report.topLosers.map((p) => `<tr><td>${escapeHtml(p.playerName)}</td><td>${escapeHtml(formatNumber(p.trophyChange))}</td></tr>`).join("")}
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

  const activityData = useMemo(
    () => report
      ? [
        { name: "Active", value: report.activityDistribution.active, color: "#22c55e" },
        { name: "Low activity", value: report.activityDistribution.minimal, color: "#eab308" },
        { name: "Inactive", value: report.activityDistribution.inactive, color: "#ef4444" },
      ]
      : [],
    [report]
  );

  return (
    <LayoutWrapper><DataConfidenceNotice />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold"><T text="Weekly Report" /></h1><p className="text-xs text-muted-foreground">{t("Reports use UTC day boundaries. Other times use your device timezone.")}</p>
          {report && (
            <p className="text-muted-foreground">
              {formatReportDate(report.period.start)} - {formatReportDate(report.period.end)} <T text=" (UTC) " /></p>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => loadReport(true)}
                size="sm"
                className="sm:size-default"
                disabled={isRefreshing}
              >
                <RefreshCw className={`h-4 w-4 sm:mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
                <span className="hidden sm:inline">{isRefreshing ? <T text="Refreshing..." /> : <T text="Refresh" />}</span>
              </Button>
              <Button onClick={handleExportReport} size="sm" className="sm:size-default">
                <Download className="h-4 w-4 sm:me-2" />
                <span className="hidden sm:inline"><T text="Export" /></span>
              </Button>
            </div>
          </div>

          {isLoading ? (
            <ReportSkeleton />
          ) : report && (
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium"><T text="Total Members" /></CardTitle>
                    <Users className="h-4 w-4 text-blue-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{report.summary.totalMembers}</div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium"><T text="Total Trophies" /></CardTitle>
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
                    <CardTitle className="text-sm font-medium"><T text="Weekly Win Rate" /></CardTitle>
                    <TrendingUp className="h-4 w-4 text-green-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{report.summary.weeklyWinRate}%</div>
                    <p className="text-xs text-muted-foreground">
                      {formatNumber(report.summary.weeklyWins)}<T text="W / " />{formatNumber(report.summary.weeklyBattles)} <T text=" battles " /></p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium"><T text="Activity Rate" /></CardTitle>
                    <Users className="h-4 w-4 text-green-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{report.summary.activityRate}%</div>
                    <p className="text-xs text-muted-foreground">
                      {report.summary.activeMembers} <T text=" active in the last 24 hours " /></p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium"><T text="Avg Trophies" /></CardTitle>
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
                      <T text=" Top Trophy Gainers " /></CardTitle>
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
                          <T text=" No trophy gains this week " /></p>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <TrendingDown className="h-5 w-5 text-red-500" />
                      {report.topLosersMode === "lowest_progress"
                        ? <T text="Lowest Trophy Progress" />
                        : <T text="Worst Trophy Drops" />}
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
                          <span className={`font-bold ${player.trophyChange < 0 ? "text-red-500" : "text-yellow-400"}`}>
                            {player.trophyChange > 0 ? <T text="+{value0}" values={{ value0: String(formatNumber(player.trophyChange)) }} /> : formatNumber(player.trophyChange)}
                          </span>
                        </div>
                      ))}
                      {report.topLosers.length === 0 && (
                        <p className="text-muted-foreground text-center py-4">
                          <T text=" No trophy data available this week " /></p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Recent Events */}
              <Card>
                <CardHeader>
                  <CardTitle><T text="Members Joined & Left" /></CardTitle>
                  <CardDescription><T text="Roster changes this week" /></CardDescription>
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
                          {event.event_type === "join" ? <T text="Joined" /> : <T text="Left" />} •{" "}
                          {formatDate(event.event_time)}
                        </div>
                      </div>
                    ))}
                    {report.recentEvents.length === 0 && (
                      <p className="text-muted-foreground text-center py-4">
                        <T text=" No events this week " /></p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
    </LayoutWrapper>
  );
}
