"use client";

import { fetchJsonWithTimeout } from "@/lib/client-fetch";

type CacheEntry = {
  value?: unknown;
  promise?: Promise<unknown>;
  expiresAt: number;
  refreshQueued: boolean;
  controller?: AbortController;
};
const jsonCache = new Map<string, CacheEntry>();
interface FetchJsonCachedOptions { staleMs?: number; force?: boolean; timeoutMs?: number }

export function fetchJsonCached<T>(url: string, { staleMs = 30_000, force = false, timeoutMs = 15_000 }: FetchJsonCachedOptions = {}): Promise<T> {
  const cached = jsonCache.get(url);
  if (cached?.promise) {
    // A data-change signal needs one read after the current one, not parallel
    // requests. Every waiter receives the final accepted response.
    if (force) cached.refreshQueued = true;
    return cached.promise as Promise<T>;
  }
  if (!force && cached?.value !== undefined && cached.expiresAt > Date.now()) return Promise.resolve(cached.value as T);
  const entry: CacheEntry = { expiresAt: 0, refreshQueued: false, controller: new AbortController() };
  jsonCache.set(url, entry);
  entry.promise = (async () => {
    let bypass = force;
    try {
      for (;;) {
        entry.refreshQueued = false;
        let value: T;
        try { value = await fetchJsonWithTimeout<T>(url, { cache: bypass ? "no-store" : "default", signal: entry.controller!.signal }, timeoutMs); }
        catch (error) {
          if (entry.refreshQueued && !entry.controller!.signal.aborted) { bypass = true; continue; }
          throw error;
        }
        if (entry.refreshQueued && !entry.controller!.signal.aborted) { bypass = true; continue; }
        if (jsonCache.get(url) === entry) { entry.value = value; entry.expiresAt = Date.now() + staleMs; }
        return value;
      }
    } catch (error) {
      if (jsonCache.get(url) === entry) jsonCache.delete(url);
      throw error;
    } finally { entry.promise = undefined; entry.controller = undefined; }
  })();
  return entry.promise as Promise<T>;
}

// Club changes invalidate API data; independently cached external catalogs stay
// intact. Authentication boundaries additionally cancel old-session requests.
export function invalidateJsonCache(prefix = "/api/", { cancelPending = false }: { cancelPending?: boolean } = {}) {
  for (const [key, entry] of jsonCache) {
    if (!key.startsWith(prefix)) continue;
    if (entry.promise && !cancelPending) { delete entry.value; entry.expiresAt = 0; entry.refreshQueued = true; }
    else { jsonCache.delete(key); entry.controller?.abort(); }
  }
}
