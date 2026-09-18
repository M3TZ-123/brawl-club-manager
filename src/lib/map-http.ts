import "server-only";

const CATALOG_URL = "https://api.brawlapi.com/v1/maps";
const TOKEN_URL = "https://brawltime.ninja/api/auth.getToken";
const CUBE_URL = "https://cube.brawltime.ninja/cubejs-api/v1/load";
type MapFailureReason = "http" | "network" | "invalid_data" | "too_large" | "timeout" | "pending";
export class MapProviderError extends Error {
  constructor(public stage: "catalog" | "token" | "stats" | "work", public reason: MapFailureReason, public status: number | null = null) {
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
export async function mapProviderJson(kind: "catalog" | "token" | "stats", signal: AbortSignal, query?: string, token?: string): Promise<unknown> {
  let url = kind === "catalog" ? CATALOG_URL : kind === "token" ? TOKEN_URL : `${CUBE_URL}?query=${encodeURIComponent(query || "")}`;
  const maximum = kind === "catalog" ? 1_500_000 : kind === "token" ? 65_536 : 8_000_000;
  if (kind === "stats" && (!query || query.length > 30_000 || !token || token.length > 16_384)) throw new MapProviderError(kind, "invalid_data");
  // Match Cube's transport: long queries use JSON POST, avoiding URL limits in
  // proxies. The query remains an object inside the envelope, not a JSON string.
  let body: string | undefined = kind === "token" ? '{"json":null}' : undefined;
  if (kind === "stats" && url.length >= 2000) {
    try { body = JSON.stringify({ query: JSON.parse(query!) }); } catch { throw new MapProviderError(kind, "invalid_data"); }
    url = CUBE_URL;
  }
  let response: Response;
  try {
    response = await fetch(url, { method: body === undefined ? "GET" : "POST", cache: "no-store", redirect: "error", signal,
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(kind === "stats" ? { Authorization: token! } : {}) },
      ...(body === undefined ? {} : { body }) });
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

function waitForCube(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new MapProviderError("stats", "timeout")); return; }
    const aborted = () => { clearTimeout(timer); reject(new MapProviderError("stats", "timeout")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Cube's successful HTTP response can mean its asynchronous query is pending. */
export async function mapStatisticsJson(signal: AbortSignal, query: string, token: string): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal.aborted) throw new MapProviderError("stats", "timeout");
    const value = await mapProviderJson("stats", signal, query, token);
    if (!value || typeof value !== "object" || (value as { error?: unknown }).error !== "Continue wait") return value;
    if (attempt === 3) throw new MapProviderError("stats", "pending");
    await waitForCube(signal, 500 * 2 ** attempt);
  }
  throw new MapProviderError("stats", "pending");
}
