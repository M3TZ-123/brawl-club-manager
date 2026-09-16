"use client";

// The deadline includes reading the JSON body, not just receiving its headers.
export async function fetchJsonWithTimeout<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  let rejectAbort: (reason: Error) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (reason: Error) => { controller.abort(reason); rejectAbort(reason); };
  const externalAbort = () => { const error = new Error("Request cancelled."); error.name = "AbortError"; abort(error); };
  const timer = setTimeout(() => { const error = new Error("Request timed out. Please try again."); error.name = "TimeoutError"; abort(error); }, timeoutMs);
  init.signal?.addEventListener("abort", externalAbort, { once: true });
  if (init.signal?.aborted) externalAbort();
  try {
    return await Promise.race([
      cancelled,
      fetch(url, { ...init, signal: controller.signal }).then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || data?.message || `Request failed: ${response.status}`);
        return data as T;
      }),
    ]);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", externalAbort);
  }
}
