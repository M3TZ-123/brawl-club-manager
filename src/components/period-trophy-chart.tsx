"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useI18n } from "@/components/locale-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface TrophyObservation {
  recordedAt: string;
  trophies: number | null;
}

export function prepareTrophyObservations(points: TrophyObservation[], bucketMs?: number) {
  const observations = points.map(point => ({
    timestamp: Date.parse(point.recordedAt),
    trophies: typeof point.trophies === "number" && Number.isFinite(point.trophies) ? point.trophies : null,
  })).filter(point => Number.isFinite(point.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  if (!bucketMs || !Number.isFinite(bucketMs) || bucketMs <= 0) return observations;
  return observations.flatMap((point, index) => {
    const previous = observations[index - 1];
    const previousBucket = previous ? Math.floor(previous.timestamp / bucketMs) : null;
    // The API returns only occupied sampling buckets. A null separator keeps
    // the chart from implying a continuous series through unobserved buckets.
    return previousBucket !== null && Math.floor(point.timestamp / bucketMs) > previousBucket + 1
      ? [{ timestamp: (previousBucket + 1) * bucketMs, trophies: null }, point]
      : [point];
  });
}

/** Displays recorded account balances. Missing observations remain gaps. */
export function PeriodTrophyChart({ points, dayBased = false, bucketMs }: { points: TrophyObservation[]; dayBased?: boolean; bucketMs?: number }) {
  const { t, locale, number, dateTime, reportDate } = useI18n();
  const data = useMemo(() => prepareTrophyObservations(points, bucketMs), [points, bucketMs]);
  const hasObservations = data.some(point => point.trophies !== null);
  const formatTick = (timestamp: number) => new Intl.DateTimeFormat(locale === "ar" ? "ar-TN" : "en-GB", {
    month: "short", day: "numeric", ...(dayBased ? { timeZone: "UTC" } : {}),
  }).format(new Date(timestamp));

  return <Card>
    <CardHeader className="pb-3"><CardTitle>{t("Trophy Progression")}</CardTitle></CardHeader>
    <CardContent>
      {!hasObservations ? <p className="py-10 text-center text-sm text-muted-foreground">{t("Not enough history to show trophy progression for this period.")}</p> : <>
        <div className="h-64" role="img" aria-label={t("Recorded account trophies over time")}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 10, right: 12, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.2} />
              <XAxis dataKey="timestamp" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={formatTick} minTickGap={36} />
              <YAxis domain={["dataMin - 20", "dataMax + 20"]} tickFormatter={value => number(Number(value))} width={76} />
              <Tooltip labelFormatter={value => dayBased ? `${reportDate(new Date(Number(value)).toISOString())} (UTC)` : dateTime(new Date(Number(value)).toISOString())}
                formatter={value => [typeof value === "number" ? number(value) : t("Unknown"), t("Trophies")]}
                contentStyle={{ background: "var(--card)", borderColor: "var(--border)", borderRadius: 8 }} />
              <Line type="linear" dataKey="trophies" stroke="#eab308" strokeWidth={2} connectNulls={false} dot={data.length <= 30 ? { r: 3 } : false} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t("Based on recorded account trophies. Missing history is left blank.")}</p>
      </>}
    </CardContent>
  </Card>;
}
