"use client";

type CacheEntry<T> = {
  value?: T;
  promise?: Promise<T>;
  expiresAt: number;
};

const jsonCache = new Map<string, CacheEntry<unknown>>();

interface FetchJsonCachedOptions {
  staleMs?: number;
  force?: boolean;
}

export async function fetchJsonCached<T>(
  url: string,
  { staleMs = 30_000, force = false }: FetchJsonCachedOptions = {}
): Promise<T> {
  const now = Date.now();
  const cached = jsonCache.get(url) as CacheEntry<T> | undefined;

  if (!force && cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }

  if (!force && cached?.promise) {
    return cached.promise;
  }

  const promise = fetch(url, { cache: force ? "no-store" : "default" })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || data.message || `Request failed: ${response.status}`);
      }
      jsonCache.set(url, {
        value: data as T,
        expiresAt: Date.now() + staleMs,
      });
      return data as T;
    })
    .catch((error) => {
      jsonCache.delete(url);
      throw error;
    });

  jsonCache.set(url, {
    promise,
    expiresAt: now + staleMs,
  });

  return promise;
}

export function invalidateJsonCache(prefix?: string) {
  if (!prefix) {
    jsonCache.clear();
    return;
  }

  for (const key of jsonCache.keys()) {
    if (key.startsWith(prefix)) {
      jsonCache.delete(key);
    }
  }
}
