"use client";

import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import { invalidateJsonCache } from "@/lib/client-data-cache";

export type AdminSession = { configured: boolean; isAdmin: boolean; isLoading: boolean };
const initial: AdminSession = { configured: false, isAdmin: false, isLoading: true };
let snapshot = initial;
let generation = 0, checkedAt = 0;
let pending: { promise: Promise<void>; controller: AbortController } | null = null;
let mutation: Promise<void> | null = null;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();
const STORAGE_KEY = "brawl-club-manager-admin-session-updated";
export const getAdminSession = () => snapshot;
export const getServerAdminSession = () => initial;
export const isAdminSessionChanging = () => mutation !== null;
export const getAdminSessionGeneration = () => generation;
function publish(value: AdminSession) { snapshot = value; listeners.forEach(listener => listener()); }
function announce(pendingMutation: boolean, broadcast = false) {
  window.dispatchEvent(new CustomEvent("admin-session-changed", { detail: { source: "admin-session-store", pending: pendingMutation } }));
  if (broadcast) { try { window.localStorage.setItem(STORAGE_KEY, `${Date.now()}:${generation}`); } catch { /* Focus rechecks remain available. */ } }
}
function reset() {
  generation++; checkedAt = 0;
  pending?.controller.abort(); pending = null;
  invalidateJsonCache("/api/", { cancelPending: true });
  publish({ configured: snapshot.configured, isAdmin: false, isLoading: true });
}

export function refreshAdminSession(force = false): Promise<void> {
  if (mutation) return mutation.catch(() => {});
  if (pending) return pending.promise;
  if (!force && checkedAt && Date.now() - checkedAt < 30_000) return Promise.resolve();
  const version = generation, controller = new AbortController();
  const promise = fetchJsonWithTimeout<{ configured: boolean; isAdmin: boolean }>("/api/admin/session", { cache: "no-store", signal: controller.signal })
    .then(data => {
      if (version !== generation) return;
      const downgraded = snapshot.isAdmin && data.isAdmin !== true;
      if (downgraded) { generation++; invalidateJsonCache("/api/", { cancelPending: true }); }
      checkedAt = Date.now();
      publish({ configured: data.configured === true, isAdmin: data.isAdmin === true, isLoading: false });
      if (downgraded) announce(false, true);
    }).catch(() => {
      if (version !== generation) return;
      const wasAdmin = snapshot.isAdmin;
      if (wasAdmin) { generation++; invalidateJsonCache("/api/", { cancelPending: true }); }
      publish({ configured: snapshot.configured, isAdmin: false, isLoading: false });
      if (wasAdmin) announce(false);
    }).finally(() => { if (pending?.controller === controller) pending = null; });
  pending = { promise, controller };
  return promise;
}

async function changeSession(method: "POST" | "DELETE", password?: string) {
  if (mutation) return mutation;
  reset(); announce(true);
  const version = generation;
  let failed = false;
  mutation = (async () => {
    try {
      await fetchJsonWithTimeout("/api/admin/session", { method, ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) } : {}) });
      if (version === generation) { checkedAt = Date.now(); publish({ configured: true, isAdmin: method === "POST", isLoading: false }); }
    } catch (error) {
      failed = true;
      if (version === generation) publish({ configured: snapshot.configured, isAdmin: false, isLoading: false });
      throw error;
    } finally {
      mutation = null;
      invalidateJsonCache("/api/", { cancelPending: true });
      announce(false, true);
      if ((failed && method === "DELETE") || version !== generation) await refreshAdminSession(true);
    }
  })();
  return mutation;
}
export const loginAdmin = (password: string) => changeSession("POST", password);
export const logoutAdmin = () => changeSession("DELETE");

export function subscribeAdminSession(listener: () => void) {
  listeners.add(listener);
  if (!stop) {
    const wake = () => { if (document.visibilityState !== "hidden") void refreshAdminSession(); };
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.source === "admin-session-store") return;
      reset(); void refreshAdminSession(true);
    };
    const storage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) { reset(); announce(false); void refreshAdminSession(true); } };
    window.addEventListener("admin-session-changed", changed);
    window.addEventListener("focus", wake); window.addEventListener("online", wake);
    window.addEventListener("storage", storage); document.addEventListener("visibilitychange", wake);
    stop = () => {
      window.removeEventListener("admin-session-changed", changed);
      window.removeEventListener("focus", wake); window.removeEventListener("online", wake);
      window.removeEventListener("storage", storage); document.removeEventListener("visibilitychange", wake);
      stop = null;
    };
    void refreshAdminSession();
  }
  return () => { listeners.delete(listener); if (!listeners.size) stop?.(); };
}
