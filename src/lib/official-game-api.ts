import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { callWithUpstreamRetry, getUpstreamCooldownMs, UpstreamRateLimitError } from "@/lib/upstream-rate-limit";

// Existing official-key proxy; this module never accepts a caller-provided host/path.
export async function officialGameRequest(path: string, signal?: AbortSignal): Promise<unknown> {
  if (!/^\/(events\/rotation|rankings\/(global|TN|DZ|MA|FR|EG|SA|US)\/(players|clubs)\?limit=50|(players|clubs)\/%23[0289PYLQGRJCUV]{2,19})$/.test(path)) throw new Error("Invalid official API path");
  const settings = await supabaseAdmin.from("settings").select("key,value").in("key", ["api_key", "sync_upstream_cooldown_until"]).abortSignal(signal ?? AbortSignal.timeout(2000));
  if (settings.error) throw new Error("Game data temporarily unavailable");
  const values = Object.fromEntries((settings.data || []).map(row => [row.key, row.value]));
  const cooldown = Date.parse(values.sync_upstream_cooldown_until || "") - Date.now();
  if (cooldown > 0) throw new UpstreamRateLimitError("brawl", cooldown);
  const key = values.api_key || process.env.BRAWL_API_KEY;
  if (!key) throw new Error("Game data temporarily unavailable");
  try {
    return await callWithUpstreamRetry(async timeoutMs => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetch(`https://bsproxy.royaleapi.dev/v1${path}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw { response: { status: response.status, headers: response.headers } };
      return response.json();
    }, { provider: "brawl", signal, maxAttempts: 1, maxDurationMs: 8000, requestTimeoutMs: 8000 });
  } catch {
    const retry = getUpstreamCooldownMs("brawl");
    if (retry > 0) await supabaseAdmin.rpc("defer_sync_upstream", { p_provider: "brawl", p_until: new Date(Date.now() + retry).toISOString() });
    // Never expose response/request objects containing the API key.
    throw new Error("Game data temporarily unavailable");
  }
}
