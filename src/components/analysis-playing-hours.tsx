"use client";

import { useI18n } from "@/components/locale-provider";
import type { AnalysisResponse } from "@/lib/club-analysis-types";

type PlayingHour = AnalysisResponse["hourly"][number];
const hourWindow = (hour: number) => `${String(hour).padStart(2, "0")}:00–${String((hour + 1) % 24).padStart(2, "0")}:00`;
const validCount = (value: number | undefined): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function AnalysisPlayingHours({ data }: { data: AnalysisResponse }) {
  const { t, number } = useI18n();
  const hasMembers = data.hourly.every(hour => validCount(hour.uniquePlayers) && validCount(hour.activeDays));
  const busiest = hasMembers ? [...data.hourly].filter(hour => hour.observations > 0 && (hour.uniquePlayers || 0) > 0)
    .sort((a, b) => (b.uniquePlayers! - a.uniquePlayers!) || (b.activeDays! - a.activeDays!) || b.observations - a.observations || a.hour - b.hour).slice(0, 3) : [];
  const maximum = Math.max(1, ...data.hourly.map(hour => hasMembers ? hour.uniquePlayers! : hour.observations));
  const positive = data.hourly.some(hour => hour.observations > 0);
  const counts = (hour: PlayingHour) => t("{members} members · {days} recorded days", { members: validCount(hour.uniquePlayers) ? number(hour.uniquePlayers) : t("Unknown"), days: validCount(hour.activeDays) ? number(hour.activeDays) : t("Unknown") });

  return <section className="space-y-4 min-w-0" aria-label={t("Playing hours")}>
    <div><h2 className="text-lg font-semibold">{t("When members are recorded playing")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("Times shown in {zone}.", { zone: data.timeZone || "UTC" })}</p></div>
    <p className="text-sm text-muted-foreground">{t("Members are counted once per hour across the selected period. They were not necessarily online together.")}</p>
    {!positive ? <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{t("No recorded battles match this period and these filters. This does not prove inactivity.")}</p> : <>
      {busiest.length > 0 && <div className="space-y-2"><h3 className="text-sm font-medium">{t("Hours with the most different members")}</h3><div className="grid gap-3 sm:grid-cols-3">
        {busiest.map(hour => <article key={hour.hour} className="rounded-lg border border-primary/25 bg-primary/5 p-4 space-y-2">
          <h4 className="font-semibold"><bdi dir="ltr">{hourWindow(hour.hour)}</bdi></h4>
          <p className="text-sm">{counts(hour)}</p><p className="text-xs text-muted-foreground">{t("{count} recorded participations", { count: hour.observations })}</p>
          {hour.activeDays === 1 && <p className="text-xs text-amber-700 dark:text-amber-400">{t("Only one day observed at this hour")}</p>}
        </article>)}
      </div><p className="text-xs text-muted-foreground">{t("Use these hours to suggest a club session, then confirm availability with members.")}</p></div>}
      <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t("All 24 hours")}</summary>
        <p className="mt-3 text-xs text-muted-foreground">{t(hasMembers ? "Bars show distinct members, not time online." : "Bars show recorded participations, not time online.")}</p>
        <ol className="mt-3 grid gap-3 lg:grid-cols-2">{data.hourly.map(hour => <li key={hour.hour} className="min-w-0 rounded border p-3">
          <div className="flex items-center justify-between gap-2 text-sm"><bdi dir="ltr" className="shrink-0">{hourWindow(hour.hour)}</bdi><span>{hasMembers ? t("{count} members", { count: hour.uniquePlayers! }) : number(hour.observations)}</span></div>
          <div className="my-2 h-2 rounded bg-muted" aria-hidden="true"><div className="h-full rounded bg-primary/70" style={{ width: `${100 * (hasMembers ? hour.uniquePlayers! : hour.observations) / maximum}%` }} /></div>
          <p className="text-xs text-muted-foreground">{validCount(hour.activeDays) && <>{t("{count} recorded days", { count: hour.activeDays })} · </>}{t("{count} recorded participations", { count: hour.observations })}</p>
        </li>)}</ol>
      </details>
    </>}
  </section>;
}
