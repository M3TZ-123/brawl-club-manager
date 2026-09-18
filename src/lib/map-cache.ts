import "server-only";
import { unstable_cache } from "next/cache";
import { loadGameData } from "./game-cache";
import { projectGameSnapshot, type GameEvent } from "./game-data";
import { boundedMapWork, mapProviderJson, MapProviderError } from "./map-http";
import { MAP_CATALOG_SOURCE, parseMapStatsBand, normalizeMapCatalog, validMapId, type MapArtwork, type MapEnrichment, type MapSnapshot, type MapStatsBand } from "./map-data";
import { MAP_STATS_SOURCE, mapBandBrawlers, normalizeMapStatistics } from "./map-statistics";

const SUCCESS_SECONDS = 3600, RETRY_SECONDS = 300;
type Saved<T> = { data: T; fetchedAt: string };
const pendingSnapshots = new Map<MapStatsBand, Promise<MapSnapshot>>();
const cooldowns = new Map<string, number>();
const pendingRefreshes = new Map<string, Promise<unknown>>();

// Next shares successful entries across workers. Retry state and in-flight
// coalescing are per worker; they are deliberately not a distributed lease.
async function refresh<T>(key: "catalog" | "stats", work: () => Promise<T>): Promise<T> {
  const pending = pendingRefreshes.get(key);
  if (pending) return pending as Promise<T>;
  if ((cooldowns.get(key) ?? 0) > Date.now()) throw new Error("Map data temporarily unavailable");
  const request = work().then(result => {
    cooldowns.delete(key);
    return result;
  }).catch((error: unknown) => {
    cooldowns.set(key, Date.now() + RETRY_SECONDS * 1000);
    console.warn("Map provider refresh failed", {
      stage: error instanceof MapProviderError && error.stage !== "work" ? error.stage : key,
      reason: error instanceof MapProviderError ? error.reason : "invalid_data",
      status: error instanceof MapProviderError ? error.status : null,
    });
    throw new Error("Map data temporarily unavailable");
  }).finally(() => { if (pendingRefreshes.get(key) === request) pendingRefreshes.delete(key); });
  pendingRefreshes.set(key, request);
  return request;
}

// Separate, non-nested caches retain their successful values if refresh fails.
const catalogSuccess = unstable_cache(async (): Promise<Saved<MapArtwork[]>> => refresh("catalog", () => boundedMapWork(async signal => ({
  data: normalizeMapCatalog(await mapProviderJson("catalog", signal)), fetchedAt: new Date().toISOString(),
}), 6500)), ["map-art-catalog-v2"], { revalidate: SUCCESS_SECONDS });

// One compact bulk download serves both bands and every official map. Neither
// visiting another card nor switching a band creates a provider request.
const statisticsSuccess = unstable_cache(async () => refresh("stats", () => boundedMapWork(async signal => {
  const raw = await mapProviderJson("stats", signal), now = Date.now();
  return { data: normalizeMapStatistics(raw, now), fetchedAt: new Date(now).toISOString() };
}, 8500)), ["map-brawltools-statistics-v1"], { revalidate: SUCCESS_SECONDS });

async function readMaps(statsBand: MapStatsBand): Promise<MapSnapshot> {
  const [art, rotation] = await Promise.all([
    catalogSuccess().catch(() => null), boundedMapWork(async () => loadGameData("events"), 8000).catch(() => null),
  ]);
  if (!rotation?.data) return { data: null, statsBand, fetchedAt: art?.fetchedAt ?? null, stale: true, refreshing: false, source: MAP_CATALOG_SOURCE };
  const events = projectGameSnapshot("events", rotation.data) as GameEvent[];
  const targets = [...new Map(events.filter(event => validMapId(event.id)).map(event => [`${event.id}:${event.mode}`, { mapId: event.id, mode: event.mode, name: event.map }])).values()]
    .sort((a, b) => a.mapId - b.mapId || a.mode.localeCompare(b.mode));
  if (!targets.length) return { data: [], statsBand, fetchedAt: art?.fetchedAt ?? null, stale: rotation.stale || !art, refreshing: rotation.refreshing, source: MAP_CATALOG_SOURCE };
  const stats = await statisticsSuccess().catch(() => null), now = Date.now();
  const oldArt = !art || now - Date.parse(art.fetchedAt) >= SUCCESS_SECONDS * 1000;
  const sourceTimestamp = stats?.data.sourceTimestamp ?? null;
  const oldStats = !stats || now - Date.parse(stats.fetchedAt) >= SUCCESS_SECONDS * 1000
    || !sourceTimestamp || now - Date.parse(sourceTimestamp) >= SUCCESS_SECONDS * 1000;
  const catalog = new Map((art?.data || []).map(row => [`${row.mapId}:${row.mode}`, row]));
  const statistics = new Map((stats?.data.maps || []).map(row => [row.mapId, row]));
  const data: MapEnrichment[] = targets.map(target => {
    const image = catalog.get(`${target.mapId}:${target.mode}`), candidate = statistics.get(target.mapId);
    // Some new source maps omit mode metadata. In that case only an independent
    // exact ID/name/mode catalog match can establish the missing format.
    const matched = candidate?.name === target.name && (candidate.mode === target.mode
      || (candidate.mode === null && image?.name === target.name));
    const observed = matched ? candidate : null;
    const brawlers = observed ? mapBandBrawlers(observed, statsBand) : null;
    return { ...target, statsBand, imageUrl: image?.imageUrl ?? null, sourceUrl: image?.sourceUrl ?? null,
      statsSource: observed ? MAP_STATS_SOURCE : null, statsStatus: brawlers === null ? "unavailable" : oldStats ? "stale" : "available",
      winRateKind: brawlers === null ? null : "provider", statsUpdatedAt: observed ? sourceTimestamp : null,
      statsFetchedAt: observed ? stats!.fetchedAt : null, statsPeriod: null, mapTotalMatches: observed?.mapTotalMatches ?? null,
      sampleSize: null, sampleUnit: null, brawlers: brawlers ?? [] };
  });
  return { data, statsBand, fetchedAt: art?.fetchedAt ?? null, stale: rotation.stale || oldArt || oldStats || data.some(row => row.statsStatus === "unavailable"), refreshing: rotation.refreshing, source: MAP_CATALOG_SOURCE };
}

export function loadMapSnapshot(statsBand: MapStatsBand = "high"): Promise<MapSnapshot> {
  if (parseMapStatsBand(statsBand) !== statsBand) throw new Error("Invalid statistics band");
  const pending = pendingSnapshots.get(statsBand);
  if (pending) return pending;
  const request = readMaps(statsBand).finally(() => { if (pendingSnapshots.get(statsBand) === request) pendingSnapshots.delete(statsBand); });
  pendingSnapshots.set(statsBand, request);
  return request;
}
