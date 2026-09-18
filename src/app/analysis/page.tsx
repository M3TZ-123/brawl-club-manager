"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { LocalDate, useI18n } from "@/components/locale-provider";
import { TimeRangePicker } from "@/components/time-range-picker";
import { useFeatureResource } from "@/components/use-feature-resource";
import { AnalysisTeammates } from "@/components/analysis-teammates";
import { AnalysisPlayingHours } from "@/components/analysis-playing-hours";
import { Button } from "@/components/ui/button";
import { useDeviceTimeZone } from "@/hooks/use-device-time-zone";
import { battleContextOptions, getBattleModeInfo, normalizeBattleMode } from "@/lib/battle-catalog";
import type { AnalysisResponse } from "@/lib/club-analysis-types";
import { parseTimeRange, type TimeRangeKey } from "@/lib/time-range";

export function AnalysisCoverage({ data }: { data: AnalysisResponse }) {
  const { t } = useI18n();
  const coverage = data.coverage;
  const truncated = data.limits.truncated || coverage.truncated;
  const incomplete = coverage.currentPlayers > coverage.fullPeriodMonitoredPlayers;
  const limited = truncated || incomplete || coverage.status !== "observed" || coverage.affectedPlayers > 0 || coverage.stalePlayers > 0;
  return <section className={`rounded-lg border p-3 text-sm ${limited ? "border-amber-500/40 bg-amber-500/5" : ""}`} aria-label={t("Battle history coverage")}>
    <p className="font-medium">{t(truncated ? "Partial results — choose a shorter period." : limited ? "Incomplete battle history" : "Recorded battle history")}</p>
    {incomplete && <p className="mt-1 text-xs text-muted-foreground">{t("{monitored}/{total} members tracked throughout this period", { monitored: coverage.fullPeriodMonitoredPlayers, total: coverage.currentPlayers })}</p>}
    {(coverage.affectedPlayers > 0 || coverage.stalePlayers > 0) && <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      {coverage.affectedPlayers > 0 && <span>{t("Members with possible gaps: {count}", { count: coverage.affectedPlayers })}</span>}
      {coverage.stalePlayers > 0 && <span>{t("Members with delayed updates: {count}", { count: coverage.stalePlayers })}</span>}
    </div>}
    <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("About these records")}</summary><div className="mt-2 space-y-2">
      <p>{t("Current members' saved battles only. Some records may predate a member joining the club.")}</p>
      <p>{t("Based on recorded battles; some matches may be missing.")}</p>
      <p>{t("A missing record does not mean a member did not play. Use the Mega Pig archive for saved event contributions.")}</p>
      <p>{t("One record per club player in a battle; teammates count separately.")}</p>
      <p>{t("Win rates use wins and losses only; draws and unknown results are excluded.")}</p>
      <p>{t("Earliest saved battle")}: <LocalDate value={coverage.earliestBattleAt} time /> · {t("Latest saved battle")}: <LocalDate value={coverage.latestBattleAt} time /></p>
    </div></details>
  </section>;
}

export function AnalysisContent() {
  const { t, number } = useI18n();
  const query = useSearchParams();
  const deviceTimeZone = useDeviceTimeZone();
  const [range, setRange] = useState<TimeRangeKey>(() => parseTimeRange(query.get("range")));
  const [view, setView] = useState<"teammates" | "hours">(() => query.get("view") === "hours" ? "hours" : "teammates");
  const [zoneMode, setZoneMode] = useState<"local" | "utc">("local");
  const [context, setContext] = useState(() => battleContextOptions.some(item => item.key === query.get("context")) ? query.get("context")! : "");
  const [mode, setMode] = useState(() => query.get("mode") ? normalizeBattleMode(query.get("mode")) : "");
  const [map, setMap] = useState(() => query.get("map") || "");
  const [brawler, setBrawler] = useState(() => query.get("brawler") || "");
  const params = new URLSearchParams({ range, view });
  if (view === "hours") params.set("timezone", zoneMode === "utc" ? "UTC" : deviceTimeZone);
  for (const [key, value] of Object.entries({ context, mode, map, brawler })) if (value) params.set(key, value);
  const { data, loading, error, reload } = useFeatureResource<AnalysisResponse>(`/api/analysis?${params}`, "roster,battles");
  const clearFilters = () => { setContext(""); setMode(""); setMap(""); setBrawler(""); };

  return <div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <h1 className="text-2xl font-bold">{t("Teammates and playing hours")}</h1>
      <Button variant="outline" size="sm" onClick={reload} disabled={loading}>{t("Refresh")}</Button>
    </header>
    <div className="flex flex-wrap items-end justify-between gap-3">
      <TimeRangePicker value={range} onChange={setRange} />
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">{t("Battle type / event")}
        <select id="analysis-context" value={context} onChange={event => setContext(event.target.value)} className="h-9 max-w-full rounded-md border bg-background px-3 text-sm text-foreground">
          <option value="">{t("All battle types")}</option>
          {battleContextOptions.map(item => <option key={item.key} value={item.key}>{t(item.label)}</option>)}
        </select>
      </label>
    </div>
    {(context || mode || map || brawler) && <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">{t("Selected battles")}:</span>
      {[context && t(battleContextOptions.find(item => item.key === context)?.label || "Unclassified"), mode && t(getBattleModeInfo(mode).label), map, brawler].filter(Boolean).map((label, index) => <span key={index} className="max-w-full break-words rounded border px-2 py-1"><bdi>{label}</bdi></span>)}
      <Button size="sm" variant="ghost" onClick={clearFilters}>{t("Clear filters")}</Button>
    </div>}
    <div className="flex flex-wrap gap-2" role="group" aria-label={t("Analysis view")}>
      <Button size="sm" variant={view === "teammates" ? "default" : "outline"} aria-pressed={view === "teammates"} onClick={() => setView("teammates")}>{t("Teammates")}</Button>
      <Button size="sm" variant={view === "hours" ? "default" : "outline"} aria-pressed={view === "hours"} onClick={() => setView("hours")}>{t("Playing hours")}</Button>
    </div>
    {view === "hours" && <label className="flex flex-wrap items-center gap-2 text-sm">{t("Time zone")}
      <select id="analysis-time-zone" value={zoneMode} onChange={event => setZoneMode(event.target.value === "utc" ? "utc" : "local")} className="h-9 max-w-full rounded-md border bg-background px-3">
        <option value="local">{t("Your time zone")} · {deviceTimeZone}</option><option value="utc">UTC</option>
      </select>
    </label>}
    {loading && !data && <p role="status" className="py-8 text-center text-muted-foreground">{t("Loading battle analysis…")}</p>}
    {error && <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm">{t("Battle analysis could not be loaded.")} {data && t("The figures below are from the last successful load.")} <Button variant="outline" size="sm" onClick={reload}>{t("Retry")}</Button></div>}
    {data && <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><p><LocalDate value={data.period.start} /> — <LocalDate value={data.period.end} /></p><p>{t("{count} recorded member participations", { count: number(data.summary.observations) })}</p></div>
      <AnalysisCoverage data={data} />
      {view === "teammates" ? <AnalysisTeammates data={data} /> : <AnalysisPlayingHours data={data} />}
    </>}
  </div>;
}

export default function AnalysisPage() {
  return <LayoutWrapper><Suspense fallback={<AnalysisLoading />}><AnalysisContent /></Suspense></LayoutWrapper>;
}
function AnalysisLoading() { const { t } = useI18n(); return <p role="status">{t("Loading battle analysis…")}</p>; }
