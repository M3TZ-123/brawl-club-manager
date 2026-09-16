export type UpstreamProvider = "brawl" | "rnt";

// This protects concurrent calls in one worker. Sync also persists the longest
// cooldown in the database so a new worker cannot bypass an upstream limit.
const cooldownUntil: Record<UpstreamProvider, number> = { brawl: 0, rnt: 0 };

export class UpstreamRateLimitError extends Error {
  readonly status = 429;

  constructor(public readonly provider: UpstreamProvider, public readonly retryAfterMs: number) {
    super("Upstream rate limit: retry after the provider cooldown.");
    this.name = "UpstreamRateLimitError";
  }
}

export function getUpstreamCooldownMs(provider: UpstreamProvider): number {
  return Math.max(0, cooldownUntil[provider] - Date.now());
}

export function parseRetryAfterMs(value: unknown, now = Date.now()): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    // Bound to a representable timestamp, not to the request's shorter budget.
    return Math.min(Math.ceil(Number(text) * 1000), 8.64e15 - now);
  }
  // Numeric junk must not be interpreted as a date by Date.parse (e.g. "-1").
  if (!/[A-Za-z]{3}/.test(text)) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

type HttpError = { response?: { status?: unknown; headers?: unknown }; code?: unknown; name?: unknown };

function httpError(error: unknown): HttpError {
  return error && typeof error === "object" ? error as HttpError : {};
}

function retryAfterHeader(error: unknown): unknown {
  const headers = httpError(error).response?.headers;
  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  if (typeof record.get === "function") return record.get("retry-after");
  const key = Object.keys(record).find((name) => name.toLowerCase() === "retry-after");
  return key ? record[key] : undefined;
}

function abortError(): Error {
  const error = new Error("Upstream request aborted.");
  error.name = "AbortError";
  return error;
}

function timeoutError(): Error {
  const error = new Error("Upstream request deadline exceeded.");
  error.name = "TimeoutError";
  return error;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { cleanup(); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, delayMs));
  });
}

export interface UpstreamRetryOptions {
  provider: UpstreamProvider;
  signal?: AbortSignal;
  deadlineAt?: number;
  maxDurationMs?: number;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  retryTransient?: boolean;
}

// Positive jitter never undercuts Retry-After. Each retry has a finite attempt
// count and every request is limited to the time remaining in the caller budget.
export async function callWithUpstreamRetry<T>(
  request: (timeoutMs: number) => Promise<T>,
  options: UpstreamRetryOptions,
): Promise<T> {
  const { provider, signal } = options;
  const maxDuration = Math.min(45_000, Math.max(1, options.maxDurationMs ?? 45_000));
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + maxDuration);
  const maxAttempts = Math.min(3, Math.max(1, Math.trunc(options.maxAttempts ?? 3)));
  const requestTimeout = Math.min(10_000, Math.max(1, options.requestTimeoutMs ?? 10_000));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    checkAbort(signal);
    // Another in-flight call can lengthen the cooldown while this call sleeps.
    while (getUpstreamCooldownMs(provider) > 0) {
      const remainingCooldown = getUpstreamCooldownMs(provider);
      if (remainingCooldown >= deadlineAt - Date.now()) {
        throw new UpstreamRateLimitError(provider, remainingCooldown);
      }
      await abortableSleep(remainingCooldown, signal);
      checkAbort(signal);
    }
    const remainingBudget = deadlineAt - Date.now();
    if (remainingBudget <= 0) throw timeoutError();
    try {
      return await request(Math.min(requestTimeout, remainingBudget));
    } catch (error) {
      const { response, code, name } = httpError(error);
      const status = response?.status;
      const backoff = 1000 * 2 ** attempt;
      const delayMs = backoff + Math.floor(Math.random() * backoff * 0.25);
      if (status === 429) {
        const now = Date.now();
        const retryAfterMs = Math.max(delayMs, parseRetryAfterMs(retryAfterHeader(error), now) ?? 0);
        cooldownUntil[provider] = Math.max(cooldownUntil[provider], now + retryAfterMs);
        if (attempt + 1 === maxAttempts || getUpstreamCooldownMs(provider) >= deadlineAt - Date.now()) {
          throw new UpstreamRateLimitError(provider, getUpstreamCooldownMs(provider));
        }
        // The next iteration consults the shared deadline before making a call.
        continue;
      }
      checkAbort(signal);
      if (name === "AbortError" || code === "ERR_CANCELED") throw abortError();
      const transient = status == null || (typeof status === "number" && status >= 500);
      if (!options.retryTransient || !transient || attempt + 1 === maxAttempts) throw error;
      if (delayMs >= deadlineAt - Date.now()) throw timeoutError();
      await abortableSleep(delayMs, signal);
    }
  }
  throw timeoutError();
}
