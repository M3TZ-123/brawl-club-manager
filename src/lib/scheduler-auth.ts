import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";

function matches(value: string, expected: string | null | undefined): boolean {
  if (!expected?.trim()) return false;
  return timingSafeEqual(
    createHash("sha256").update(value).digest(),
    createHash("sha256").update(expected.trim()).digest()
  );
}

// A dedicated GitHub token can be rotated without changing admin credentials
// or disrupting an existing scheduler that uses CRON_SECRET.
export async function isAuthorizedSchedulerRequest(request: Request): Promise<boolean> {
  const authorization = request.headers.get("authorization")?.trim();
  const token = request.headers.get("x-cron-secret")?.trim()
    || (authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "");
  if (!token || token.length > 512) return false;
  if (matches(token, process.env.CRON_SECRET)) return true;
  const { data, error } = await supabaseAdmin.from("settings")
    .select("value").eq("key", "scheduler_token").maybeSingle();
  return !error && matches(token, data?.value);
}
