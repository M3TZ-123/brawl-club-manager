"use client";

import { useSyncExternalStore } from "react";
import { getSyncHealth, getServerSyncHealth, subscribeSyncHealth, type BattleCoverage, type SyncCapacity, type SyncHealth } from "@/lib/client-sync-status";
import { useI18n, LocalDate } from "@/components/locale-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function useSyncHealth() {
  return useSyncExternalStore(subscribeSyncHealth, getSyncHealth, getServerSyncHealth);
}
const warningMessages: Record<string, string> = {
  battle_logs_incomplete: "Some battle logs could not be refreshed. The last successful fetch time is shown above.",
  battle_logs_rate_limited: "The battle provider limited requests. Battle data will be retried later.",
  ranked_unavailable: "Ranked data is unavailable. Previously recorded ranks remain unchanged.",
  ranked_rate_limited: "The ranked provider limited requests. Previously recorded ranks remain unchanged.",
};
const freshnessLabel = (freshness: string | undefined) => freshness === "fresh" ? "Fresh" : freshness === "stale" ? "Stale" : "No complete refresh recorded";
const completedFullRun = (health: SyncHealth | null | undefined) => health?.latestFullRun ?? (health?.latestRun?.scope === "full" && health.latestRun.status !== "running" ? health.latestRun : null);

export function DataConfidenceNotice() {
  const health = useSyncHealth();
  const { t } = useI18n();
  if (health === undefined) return null;
  const fullRun = completedFullRun(health);
  const battleWarning = fullRun?.warnings?.some(code => code === "battle_logs_incomplete" || code === "battle_logs_rate_limited");
  const fullFailed = fullRun && fullRun.status !== "succeeded";
  if (health?.battleCoverage?.status === "possible_gap") {
    return <div role="status" className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><p className="font-medium">{t("A possible gap remains in the recorded battle history.")}</p><p className="mt-1 text-muted-foreground">{t("A fresh fetch does not recover earlier battles that may be absent. Review recorded activity with this limitation in mind.")}</p></div>;
  }
  if ((health?.fullFreshness ?? health?.freshness) === "fresh" && health?.battleFreshness === "fresh" && !battleWarning && !fullFailed) return null;
  return <div role="status" className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><p className="font-medium">{t(health ? "Battle or profile data is incomplete or stale. Review its timestamp before judging inactivity." : "Sync health")}{!health && ": " + t("Unavailable")}</p><p className="mt-1 text-muted-foreground">{t("A recent roster check does not confirm recent battle activity.")}</p></div>;
}

function FreshnessRow({ label, timestamp, freshness }: { label: string; timestamp?: string | null; freshness?: string }) {
  const { t } = useI18n();
  return <div className="flex flex-wrap justify-between gap-2"><dt>{t(label)}</dt><dd className="text-end"><p>{timestamp ? <LocalDate value={timestamp} time /> : t("Unknown")}</p><p className={freshness === "fresh" ? "text-xs text-green-500" : "text-xs text-amber-500"}>{t(freshnessLabel(freshness))}</p></dd></div>;
}

function BattleCoverageSection({ coverage }: { coverage?: BattleCoverage | null }) {
  const { t, number } = useI18n();
  const status = coverage?.status || "unknown";
  const possibleGap = status === "possible_gap";
  const label = possibleGap ? "Possible history gap" : status === "observed" ? "No gap observed in monitored data" : "Coverage unknown";
  return <section className="space-y-2 border-t border-border pt-4 text-sm" aria-label={t("Battle history coverage")}>
    <h3 className="font-semibold">{t("Battle history coverage")}</h3>
    <p className={possibleGap ? "font-medium text-amber-500" : "font-medium text-muted-foreground"}>{t(label)}</p>
    <p className="text-xs text-muted-foreground">{t(status === "unknown" ? "Monitoring has not established coverage yet." : "Coverage describes checks since monitoring began. It does not prove that earlier history is complete.")}</p>
    {coverage && <>
      <p>{t("Monitoring {monitored} of {current} current players.", { monitored: number(coverage.monitoredPlayers), current: number(coverage.currentPlayers) })}</p>
      {possibleGap && <p>{t("Possible gaps for {count} players in the last {days} days.", { count: number(coverage.affectedPlayers), days: number(coverage.windowDays) })}</p>}
      <dl className="space-y-1 text-xs text-muted-foreground">
        <div className="flex flex-wrap justify-between gap-x-2"><dt>{t("Last coverage check")}</dt><dd><LocalDate value={coverage.lastCheckedAt} time /></dd></div>
        {coverage.lastGapAt && <div className="flex flex-wrap justify-between gap-x-2"><dt>{t("Last possible gap observed")}</dt><dd><LocalDate value={coverage.lastGapAt} time /></dd></div>}
      </dl>
    </>}
    <p className="text-xs text-muted-foreground">{t("Fetch freshness and historical coverage are separate measures.")}</p>
  </section>;
}

function CapacitySection({ capacity }: { capacity: SyncCapacity }) {
  const { t, number } = useI18n();
  const sampledAt = capacity.sampledAt ? Date.parse(capacity.sampledAt) : NaN;
  const validSample = Number.isFinite(sampledAt);
  const validNumbers = typeof capacity.usedBytes === "number" && Number.isFinite(capacity.usedBytes) && capacity.usedBytes >= 0
    && typeof capacity.budgetBytes === "number" && Number.isFinite(capacity.budgetBytes) && capacity.budgetBytes > 0
    && typeof capacity.percent === "number" && Number.isFinite(capacity.percent) && capacity.percent >= 0;
  const known = validNumbers && validSample && ["ok", "warning", "critical"].includes(capacity.level);
  // The shared server poll evaluates age against the server clock.
  const stale = capacity.stale !== false;
  const current = known && !stale;
  const label = !known ? "Capacity unavailable" : stale ? "Capacity sample is stale" : capacity.level === "critical" ? "Storage budget critical" : capacity.level === "warning" ? "Storage budget warning" : "Within configured budget";
  const color = !current ? "text-muted-foreground" : capacity.level === "critical" ? "text-red-500" : capacity.level === "warning" ? "text-amber-500" : "text-green-500";
  const percent = capacity.percent ?? 0;
  return <section className="space-y-2 border-t border-border pt-4 text-sm" aria-label={t("Database capacity")}>
    <h3 className="font-semibold">{t("Database capacity")}</h3>
    <p className={`font-medium ${color}`}>{t(label)}</p>
    {validNumbers && <p>{t("{used} MB used / {budget} MB configured budget ({percent}%).", { used: number(Math.round(capacity.usedBytes! / 100_000) / 10), budget: number(Math.round(capacity.budgetBytes! / 100_000) / 10), percent: number(Math.round(percent * 10) / 10) })}</p>}
    {current && <div role="progressbar" aria-label={t("Configured database budget used")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(percent, 100)} aria-valuetext={t("{percent}% of configured budget", { percent: number(Math.round(percent * 10) / 10) })} className="h-2 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${capacity.level === "critical" ? "bg-red-500" : capacity.level === "warning" ? "bg-amber-500" : "bg-green-500"}`} style={{ width: `${Math.min(percent, 100)}%` }} /></div>}
    <p className="text-xs text-muted-foreground">{t("Alerts use the configured app budget, not an authoritative provider quota. Confirm your plan limit in the provider dashboard.")}</p>
    <p className="text-xs text-muted-foreground">{t("Warning at 70%; critical at 90%. Samples older than 2 hours are stale.")}</p>
    <dl className="text-xs text-muted-foreground"><div className="flex flex-wrap justify-between gap-x-2"><dt>{t("Capacity sampled")}</dt><dd><LocalDate value={validSample ? capacity.sampledAt : null} time /></dd></div></dl>
  </section>;
}

export function SyncHealthCard() {
  const health = useSyncHealth();
  const { t } = useI18n();
  const fullFreshness = health?.fullFreshness ?? health?.freshness;
  const fullRun = completedFullRun(health);
  const fullFailed = Boolean(fullRun && fullRun.status !== "succeeded");
  const warnings = (fullRun?.warnings || []).filter(code => warningMessages[code]);
  const allFresh = [fullFreshness, health?.rosterFreshness, health?.battleFreshness, health?.rankedFreshness].every(value => value === "fresh") && warnings.length === 0 && !fullFailed;
  const currentStatus = !health ? "Unavailable" : health.running ? "Running" : allFresh ? "Fresh" : fullFreshness === "stale" ? "Stale" : fullFreshness === "never" ? "No successful sync yet" : "Partial";
  return <Card><CardHeader><CardTitle>{t("Sync health")}</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-xs text-muted-foreground">{health ? t("Light roster every {roster} minutes; full profiles and battles every {full} minutes; ranked every {ranked} minutes.", { roster: health.rosterIntervalMinutes || 2, full: health.expectedIntervalMinutes, ranked: health.rankedIntervalMinutes || health.expectedIntervalMinutes }) : t("Unavailable")}</p><dl className="space-y-3 text-sm">
    <div className="flex justify-between gap-3"><dt>{t("Fetch status")}</dt><dd className="font-semibold">{t(currentStatus)}</dd></div>
    <FreshnessRow label="Light roster" timestamp={health?.lastRosterSuccessAt} freshness={health?.rosterFreshness} />
    <FreshnessRow label="Full profiles" timestamp={health?.lastFullSuccessAt ?? health?.lastSuccessAt} freshness={fullFreshness} />
    <FreshnessRow label="Battle log fetch" timestamp={health?.lastBattleSuccessAt} freshness={health?.battleFreshness} />
    <FreshnessRow label="Ranked data" timestamp={health?.lastRankedSuccessAt} freshness={health?.rankedFreshness} />
    <div className="flex flex-wrap justify-between gap-2"><dt>{t("Last attempt")}</dt><dd className="text-end">{health?.lastAttemptAt ? <LocalDate value={health.lastAttemptAt} time /> : t("No sync attempt recorded")}<p className="text-xs text-muted-foreground">{t(health?.latestRun?.scope || "Unknown")} · {t(health?.lastOutcome || "Unknown")}</p></dd></div>
    <div className="flex flex-wrap justify-between gap-2"><dt>{t("Last completed full attempt")}</dt><dd className="text-end">{fullRun?.finishedAt || fullRun?.startedAt ? <LocalDate value={fullRun.finishedAt || fullRun.startedAt} time /> : t("No sync attempt recorded")}<p className="text-xs text-muted-foreground">{t(fullRun?.status || "Unknown")}</p></dd></div>
    <div className="flex justify-between gap-3"><dt>{t("Full sync interval")}</dt><dd>{health?.expectedIntervalMinutes ? t("Every {minutes} minutes", { minutes: health.expectedIntervalMinutes }) : t("Unknown")}</dd></div>
  </dl><p className="text-xs text-muted-foreground">{t("Roster checks update membership and trophies. Battle and ranked timestamps advance only after complete refreshes.")}</p>{fullFailed && <p role="status" className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{t("The latest full sync did not complete. The displayed data comes from an earlier successful update.")}</p>}{warnings.length > 0 && <div role="status" className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><p className="font-medium">{t("Partial update")}</p><ul className="mt-1 list-disc space-y-1 ps-4">{warnings.map(code => <li key={code}>{t(warningMessages[code])}</li>)}</ul></div>}<BattleCoverageSection coverage={health?.battleCoverage} />{health?.capacity && <CapacitySection capacity={health.capacity} />}</CardContent></Card>;
}
