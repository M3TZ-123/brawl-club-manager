"use client";

import { useSyncExternalStore } from "react";
import { getSyncHealth, getServerSyncHealth, subscribeSyncHealth, type SyncHealth } from "@/lib/client-sync-status";
import { useI18n, LocalDate } from "@/components/locale-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function useSyncHealth() {
  return useSyncExternalStore(subscribeSyncHealth, getSyncHealth, getServerSyncHealth);
}
const warningMessages: Record<string, string> = {
  battle_logs_incomplete: "Some battle logs could not be refreshed. The last complete battle update is shown below.",
  battle_logs_rate_limited: "The battle provider limited requests. Battle data will be retried later.",
  ranked_unavailable: "Ranked data is unavailable. Previously recorded ranks remain unchanged.",
  ranked_rate_limited: "The ranked provider limited requests. Previously recorded ranks remain unchanged.",
};
const freshnessLabel = (freshness: string | undefined) => freshness === "fresh" ? "Fresh" : freshness === "stale" ? "Stale" : "No complete refresh recorded";
const completedFullRun = (health: SyncHealth | null) => health?.latestFullRun ?? (health?.latestRun?.scope === "full" && health.latestRun.status !== "running" ? health.latestRun : null);

export function DataConfidenceNotice() {
  const health = useSyncHealth();
  const { t } = useI18n();
  const fullRun = completedFullRun(health);
  const battleWarning = fullRun?.warnings?.some(code => code === "battle_logs_incomplete" || code === "battle_logs_rate_limited");
  const fullFailed = fullRun && fullRun.status !== "succeeded";
  if ((health?.fullFreshness ?? health?.freshness) === "fresh" && health?.battleFreshness === "fresh" && !battleWarning && !fullFailed) return null;
  return <div role="status" className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><p className="font-medium">{t(health ? "Battle or profile data is incomplete or stale. Review its timestamp before judging inactivity." : "Sync health")}{!health && ": " + t("Unavailable")}</p><p className="mt-1 text-muted-foreground">{t("A recent roster check does not confirm recent battle activity.")}</p></div>;
}

function FreshnessRow({ label, timestamp, freshness }: { label: string; timestamp?: string | null; freshness?: string }) {
  const { t } = useI18n();
  return <div className="flex flex-wrap justify-between gap-2"><dt>{t(label)}</dt><dd className="text-end"><p>{timestamp ? <LocalDate value={timestamp} time /> : t("Unknown")}</p><p className={freshness === "fresh" ? "text-xs text-green-500" : "text-xs text-amber-500"}>{t(freshnessLabel(freshness))}</p></dd></div>;
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
  return <Card><CardHeader><CardTitle>{t("Sync health")}</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-xs text-muted-foreground">{health ? t("Light roster every {roster} minutes; full profiles and battles every {full} minutes; ranked every {ranked} minutes.", { roster: health.rosterIntervalMinutes || 2, full: health.expectedIntervalMinutes, ranked: health.rankedIntervalMinutes || 30 }) : t("Unavailable")}</p><dl className="space-y-3 text-sm">
    <div className="flex justify-between gap-3"><dt>{t("Current status")}</dt><dd className="font-semibold">{t(currentStatus)}</dd></div>
    <FreshnessRow label="Light roster" timestamp={health?.lastRosterSuccessAt} freshness={health?.rosterFreshness} />
    <FreshnessRow label="Full profiles" timestamp={health?.lastFullSuccessAt ?? health?.lastSuccessAt} freshness={fullFreshness} />
    <FreshnessRow label="Complete battle logs" timestamp={health?.lastBattleSuccessAt} freshness={health?.battleFreshness} />
    <FreshnessRow label="Ranked data" timestamp={health?.lastRankedSuccessAt} freshness={health?.rankedFreshness} />
    <div className="flex flex-wrap justify-between gap-2"><dt>{t("Last attempt")}</dt><dd className="text-end">{health?.lastAttemptAt ? <LocalDate value={health.lastAttemptAt} time /> : t("No sync attempt recorded")}<p className="text-xs text-muted-foreground">{t(health?.latestRun?.scope || "Unknown")} · {t(health?.lastOutcome || "Unknown")}</p></dd></div>
    <div className="flex flex-wrap justify-between gap-2"><dt>{t("Last completed full attempt")}</dt><dd className="text-end">{fullRun?.finishedAt || fullRun?.startedAt ? <LocalDate value={fullRun.finishedAt || fullRun.startedAt} time /> : t("No sync attempt recorded")}<p className="text-xs text-muted-foreground">{t(fullRun?.status || "Unknown")}</p></dd></div>
    <div className="flex justify-between gap-3"><dt>{t("Full sync interval")}</dt><dd>{health?.expectedIntervalMinutes ? t("Every {minutes} minutes", { minutes: health.expectedIntervalMinutes }) : t("Unknown")}</dd></div>
  </dl><p className="text-xs text-muted-foreground">{t("Roster checks update membership and trophies. Battle and ranked timestamps advance only after complete refreshes.")}</p>{fullFailed && <p role="status" className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{t("The latest full sync did not complete. The displayed data comes from an earlier successful update.")}</p>}{warnings.length > 0 && <div role="status" className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><p className="font-medium">{t("Partial update")}</p><ul className="mt-1 list-disc space-y-1 ps-4">{warnings.map(code => <li key={code}>{t(warningMessages[code])}</li>)}</ul></div>}</CardContent></Card>;
}
