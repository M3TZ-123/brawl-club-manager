"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { LocalDate, useI18n } from "@/components/locale-provider";
import { TimeRangePicker } from "@/components/time-range-picker";
import { useFeatureResource } from "@/components/use-feature-resource";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { battleContextOptions, normalizeBattleMode } from "@/lib/battle-catalog";
import type { AnalysisResponse } from "@/lib/club-analysis-types";
import { parseTimeRange, type TimeRangeKey } from "@/lib/time-range";

const views = { maps: "Maps", modes: "Modes", brawlers: "Brawlers", pairs: "Teammates", hourly: "Hours (UTC)" } as const;

function AnalysisContent() {
  const { t, number } = useI18n();
  const query = useSearchParams();
  const [range, setRange] = useState<TimeRangeKey>(() => parseTimeRange(query.get("range")));
  const [context, setContext] = useState("");
  const [mode, setMode] = useState(() => query.get("mode") ? normalizeBattleMode(query.get("mode")) : "");
  const [map, setMap] = useState(() => query.get("map") || "");
  const [brawler, setBrawler] = useState("");
  const [view, setView] = useState<keyof typeof views>("maps");
  const params = new URLSearchParams({ range });
  for (const [key, value] of Object.entries({ context, mode, map, brawler })) if (value) params.set(key, value);
  const { data, loading, error, reload } = useFeatureResource<AnalysisResponse>(`/api/analysis?${params}`, "roster,battles");
  const rate = (value: number | null) => value == null ? t("Unknown") : `${number(Math.round(value * 10) / 10)}%`;
  const duration = (seconds: number) => {
    const rounded = Math.round(seconds);
    return t("{minutes} min {seconds} sec", { minutes: number(Math.floor(rounded / 60)), seconds: number(rounded % 60) });
  };
  const filters = [
    { id: "analysis-context", label: "Battle type / event", value: context, set: setContext, options: battleContextOptions.map(item => ({ ...item, count: data?.facets.contexts.find(facet => facet.key === item.key)?.count })) },
    { id: "analysis-mode", label: "Mode", value: mode, set: setMode, options: (data?.facets.modes || []).map(item => ({ ...item })) },
    { id: "analysis-map", label: "Map", value: map, set: setMap, options: (data?.facets.maps || []).map(item => ({ ...item, label: item.key })) },
    { id: "analysis-brawler", label: "Brawler", value: brawler, set: setBrawler, options: (data?.facets.brawlers || []).map(item => ({ ...item, label: item.key })) },
  ];
  const groups = data && (view === "maps" || view === "modes" || view === "brawlers") ? data[view] : [];
  const maxHour = Math.max(1, ...(data?.hourly.map(hour => hour.observations) || []));

  return <div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-bold">{t("Battle analysis")}</h1><p className="mt-1 text-sm text-muted-foreground">{t("Find useful patterns in the club's recorded battles.")}</p></div><Button variant="outline" onClick={reload} disabled={loading}>{t("Refresh")}</Button></header>
    <TimeRangePicker value={range} onChange={setRange} />
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{filters.map(filter => <div key={filter.id} className="min-w-0"><label htmlFor={filter.id} className="mb-1 block text-sm">{t(filter.label)}</label><select id={filter.id} value={filter.value} onChange={event => filter.set(event.target.value)} className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm">
      <option value="">{t("All")}</option>
      {filter.value && !filter.options.some(item => item.key === filter.value) && <option value={filter.value}>{t(filter.value)}</option>}
      {filter.options.map(item => <option key={item.key} value={item.key}>{t(item.label)}{item.count != null ? ` (${number(item.count)})` : ""}</option>)}
    </select></div>)}</div>
    {(context || mode || map || brawler) && <Button variant="ghost" size="sm" onClick={() => { setContext(""); setMode(""); setMap(""); setBrawler(""); }}>{t("Clear filters")}</Button>}
    {loading && !data && <p role="status" className="py-8 text-center text-muted-foreground">{t("Loading battle analysis…")}</p>}
    {error && <div role="alert" className="rounded-lg border p-4 text-sm">{t("Battle analysis could not be loaded.")} <Button variant="outline" size="sm" onClick={reload}>{t("Retry")}</Button></div>}
    {data && <>
      <p className="text-xs text-muted-foreground">{t("Rolling period")}: <LocalDate value={data.period.start} time /> — <LocalDate value={data.period.end} time /></p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">{t("Member participations")}</p><p className="mt-1 text-2xl font-bold">{number(data.summary.observations)}</p><p className="mt-1 text-xs text-muted-foreground">{t("One record per club player in a battle; teammates count separately.")}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">{t("Decided-result win rate")}</p><p className="mt-1 text-2xl font-bold">{rate(data.summary.winRate)}</p><p className="mt-1 text-xs text-muted-foreground">{t("{wins} wins · {losses} losses", { wins: data.summary.wins, losses: data.summary.losses })}</p><p className="text-xs text-muted-foreground">{t("{draws} draws · {unknown} unknown results", { draws: data.summary.draws, unknown: data.summary.unknownResults })}</p></CardContent></Card>
        <Card className="col-span-2 lg:col-span-1"><CardContent className="p-4"><p className="text-xs text-muted-foreground">{t("Recorded match duration")}</p><p className="mt-1 text-xl font-bold">{data.summary.durationObservations ? duration(data.summary.recordedDurationSeconds) : t("Unknown")}</p><p className="mt-1 text-xs">{t("Average recorded duration")}: {data.summary.averageDurationSeconds == null ? t("Unknown") : duration(data.summary.averageDurationSeconds)}</p><p className="mt-1 text-xs text-muted-foreground">{t("Reported for {count} participations. This is not time online.", { count: data.summary.durationObservations })}</p></CardContent></Card>
      </div>
      <details className="rounded-lg border p-3 text-sm">
        <summary className="cursor-pointer font-medium">{t(data.coverage.status === "possible_gap" ? "Possible gaps in battle history" : data.coverage.status === "unknown" ? "Battle coverage is not yet established" : "Based on observed battle history")}</summary>
        <div className="mt-3 space-y-2 text-xs text-muted-foreground"><p>{t("Saved battle logs cannot guarantee a complete match history.")}</p><p>{t("{monitored} of {total} current players monitored for the full selected period.", { monitored: data.coverage.fullPeriodMonitoredPlayers, total: data.coverage.currentPlayers })}</p><p>{t("{stale} players have stale checks; {affected} players have possible gaps overlapping this period. Gap records are kept for {days} days.", { stale: data.coverage.stalePlayers, affected: data.coverage.affectedPlayers, days: data.coverage.retainedGapWindowDays })}</p><p>{t("Earliest saved battle")}: <LocalDate value={data.coverage.earliestBattleAt} time /></p><p>{t("Latest saved battle")}: <LocalDate value={data.coverage.latestBattleAt} time /></p>{(data.limits.truncated || data.coverage.truncated) && <p className="text-amber-600 dark:text-amber-400">{t("This period exceeds the analysis limit. Shorten the period for a fuller sample.")}</p>}{data.limits.facetCounts && (["modes", "maps", "brawlers"] as const).some(key => data.limits.facetCounts[key] > data.facets[key].length) && <p>{t("Some filter choices exceed the display limit. Shorten the period to see more choices.")}</p>}</div>
      </details>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("Analysis view")}>{(Object.keys(views) as Array<keyof typeof views>).map(key => <Button key={key} size="sm" variant={view === key ? "default" : "outline"} aria-pressed={view === key} onClick={() => setView(key)}>{t(views[key])}</Button>)}</div>
      <section aria-label={t(views[view])} className="space-y-3">
        {(view === "maps" || view === "modes" || view === "brawlers") && <>
          {!groups.length && <p className="rounded-lg border p-6 text-sm text-muted-foreground">{t("No recorded participations match these filters.")}</p>}
          {data.limits.groupCounts[view] > groups.length && <p className="text-xs text-muted-foreground">{t("Showing {shown} of {total} groups. Refine the filters for more detail.", { shown: groups.length, total: data.limits.groupCounts[view] })}</p>}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{groups.map((group, index) => <Card key={`${group.context.key}:${group.mode?.key}:${group.map || group.brawler || index}`}><CardContent className="space-y-2 p-4"><h3 className="break-words font-semibold">{view === "maps" ? group.map : view === "brawlers" ? group.brawler : t(group.mode?.label || "Unknown")}</h3><p className="text-xs text-muted-foreground">{t(group.context.label)}{view !== "modes" && group.mode ? ` · ${t(group.mode.label)}` : ""}</p><dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-muted-foreground">{t("Member participations")}</dt><dd className="font-semibold">{number(group.observations)}</dd></div><div><dt className="text-xs text-muted-foreground">{t("Win rate")}</dt><dd className="font-semibold">{rate(group.winRate)}</dd></div></dl><p className="text-xs text-muted-foreground">{t("{wins} wins · {losses} losses", { wins: group.wins, losses: group.losses })} · {t("{draws} draws · {unknown} unknown results", { draws: group.draws, unknown: group.unknownResults })}</p></CardContent></Card>)}</div>
        </>}
        {view === "pairs" && <>
          <p className="text-sm text-muted-foreground">{t("Pairs count only players explicitly recorded on the same team. They do not prove a premade party.")}</p>
          {!data.pairs.length && <p className="rounded-lg border p-6 text-sm text-muted-foreground">{t("No confirmed teammate pairs in these records.")}</p>}
          {data.limits.groupCounts.pairs > data.pairs.length && <p className="text-xs text-muted-foreground">{t("Showing {shown} of {total} groups. Refine the filters for more detail.", { shown: data.pairs.length, total: data.limits.groupCounts.pairs })}</p>}
          <div className="grid gap-3 md:grid-cols-2">{data.pairs.map(pair => <Card key={`${pair.context.key}:${pair.player1.tag}:${pair.player2.tag}`}><CardContent className="space-y-2 p-4"><div className="flex flex-wrap gap-2 font-semibold"><Link className="break-all hover:underline" href={`/members/${encodeURIComponent(pair.player1.tag)}`}>{pair.player1.name}</Link><span aria-hidden="true">+</span><Link className="break-all hover:underline" href={`/members/${encodeURIComponent(pair.player2.tag)}`}>{pair.player2.name}</Link></div><p className="text-xs text-muted-foreground">{t(pair.context.label)}</p><p className="text-sm">{t("{count} shared matches", { count: pair.matches })} · {t("Win rate")}: {rate(pair.winRate)}</p><p className="text-xs text-muted-foreground">{t("{wins} wins · {losses} losses", { wins: pair.wins, losses: pair.losses })} · {t("{draws} draws · {unknown} unknown results", { draws: pair.draws, unknown: pair.unknownResults })}</p></CardContent></Card>)}</div>
        </>}
        {view === "hourly" && <>
          <p className="text-sm text-muted-foreground">{t("Battle start hours in UTC, based on member participations. These bars do not measure time online.")}</p>
          <ol className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{data.hourly.map(hour => <li key={hour.hour} className="flex min-w-0 items-center gap-2 text-xs"><bdi dir="ltr" className="w-12 shrink-0">{String(hour.hour).padStart(2, "0")}:00</bdi><div className="h-4 flex-1 overflow-hidden rounded bg-muted" aria-hidden="true"><div className="h-full rounded bg-primary/70" style={{ width: `${100 * hour.observations / maxHour}%` }} /></div><span className="w-12 text-end">{number(hour.observations)}</span></li>)}</ol>
        </>}
      </section>
    </>}
  </div>;
}

export default function AnalysisPage() {
  return <LayoutWrapper><Suspense fallback={<AnalysisLoading />}><AnalysisContent /></Suspense></LayoutWrapper>;
}
function AnalysisLoading() { const { t } = useI18n(); return <p role="status">{t("Loading battle analysis…")}</p>; }
