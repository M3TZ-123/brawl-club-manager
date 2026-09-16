"use client";

import { fetchJsonCached, invalidateJsonCache } from "@/lib/client-data-cache";
import { useAppStore } from "@/lib/store";
import { supabase } from "@/lib/supabase";
import { getAdminSessionGeneration, isAdminSessionChanging } from "@/lib/client-admin-session";

export interface SyncRunSummary {
  source: string;
  scope: string;
  status: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  errorCode?: string | null;
  warnings?: string[];
}

export interface BattleCoverage {
  status: "unknown" | "observed" | "possible_gap";
  monitoredPlayers: number;
  currentPlayers: number;
  affectedPlayers: number;
  lastCheckedAt: string | null;
  lastGapAt: string | null;
  windowDays: number;
}

export interface SyncCapacity {
  usedBytes: number | null;
  budgetBytes: number | null;
  percent: number | null;
  level: "ok" | "warning" | "critical" | "unknown";
  sampledAt: string | null;
  stale: boolean;
}

export interface SyncHealth {
  lastSuccessAt: string | null;
  lastFullSuccessAt?: string | null;
  lastRosterSuccessAt?: string | null;
  lastBattleSuccessAt?: string | null;
  lastRankedSuccessAt?: string | null;
  lastAttemptAt: string | null;
  lastOutcome: string | null;
  expectedIntervalMinutes: number;
  rosterIntervalMinutes?: number;
  rankedIntervalMinutes?: number;
  freshness: "never" | "fresh" | "stale";
  fullFreshness?: "never" | "fresh" | "stale";
  rosterFreshness?: "never" | "fresh" | "stale";
  battleFreshness?: "never" | "fresh" | "stale";
  rankedFreshness?: "never" | "fresh" | "stale";
  running: boolean;
  latestRun?: SyncRunSummary | null;
  latestFullRun?: SyncRunSummary | null;
  battleCoverage?: BattleCoverage | null;
  capacity?: SyncCapacity | null;
}

const SYNC_SIGNAL_KEY = "brawl-club-manager-sync-updated";
const listeners = new Set<() => void>();
// Undefined means the first request has not settled; null means a failed read.
let health: SyncHealth | null | undefined;
let healthAuthGeneration = 0;
let inFlight: Promise<void> | null = null;
let refreshQueued = false;
let stopMonitoring: (() => void) | null = null;
let authMutationPending = false;
let signalVersion: string | null = null;
const pendingDatasets = new Set<string>();

export const getSyncHealth = () => {
  // Auth may have changed while no health component was subscribed. Never
  // expose the previous session's private snapshot on the first new render.
  if (health?.capacity && healthAuthGeneration !== getAdminSessionGeneration()) {
    health = { ...health };
    delete health.capacity;
  }
  return health;
};
export const getServerSyncHealth = () => undefined;

function broadcastSyncChange() {
  try { window.localStorage.setItem(SYNC_SIGNAL_KEY, JSON.stringify([
    useAppStore.getState().lastSyncTime, health?.lastRosterSuccessAt || null,
    health?.lastBattleSuccessAt || null, health?.lastRankedSuccessAt || null,
  ])); }
  catch { /* Storage can be disabled; focus and polling still refresh this tab. */ }
}

// All consumers share this request and one polling timer. Only server status
// supplies the displayed successful-sync time; local storage is a refresh hint.
export function refreshSyncHealth(afterPending = false): Promise<void> {
  if (inFlight) {
    if (afterPending) refreshQueued = true;
    return inFlight;
  }
  if (authMutationPending) return Promise.resolve();
  refreshQueued = false;
  const authGeneration = getAdminSessionGeneration();
  inFlight = fetchJsonCached<SyncHealth>("/api/sync/status", { staleMs: 0, force: true })
    .then(data => {
      // A sync completed while this read was in flight. Wait for the queued
      // fresh read instead of briefly replacing its timestamp with an old one.
      if (authGeneration !== getAdminSessionGeneration()) refreshQueued = true;
      if (refreshQueued) return;
      const parsed = data.lastSuccessAt ? Date.parse(data.lastSuccessAt) : NaN;
      const lastSuccessAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
      const datasets = new Set(pendingDatasets);
      const fullChanged = useAppStore.getState().lastSyncTime !== lastSuccessAt;
      const rosterChanged = (health?.lastRosterSuccessAt || null) !== (data.lastRosterSuccessAt || null);
      const battlesChanged = (health?.lastBattleSuccessAt || null) !== (data.lastBattleSuccessAt || null);
      const rankedChanged = (health?.lastRankedSuccessAt || null) !== (data.lastRankedSuccessAt || null);
      const completedRunChanged = data.latestRun?.status === "succeeded" && Boolean(data.latestRun.finishedAt)
        && data.latestRun.finishedAt !== health?.latestRun?.finishedAt;
      if (rosterChanged) datasets.add("roster");
      if (battlesChanged) datasets.add("battles");
      if (rankedChanged) datasets.add("ranked");
      if (fullChanged || (completedRunChanged && data.latestRun?.scope !== "roster")) ["roster", "battles", "ranked"].forEach(value => datasets.add(value));
      const changed = datasets.size > 0 || useAppStore.getState().lastSyncTime !== lastSuccessAt
        || (health?.lastRosterSuccessAt || null) !== (data.lastRosterSuccessAt || null)
        || (health?.lastBattleSuccessAt || null) !== (data.lastBattleSuccessAt || null)
        || (health?.lastRankedSuccessAt || null) !== (data.lastRankedSuccessAt || null);
      health = { lastSuccessAt, lastAttemptAt: data.lastAttemptAt, lastOutcome: data.lastOutcome,
        expectedIntervalMinutes: data.expectedIntervalMinutes, freshness: data.freshness,
        lastFullSuccessAt: data.lastFullSuccessAt ?? lastSuccessAt, lastRosterSuccessAt: data.lastRosterSuccessAt ?? null,
        lastBattleSuccessAt: data.lastBattleSuccessAt ?? null, lastRankedSuccessAt: data.lastRankedSuccessAt ?? null,
        fullFreshness: data.fullFreshness ?? data.freshness, rosterFreshness: data.rosterFreshness ?? "never",
        battleFreshness: data.battleFreshness ?? "never", rankedFreshness: data.rankedFreshness ?? "never",
        rosterIntervalMinutes: data.rosterIntervalMinutes, rankedIntervalMinutes: data.rankedIntervalMinutes,
        running: data.running, latestRun: data.latestRun, latestFullRun: data.latestFullRun,
        battleCoverage: data.battleCoverage ?? null, ...(data.capacity ? { capacity: data.capacity } : {}) };
      healthAuthGeneration = authGeneration;
      useAppStore.getState().setLastSyncTime(lastSuccessAt);
      pendingDatasets.clear();
      if (changed) {
        invalidateJsonCache();
        broadcastSyncChange();
        window.dispatchEvent(new CustomEvent("club-data-updated", { detail: { source: "sync-status", syncTime: lastSuccessAt, datasets: [...datasets] } }));
      }
    })
    .catch(() => { health = null; })
    .finally(() => {
      inFlight = null;
      listeners.forEach(listener => listener());
      if (refreshQueued) {
        refreshQueued = false;
        if (listeners.size && !authMutationPending) void refreshSyncHealth();
      }
    });
  return inFlight;
}

export function subscribeSyncHealth(listener: () => void) {
  listeners.add(listener);
  if (!stopMonitoring) {
    // A route gate may have unmounted every consumer during an auth change.
    // Its completion event can therefore precede this subscription.
    authMutationPending = isAdminSessionChanging();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const disconnect = () => { if (channel) { void supabase.removeChannel(channel); channel = null; } };
    const connect = () => {
      if (channel || document.visibilityState === "hidden") return;
      channel = supabase.channel("club-sync-completions").on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "club_sync_signals", filter: "id=eq.1" }, payload => {
          const row = payload.new as { id?: number; version?: string; datasets?: unknown };
          if (document.visibilityState === "hidden" || row.id !== 1 || !row.version || row.version === signalVersion) return;
          signalVersion = row.version;
          if (Array.isArray(row.datasets)) for (const dataset of row.datasets) {
            if (["roster", "battles", "ranked"].includes(dataset)) pendingDatasets.add(dataset);
          }
          void refreshSyncHealth(true);
        }).subscribe();
    };
    const wake = () => {
      if (document.visibilityState === "hidden") { disconnect(); return; }
      connect(); void refreshSyncHealth();
    };
    const clubChanged = (event: Event) => {
      if ((event as CustomEvent).detail?.source === "sync-status") return;
      broadcastSyncChange();
      if (document.visibilityState !== "hidden") void refreshSyncHealth(true);
    };
    const authChanged = (event: Event) => {
      authMutationPending = (event as CustomEvent).detail?.pending === true;
      invalidateJsonCache("/api/sync/status", { cancelPending: true });
      // Remove admin-only data before awaiting the new session's response.
      // refreshQueued also prevents an earlier admin request restoring it.
      if (health?.capacity) {
        health = { ...health };
        delete health.capacity;
        listeners.forEach(listener => listener());
      }
      if (authMutationPending) refreshQueued = true;
      else if (document.visibilityState !== "hidden") void refreshSyncHealth(true);
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === SYNC_SIGNAL_KEY && document.visibilityState !== "hidden") void refreshSyncHealth(true);
    };
    const timer = window.setInterval(wake, 30_000);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("club-data-updated", clubChanged);
    window.addEventListener("admin-session-changed", authChanged);
    window.addEventListener("storage", storageChanged);
    stopMonitoring = () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("club-data-updated", clubChanged);
      window.removeEventListener("admin-session-changed", authChanged);
      window.removeEventListener("storage", storageChanged);
      disconnect();
      stopMonitoring = null;
    };
    wake();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stopMonitoring?.();
  };
}
