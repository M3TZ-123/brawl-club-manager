import "server-only";
import { unstable_cache } from "next/cache";
import { loadGameData } from "./game-cache";
import { projectGameSnapshot, type GameEvent } from "./game-data";
import { boundedMapWork, mapProviderJson, mapStatisticsJson, MapProviderError } from "./map-http";
import { MAP_CATALOG_SOURCE, mapMinTrophies, normalizeMapCatalog, validMapId, type MapEnrichment, type MapSnapshot, type MapTrophyRange } from "./map-data";
import { MAP_STATS_SOURCE, mapStatisticsPeriod, mapStatisticsQuery, normalizeMapStatistics, type MapTarget } from "./map-statistics";

const SUCCESS_SECONDS = 3600, RETRY_SECONDS = 300;
type Saved<T> = { data: T; fetchedAt: string };
let token: { value: string; expiresAt: number } | null = null;
let pendingToken: Promise<string> | null = null;
const pendingSnapshots = new Map<MapTrophyRange, Promise<MapSnapshot>>();
const cooldowns = new Map<string, number>();
const pendingRefreshes = new Map<string, Promise<unknown>>();

// Next shares successful entries across workers. Retry state and in-flight
// coalescing are per worker; they are deliberately not a distributed lease.
async function refresh<T>(key: string, work: () => Promise<T>): Promise<T> {
  const pending = pendingRefreshes.get(key);
  if (pending) return pending as Promise<T>;
  if ((cooldowns.get(key) ?? 0) > Date.now()) throw new Error("Map data temporarily unavailable");
  const request = work().then(result => {
    cooldowns.delete(key);
    return result;
  }).catch((error: unknown) => {
    // Targets come only from the official rotation; cap old period/rotation keys.
    if (cooldowns.size >= 8) cooldowns.delete(cooldowns.keys().next().value!);
    cooldowns.set(key, Date.now() + RETRY_SECONDS * 1000);
    const fallbackStage = key === "catalog" ? "catalog" : "stats";
    // Only allowlisted diagnostics enter server logs. Never log the cache key,
    // raw exception, response body, query, URL or anonymous authentication token.
    console.warn("Map provider refresh failed", {
      stage: error instanceof MapProviderError && error.stage !== "work" ? error.stage : fallbackStage,
      reason: error instanceof MapProviderError ? error.reason : "invalid_data",
      status: error instanceof MapProviderError ? error.status : null,
    });
    throw new Error("Map data temporarily unavailable");
  }).finally(() => { if (pendingRefreshes.get(key) === request) pendingRefreshes.delete(key); });
  pendingRefreshes.set(key, request);
  return request;
}

async function anonymousToken(signal: AbortSignal): Promise<string> {
  if (token && token.expiresAt > Date.now() + 300_000) return token.value;
  if (pendingToken) return pendingToken;
  const request = mapProviderJson("token", signal).then(value => {
    const data = (value as { result?: { data?: { json?: { token?: unknown; expiresAt?: unknown } } } })?.result?.data?.json;
    const expiry = typeof data?.expiresAt === "number" ? data.expiresAt : typeof data?.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
    if (typeof data?.token !== "string" || !data.token || data.token.length > 16_384 || !Number.isFinite(expiry) || expiry <= Date.now()) throw new MapProviderError("token", "invalid_data");
    token = { value: data.token, expiresAt: expiry };
    return data.token;
  }).finally(() => { if (pendingToken === request) pendingToken = null; });
  pendingToken = request;
  return request;
}

// Do not nest unstable_cache calls: Next bypasses nested cache reads. Throwing
// from these refresh callbacks lets App Router retain a previous success.
const catalogSuccess = unstable_cache(async (): Promise<Saved<MapEnrichment[]>> => refresh("catalog", () => boundedMapWork(async signal => ({
  data: normalizeMapCatalog(await mapProviderJson("catalog", signal)), fetchedAt: new Date().toISOString(),
}), 6500)), ["map-art-catalog-v1"], { revalidate: SUCCESS_SECONDS });

const statisticsSuccess = unstable_cache(async (targets: MapTarget[], period: { start: string; end: string }, trophyRange: MapTrophyRange) => refresh(JSON.stringify({ targets, period, trophyRange }),
  () => boundedMapWork(async signal => {
    try {
      const auth = await anonymousToken(signal);
      const raw = await mapStatisticsJson(signal, JSON.stringify(mapStatisticsQuery(targets, period, trophyRange)), auth);
      const now = Date.now();
      return { data: normalizeMapStatistics(raw, targets, period, now, trophyRange), fetchedAt: new Date(now).toISOString() };
    } catch (error) { token = null; throw error; }
  }, 10_000)), ["map-ninja-statistics-v1"], { revalidate: SUCCESS_SECONDS });

async function readMaps(trophyRange: MapTrophyRange): Promise<MapSnapshot> {
  const minTrophies = mapMinTrophies(trophyRange);
  const [art, rotation] = await Promise.all([
    catalogSuccess().catch(() => null), boundedMapWork(async () => loadGameData("events"), 8000).catch(() => null),
  ]);
  if (!rotation?.data) return { data: null, trophyRange, minTrophies, fetchedAt: art?.fetchedAt ?? null, stale: true, refreshing: false, source: MAP_CATALOG_SOURCE };
  const events = projectGameSnapshot("events", rotation.data) as GameEvent[];
  const targets = [...new Map(events.filter(event => validMapId(event.id)).map(event => [`${event.id}:${event.mode}`, { mapId: event.id, mode: event.mode, name: event.map }])).values()]
    .sort((a, b) => a.mapId - b.mapId || a.mode.localeCompare(b.mode));
  if (!targets.length) return { data: [], trophyRange, minTrophies, fetchedAt: art?.fetchedAt ?? null, stale: rotation.stale || !art, refreshing: rotation.refreshing, source: MAP_CATALOG_SOURCE };
  const period = mapStatisticsPeriod(Date.now()), stats = await statisticsSuccess(targets, period, trophyRange).catch(() => null);
  const now = Date.now(), oldArt = !art || now - Date.parse(art.fetchedAt) >= SUCCESS_SECONDS * 1000;
  const oldStats = !stats || now - Date.parse(stats.fetchedAt) >= SUCCESS_SECONDS * 1000;
  const catalog = new Map((art?.data || []).map(row => [`${row.mapId}:${row.mode}`, row]));
  const statistics = new Map((stats?.data || []).map(row => [`${row.mapId}:${row.mode}`, row]));
  const data: MapEnrichment[] = targets.map(target => {
    const key = `${target.mapId}:${target.mode}`, image = catalog.get(key), observed = statistics.get(key);
    return { ...target, minTrophies, imageUrl: image?.imageUrl ?? null, sourceUrl: image?.sourceUrl ?? null,
      statsSource: observed ? MAP_STATS_SOURCE : null, statsStatus: !observed ? "unavailable" : oldStats ? "stale" : "available",
      winRateKind: observed?.winRateKind ?? null, statsUpdatedAt: observed?.statsUpdatedAt ?? null, statsFetchedAt: observed ? stats!.fetchedAt : null,
      statsPeriod: observed?.statsPeriod ?? null, sampleSize: observed?.sampleSize ?? null, sampleUnit: observed?.sampleUnit ?? null, brawlers: observed?.brawlers ?? [] };
  });
  return { data, trophyRange, minTrophies, fetchedAt: art?.fetchedAt ?? null, stale: rotation.stale || oldArt || oldStats || data.some(row => row.statsStatus === "unavailable"), refreshing: rotation.refreshing, source: MAP_CATALOG_SOURCE };
}

export function loadMapSnapshot(trophyRange: MapTrophyRange = "1000"): Promise<MapSnapshot> {
  mapMinTrophies(trophyRange); // Validate even callers outside the HTTP route.
  const pending = pendingSnapshots.get(trophyRange);
  if (pending) return pending;
  const request = readMaps(trophyRange).finally(() => { if (pendingSnapshots.get(trophyRange) === request) pendingSnapshots.delete(trophyRange); });
  pendingSnapshots.set(trophyRange, request);
  return request;
}
