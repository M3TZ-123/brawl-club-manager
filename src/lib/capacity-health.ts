import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type CapacityHealth = {
  usedBytes: number | null;
  budgetBytes: number | null;
  percent: number | null;
  level: "ok" | "warning" | "critical" | "unknown";
  sampledAt: string | null;
  stale: boolean;
};

const unknownHealth = (): CapacityHealth => ({
  usedBytes: null, budgetBytes: null, percent: null, level: "unknown", sampledAt: null, stale: true,
});

function byteCount(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

// Admin-only callers may expose this object. Never merge it into public status.
// The configured budget is an operational assumption, not a provider quota API.
export async function readCapacityHealth(now = Date.now()): Promise<CapacityHealth> {
  try {
    if (!Number.isFinite(now)) return unknownHealth();
    const { data, error } = await supabaseAdmin.from("capacity_samples")
      .select("sampled_at,database_bytes,budget_bytes,level")
      .order("sampled_at", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return unknownHealth();
    const usedBytes = byteCount(data.database_bytes);
    const budgetBytes = byteCount(data.budget_bytes);
    const sampledAt = typeof data.sampled_at === "string" ? Date.parse(data.sampled_at) : NaN;
    if (usedBytes === null || budgetBytes === null || budgetBytes === 0 || !Number.isFinite(sampledAt) || sampledAt > now) return unknownHealth();
    const percent = usedBytes / budgetBytes * 100;
    const storedLevel = percent >= 90 ? "critical" : percent >= 70 ? "warning" : "normal";
    if (data.level !== storedLevel) return unknownHealth();
    return {
      usedBytes, budgetBytes, percent: Math.round(percent * 10) / 10,
      level: storedLevel === "normal" ? "ok" : storedLevel,
      sampledAt: new Date(sampledAt).toISOString(), stale: now - sampledAt > 2 * 60 * 60 * 1000,
    };
  } catch {
    // Missing schema, permissions and malformed rows all fail closed. Never
    // return or log private database errors through the health endpoint.
    return unknownHealth();
  }
}
