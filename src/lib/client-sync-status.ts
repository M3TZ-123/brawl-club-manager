"use client";

import { fetchJsonCached, invalidateJsonCache } from "@/lib/client-data-cache";
import { useAppStore } from "@/lib/store";

export interface SyncHealth {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastOutcome: string | null;
  expectedIntervalMinutes: number;
  freshness: "never" | "fresh" | "stale";
  running: boolean;
  latestRun?: { source: string; scope: string; status: string; errorCode?: string | null } | null;
}

const SYNC_SIGNAL_KEY = "brawl-club-manager-sync-updated";
const listeners = new Set<() => void>();
let health: SyncHealth | null = null;
let inFlight: Promise<void> | null = null;
let refreshQueued = false;
let stopMonitoring: (() => void) | null = null;

export const getSyncHealth = () => health;
export const getServerSyncHealth = () => null;

function broadcastSyncChange() {
  try { window.localStorage.setItem(SYNC_SIGNAL_KEY, useAppStore.getState().lastSyncTime || ""); }
  catch { /* Storage can be disabled; focus and polling still refresh this tab. */ }
}

// All consumers share this request and one polling timer. Only server status
// supplies the displayed successful-sync time; local storage is a refresh hint.
export function refreshSyncHealth(afterPending = false): Promise<void> {
  if (inFlight) {
    if (afterPending) refreshQueued = true;
    return inFlight;
  }
  inFlight = fetchJsonCached<SyncHealth>("/api/sync/status", { staleMs: 0, force: true })
    .then(data => {
      // A sync completed while this read was in flight. Wait for the queued
      // fresh read instead of briefly replacing its timestamp with an old one.
      if (refreshQueued) return;
      const parsed = data.lastSuccessAt ? Date.parse(data.lastSuccessAt) : NaN;
      const lastSuccessAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
      health = { lastSuccessAt, lastAttemptAt: data.lastAttemptAt, lastOutcome: data.lastOutcome,
        expectedIntervalMinutes: data.expectedIntervalMinutes, freshness: data.freshness,
        running: data.running, latestRun: data.latestRun };
      const changed = useAppStore.getState().lastSyncTime !== lastSuccessAt;
      useAppStore.getState().setLastSyncTime(lastSuccessAt);
      if (changed) {
        invalidateJsonCache();
        broadcastSyncChange();
        window.dispatchEvent(new CustomEvent("club-data-updated", { detail: { source: "sync-status", syncTime: lastSuccessAt } }));
      }
    })
    .catch(() => { health = null; })
    .finally(() => {
      inFlight = null;
      listeners.forEach(listener => listener());
      if (refreshQueued) {
        refreshQueued = false;
        if (listeners.size) void refreshSyncHealth();
      }
    });
  return inFlight;
}

export function subscribeSyncHealth(listener: () => void) {
  listeners.add(listener);
  if (!stopMonitoring) {
    const wake = () => { if (document.visibilityState !== "hidden") void refreshSyncHealth(); };
    const clubChanged = (event: Event) => {
      if ((event as CustomEvent).detail?.source === "sync-status") return;
      broadcastSyncChange();
      void refreshSyncHealth(true);
    };
    const authChanged = () => { void refreshSyncHealth(true); };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === SYNC_SIGNAL_KEY) void refreshSyncHealth(true);
    };
    const timer = window.setInterval(wake, 60_000);
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
      stopMonitoring = null;
    };
    void refreshSyncHealth();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stopMonitoring?.();
  };
}
