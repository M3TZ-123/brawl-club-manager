"use client";
import { T, useI18n } from "@/components/locale-provider";


import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TimeRangePicker } from "@/components/time-range-picker";
import { parseTimeRange, TIME_RANGES, type TimeRangeKey } from "@/lib/time-range";
import { DataConfidenceNotice } from "@/components/sync-health";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fetchJsonCached, invalidateJsonCache } from "@/lib/client-data-cache";
import { clubEventLabel } from "@/lib/club-event-display";
import { ClubReportCard } from "@/components/club-report-card";
import { ClubGrowth } from "@/components/club-growth";
import type { ClubTrophyChange } from "@/lib/club-trophy-change";

import { Download, RefreshCw, TrendingUp, TrendingDown, Users, Trophy } from "lucide-react";

interface WeeklyReport {
  generatedAt: string;
  trophyChange?: ClubTrophyChange | null;
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
    trophyProgressKnownMembers?: number;
  };
  topGainers: { playerTag: string; playerName: string; trophyChange: number }[];
  topLosers: { playerTag: string; playerName: string; trophyChange: number }[];
  topLosersMode?: "losses" | "lowest_progress";
  activityDistribution: { active: number; minimal: number; inactive: number };
  recentEvents: { event_type: string; player_name: string; event_time: string }[];
  trophyTrend: { date: string; trophies: number | null }[];
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index}>
            <CardContent className="h-28 animate-pulse p-6">
              <div className="h-4 w-24 rounded bg-muted" />
              <div className="mt-5 h-7 w-20 rounded bg-muted/70" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

const PeriodTrophyChart = dynamic(
  () => import("@/components/period-trophy-chart").then((mod) => mod.PeriodTrophyChart),
  { ssr: false, loading: () => <ReportChartSkeleton /> }
);

const ActivityPieChart = dynamic(
  () => import("@/components/charts").then((mod) => mod.ActivityPieChart),
  { ssr: false, loading: () => <ReportChartSkeleton /> }
);

export default function ReportsPage() {
  const { t, locale, direction } = useI18n();
  const { date: formatDate, reportDate: formatReportDate, number: formatNumber } = useI18n();
  const [snapshot, setSnapshot] = useState<{ range: TimeRangeKey; report: WeeklyReport } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedRange, setSelectedRange] = useState<TimeRangeKey>("7d");
  const [initialRangeReady, setInitialRangeReady] = useState(false);
  const [showCharts, setShowCharts] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const loadSequence = useRef(0);
  const report = snapshot?.range === selectedRange ? snapshot.report : null;

  useEffect(() => {
    setSelectedRange(parseTimeRange(new URLSearchParams(window.location?.search || "").get("range")));
    setInitialRangeReady(true);
  }, []);

  const loadReport = useCallback(async (force = false) => {
    const sequence = ++loadSequence.current;
    setLoadError(false);
    if (force) {
      setIsRefreshing(true);
      invalidateJsonCache("/api/reports/weekly");
    } else {
      setIsLoading(true);
    }
    try {
      const data = await fetchJsonCached<WeeklyReport>(`/api/reports/weekly?range=${selectedRange}`, {
        staleMs: 60_000,
        force,
      });
      if (sequence !== loadSequence.current) return;
      setSnapshot({ range: selectedRange, report: data });
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setLoadError(true);
      setSnapshot(null);
      console.error("Error loading report:", error);
    } finally {
      if (sequence === loadSequence.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [selectedRange]);

  useEffect(() => {
    if (!initialRangeReady) return;
    const requests = loadSequence;
    void loadReport();
    return () => { requests.current++; };
  }, [loadReport, initialRangeReady]);

  useEffect(() => {
    const handleClubDataUpdated = (event: Event) => {
      if ((event as CustomEvent<{ clubChanged?: boolean }>).detail?.clubChanged) {
        setSnapshot(null);
        setIsLoading(true);
      }
      if (initialRangeReady) void loadReport(true);
    };
    window.addEventListener("club-data-updated", handleClubDataUpdated);
    return () => window.removeEventListener("club-data-updated", handleClubDataUpdated);
  }, [loadReport, initialRangeReady]);

  const handleExportReport = () => {
    // For simplicity, we'll export as text/html that can be printed to PDF
    if (!report) return;
    const generatedAt = escapeHtml(formatDate(report.generatedAt));
    const periodStart = escapeHtml(formatReportDate(report.period.start));
    const periodEnd = escapeHtml(formatReportDate(report.period.end));

    const content = `
      <html lang="${locale}" dir="${direction}">
        <head>
          <title>${escapeHtml(t("Club Report"))} - ${generatedAt}</title>
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
          <h1>${escapeHtml(t("Club Report"))}</h1>
          <p>${escapeHtml(t("Generated"))}: ${generatedAt}</p>
          <p>${escapeHtml(t("Period"))}: ${periodStart} - ${periodEnd} (UTC)</p>
          
          <h2>${escapeHtml(t("Summary"))}</h2>
          <div class="stat">${escapeHtml(t("Total Members"))}: ${report.summary.totalMembers}</div>
          <div class="stat">${escapeHtml(t("Total Trophies"))}: ${formatNumber(report.summary.totalTrophies)}</div>
          <div class="stat">${escapeHtml(t("Average Trophies"))}: ${formatNumber(report.summary.avgTrophies)}</div>
          <div class="stat">${escapeHtml(t("Active Members"))}: ${report.summary.activeMembers} (${report.summary.activityRate}%)</div>
          
          <h2>${escapeHtml(t("Top Trophy Gainers"))}</h2>
          <p>${escapeHtml(t("Account trophy change"))} · ${escapeHtml(t(TIME_RANGES[selectedRange].label))}</p>
          <table>
            <tr><th>${escapeHtml(t("Player"))}</th><th>${escapeHtml(t("Change"))}</th></tr>
            ${report.topGainers.map((p) => `<tr><td>${escapeHtml(p.playerName)}</td><td>+${escapeHtml(formatNumber(p.trophyChange))}</td></tr>`).join("")}
          </table>
          
          <h2>${escapeHtml(t(report.topLosersMode === "lowest_progress" ? "Lowest Trophy Progress" : "Worst Trophy Drops"))}</h2>
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
    a.download = `club-report-${selectedRange}-${new Date().toISOString().split("T")[0]}.html`;
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
          <h1 className="text-2xl font-bold"><T text="Club Report" /></h1>
          {report && !isLoading && !loadError && (
            <p className="text-muted-foreground">
              {formatReportDate(report.period.start)} - {formatReportDate(report.period.end)} <T text=" (UTC) " />
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
              {report && !isLoading && !loadError && <ClubReportCard report={report} />}
              <Button
                aria-label={t("Refresh")}
                variant="outline"
                onClick={() => loadReport(true)}
                size="sm"
                className="sm:size-default"
                disabled={isRefreshing || !initialRangeReady}
              >
                <RefreshCw className={`h-4 w-4 sm:mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
                <span className="hidden sm:inline">{isRefreshing ? <T text="Refreshing..." /> : <T text="Refresh" />}</span>
              </Button>
              <Button onClick={handleExportReport} disabled={!report || isLoading || loadError} aria-label={t("Export")} size="sm" className="sm:size-default">
                <Download className="h-4 w-4 sm:me-2" />
                <span className="hidden sm:inline"><T text="Export" /></span>
              </Button>
        </div>
      </div>

          <div className="mb-5"><TimeRangePicker value={selectedRange} onChange={range => { if (range !== selectedRange) { setIsLoading(true); setSelectedRange(range); } }} dayBased /></div>

          {isLoading ? (
            <ReportSkeleton />
          ) : loadError ? (
            <Card><CardContent className="py-10 text-center"><p role="alert"><T text="Could not load the report." /></p><Button variant="outline" className="mt-3" onClick={() => loadReport(true)}><T text="Retry" /></Button></CardContent></Card>
          ) : report && (
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
                    <CardTitle className="text-sm font-medium"><T text="Current Members" /></CardTitle>
                    <Users className="h-4 w-4 text-blue-500" />
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-xl font-bold sm:text-2xl">{report.summary.totalMembers}</div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
                    <CardTitle className="text-sm font-medium"><T text="Total Trophies" /></CardTitle>
                    <Trophy className="h-4 w-4 text-yellow-500" />
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-xl font-bold sm:text-2xl">
                      {formatNumber(report.summary.totalTrophies)}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
                    <CardTitle className="text-sm font-medium"><T text="Win Rate" /></CardTitle>
                    <TrendingUp className="h-4 w-4 text-green-500" />
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-xl font-bold sm:text-2xl">{report.summary.weeklyBattles > 0 ? `${report.summary.weeklyWinRate}%` : "—"}</div>
                    <p className="text-xs text-muted-foreground">
                      {t("{wins} wins from {battles} recorded battles", { wins: formatNumber(report.summary.weeklyWins), battles: formatNumber(report.summary.weeklyBattles) })}</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
                    <CardTitle className="text-sm font-medium"><T text="Recorded battles" /></CardTitle>
                    <Users className="h-4 w-4 text-green-500" />
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <div className="text-xl font-bold sm:text-2xl">{formatNumber(report.summary.weeklyBattles)}</div>
                  </CardContent>
                </Card>

              </div>

              {/* Top Gainers & Losers */}
              <p className="text-sm font-medium">{t("Account trophy change")} · {t(TIME_RANGES[selectedRange].label)}</p>
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
                          <T text={report.summary.trophyProgressKnownMembers === 0 && report.summary.totalMembers > 0 ? "Not enough history to compare trophies for this period." : "No trophy gains recorded in this period."} /></p>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      {report.topLosersMode === "lowest_progress"
                        ? <Trophy className="h-5 w-5 text-muted-foreground" />
                        : <TrendingDown className="h-5 w-5 text-red-500" />}
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
                          className={`flex items-center justify-between p-3 rounded-lg ${player.trophyChange < 0 ? "bg-red-500/10" : "bg-muted/40"}`}
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
                          <span className={`font-bold ${player.trophyChange < 0 ? "text-red-500" : player.trophyChange > 0 ? "text-green-500" : "text-muted-foreground"}`}>
                            {player.trophyChange > 0 ? <T text="+{value0}" values={{ value0: String(formatNumber(player.trophyChange)) }} /> : formatNumber(player.trophyChange)}
                          </span>
                        </div>
                      ))}
                      {report.topLosers.length === 0 && (
                        <p className="text-muted-foreground text-center py-4">
                          <T text="Not enough history to compare trophies for this period." /></p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>

              <ClubGrowth data={report.trophyChange ?? null} onRetry={() => { void loadReport(true); }} />

              {/* Recent Events */}
              <details className="rounded-lg border bg-card p-4" open={showCharts} onToggle={event => setShowCharts(event.currentTarget.open)}><summary className="cursor-pointer font-medium"><T text="Charts and current roster details" /></summary><div className="mt-4 space-y-4">
                <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-muted-foreground"><T text="Avg Trophies" /></dt><dd className="font-semibold">{formatNumber(report.summary.avgTrophies)}</dd></div><div><dt className="text-muted-foreground"><T text="Current activity" /></dt><dd className="font-semibold">{report.summary.activityRate}%</dd><dd className="text-xs text-muted-foreground">{report.summary.activeMembers} <T text=" active in the last 24 hours " /></dd></div></dl>
                {showCharts && <div className="grid gap-4 md:grid-cols-2"><ActivityPieChart data={activityData} />{report.trophyTrend.length > 0 && <PeriodTrophyChart dayBased points={report.trophyTrend.map(point => ({ recordedAt: `${point.date}T00:00:00.000Z`, trophies: point.trophies }))} />}</div>}
              </div></details>
              <details className="rounded-lg border bg-card p-4"><summary className="cursor-pointer font-medium"><T text="Club changes" /></summary>
                  <div className="mt-3 space-y-2">
                    {report.recentEvents.map((event, index) => (
                      <div
                        key={index}
                        className="flex flex-col gap-2 p-3 rounded-lg bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span
                            aria-hidden="true"
                            className={
                              event.event_type === "join" ? "text-green-500" : event.event_type === "leave" ? "text-red-500" : "text-muted-foreground"
                            }
                          >
                            {event.event_type === "join" ? "+" : event.event_type === "leave" ? "−" : "•"}
                          </span>
                          <span className="truncate font-medium">{event.player_name}</span>
                        </div>
                        <div className="shrink-0 text-sm text-muted-foreground">
                          <T text={clubEventLabel(event.event_type)} /> •{" "}
                          {formatDate(event.event_time)}
                        </div>
                      </div>
                    ))}
                    {report.recentEvents.length === 0 && (
                      <p className="text-muted-foreground text-center py-4">
                        <T text="No events in this period." /></p>
                    )}
                  </div>
              </details>
            </div>
          )}
    </LayoutWrapper>
  );
}
