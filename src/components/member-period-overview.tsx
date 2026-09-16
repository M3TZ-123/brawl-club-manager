"use client";

import { useI18n } from "@/components/locale-provider";
import { Card, CardContent } from "@/components/ui/card";
import { PeriodTrophyChart, type TrophyObservation } from "@/components/period-trophy-chart";
import { TIME_RANGES, type TimeRangeKey } from "@/lib/time-range";

export interface MemberPeriodStats {
  battles: number;
  wins: number;
  losses: number;
  winRate: number;
  activeDays: number;
}

export function MemberPeriodOverview({ range, trophyChange, observations, observationIntervalMs, stats, period }: {
  range: TimeRangeKey;
  trophyChange: number | null;
  observations: TrophyObservation[];
  observationIntervalMs?: number;
  stats: MemberPeriodStats | null;
  period?: { start: string; end: string };
}) {
  const { t, number, delta, reportDate } = useI18n();
  return <section aria-label={t("Period overview")} className="space-y-4">
    <div>
      <h2 className="text-lg font-semibold">{t("Period overview")}</h2>
      {period && <p className="text-xs text-muted-foreground">{t("Battle results")}: {reportDate(period.start)} – {reportDate(period.end)} (UTC)</p>}
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card><CardContent className="p-4">
        <p className="text-sm text-muted-foreground">{t("Account trophy change")}</p>
        <p className={`mt-2 text-2xl font-bold ${trophyChange !== null && trophyChange > 0 ? "text-green-500" : trophyChange !== null && trophyChange < 0 ? "text-red-500" : ""}`}>{trophyChange === null ? "—" : delta(trophyChange)}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t(trophyChange === null ? "Not enough history for this period." : TIME_RANGES[range].label)}</p>
      </CardContent></Card>
      <Card><CardContent className="p-4">
        <p className="text-sm text-muted-foreground">{t("Recorded battles")}</p>
        <p className="mt-2 text-2xl font-bold">{stats ? number(stats.battles) : "—"}</p>
        {stats && <p className="mt-1 text-xs text-muted-foreground">{t("{wins} wins · {losses} losses", { wins: number(stats.wins), losses: number(stats.losses) })}</p>}
      </CardContent></Card>
      <Card><CardContent className="p-4">
        <p className="text-sm text-muted-foreground">{t("Win Rate")}</p>
        <p className="mt-2 text-2xl font-bold">{stats && stats.battles > 0 ? `${number(Math.round(stats.winRate))}%` : "—"}</p>
      </CardContent></Card>
      <Card><CardContent className="p-4">
        <p className="text-sm text-muted-foreground">{t("Days with recorded battles")}</p>
        <p className="mt-2 text-2xl font-bold">{stats ? number(stats.activeDays) : "—"}</p>
      </CardContent></Card>
    </div>
    <PeriodTrophyChart points={observations} bucketMs={observationIntervalMs} />
  </section>;
}
