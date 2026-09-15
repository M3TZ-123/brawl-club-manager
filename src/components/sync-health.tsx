"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJsonCached } from "@/lib/client-data-cache";
import { useI18n, LocalDate } from "@/components/locale-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface SyncHealth {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastOutcome: string | null;
  expectedIntervalMinutes: number;
  freshness: "never" | "fresh" | "stale";
  running: boolean;
  latestRun?: { source: string; scope: string; status: string; errorCode?: string | null } | null;
}

export function useSyncHealth() {
  const [health, setHealth] = useState<SyncHealth | null>(null);
  const load = useCallback(async (force = false) => {
    try { setHealth(await fetchJsonCached<SyncHealth>("/api/sync/status", { staleMs: 15_000, force })); }
    catch { setHealth(null); }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(() => load());
    const update = () => { void load(true); };
    const timer = window.setInterval(update, 60_000);
    window.addEventListener("club-data-updated", update);
    window.addEventListener("admin-session-changed", update);
    return () => { window.clearInterval(timer); window.removeEventListener("club-data-updated", update); window.removeEventListener("admin-session-changed", update); };
  }, [load]);
  return health;
}

export function DataConfidenceNotice() {
  const health = useSyncHealth();
  const { t } = useI18n();
  if (health?.freshness === "fresh") return null;
  return <div role="status" className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><p className="font-medium">{t(health ? "Data is stale. Refresh the club before judging inactivity." : "Sync health")}{!health && `: ${t("Unavailable")}`}</p><p className="mt-1 text-muted-foreground">{t("Activity confidence is reduced until the next successful sync.")}</p></div>;
}

export function SyncHealthCard() {
  const health = useSyncHealth();
  const { t } = useI18n();
  return <Card><CardHeader><CardTitle>{t("Sync health")}</CardTitle></CardHeader><CardContent><dl className="space-y-3 text-sm">
    <div className="flex justify-between gap-3"><dt>{t("Current status")}</dt><dd className="font-semibold">{t(!health ? "Unavailable" : health.running ? "Running" : health.freshness === "fresh" ? "Fresh" : health.freshness === "never" ? "No successful sync yet" : "Stale")}</dd></div>
    <div className="flex justify-between gap-3"><dt>{t("Last successful sync")}</dt><dd>{health?.lastSuccessAt ? <LocalDate value={health.lastSuccessAt} time /> : t("Unknown")}</dd></div>
    <div className="flex justify-between gap-3"><dt>{t("Last attempt")}</dt><dd>{health?.lastAttemptAt ? <LocalDate value={health.lastAttemptAt} time /> : t("No sync attempt recorded")}</dd></div>
    <div className="flex justify-between gap-3"><dt>{t("Last outcome")}</dt><dd>{t(health?.lastOutcome || "Unknown")}</dd></div>
    <div className="flex justify-between gap-3"><dt>{t("Expected interval")}</dt><dd>{health?.expectedIntervalMinutes ? t("Every {minutes} minutes", { minutes: health.expectedIntervalMinutes }) : t("Unknown")}</dd></div>
  </dl></CardContent></Card>;
}
