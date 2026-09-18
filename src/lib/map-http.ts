import "server-only";

const CATALOG_URL = "https://api.brawlapi.com/v1/maps";
const STATISTICS_URL = "https://api.brawltools.net/maps";
type MapFailureReason = "http" | "network" | "invalid_data" | "too_large" | "timeout";
export class MapProviderError extends Error {
  constructor(public stage: "catalog" | "stats" | "work", public reason: MapFailureReason, public status: number | null = null) {
    super("Map provider unavailable");
    this.name = "MapProviderError";
  }
}

export async function boundedMapWork<T>(work: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(controller.signal), new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new MapProviderError("work", "timeout")); }, milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}

/** No caller-supplied destination, cookies or game credentials enter these requests. */
export async function mapProviderJson(kind: "catalog" | "stats", signal: AbortSignal): Promise<unknown> {
  if (kind !== "catalog" && kind !== "stats") throw new MapProviderError("work", "invalid_data");
  const url = kind === "catalog" ? CATALOG_URL : STATISTICS_URL;
  const maximum = kind === "catalog" ? 1_500_000 : 8_000_000;
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", cache: "no-store", redirect: "error", signal, headers: { Accept: "application/json" } });
  } catch { throw new MapProviderError(kind, signal.aborted ? "timeout" : "network"); }
  if (!response.ok) throw new MapProviderError(kind, "http", response.status);
  if (!/application\/json/i.test(response.headers.get("content-type") || "") || !response.body) throw new MapProviderError(kind, "invalid_data", response.status);
  if (Number(response.headers.get("content-length") || 0) > maximum) throw new MapProviderError(kind, "too_large", response.status);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let content = "", bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) throw new MapProviderError(kind, "too_large", response.status);
      if (signal.aborted) throw new MapProviderError(kind, "timeout", response.status);
      content += decoder.decode(value, { stream: true });
    }
    content += decoder.decode();
    try { return JSON.parse(content); } catch { throw new MapProviderError(kind, "invalid_data", response.status); }
  } catch (error) {
    if (error instanceof MapProviderError) throw error;
    throw new MapProviderError(kind, signal.aborted ? "timeout" : "network", response.status);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
