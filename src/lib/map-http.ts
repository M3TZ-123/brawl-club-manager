import "server-only";

const CATALOG_URL = "https://api.brawlapi.com/v1/maps";
const TOKEN_URL = "https://brawltime.ninja/api/auth.getToken";
const CUBE_URL = "https://cube.brawltime.ninja/cubejs-api/v1/load";

export async function boundedMapWork<T>(work: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(controller.signal), new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Map data temporarily unavailable")); }, milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}

/** No caller-supplied destination, cookies or game credentials enter these requests. */
export async function mapProviderJson(kind: "catalog" | "token" | "stats", signal: AbortSignal, query?: string, token?: string): Promise<unknown> {
  const url = kind === "catalog" ? CATALOG_URL : kind === "token" ? TOKEN_URL : `${CUBE_URL}?query=${encodeURIComponent(query || "")}`;
  const maximum = kind === "catalog" ? 1_500_000 : kind === "token" ? 65_536 : 8_000_000;
  if (kind === "stats" && (!query || query.length > 30_000 || !token || token.length > 16_384)) throw new Error("Invalid map statistics request");
  const response = await fetch(url, { method: kind === "token" ? "POST" : "GET", cache: "no-store", redirect: "error", signal,
    headers: { Accept: "application/json", ...(kind === "token" ? { "Content-Type": "application/json" } : {}), ...(kind === "stats" ? { Authorization: token! } : {}) },
    ...(kind === "token" ? { body: '{"json":null}' } : {}) });
  if (!response.ok || !/application\/json/i.test(response.headers.get("content-type") || "")
    || Number(response.headers.get("content-length") || 0) > maximum || !response.body) throw new Error("Map provider unavailable");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let body = "", bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum || signal.aborted) throw new Error("Invalid map provider response");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
