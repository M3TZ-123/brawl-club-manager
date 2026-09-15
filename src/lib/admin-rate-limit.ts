import "server-only";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { supabaseAdmin } from "@/lib/supabase-admin";

export function adminLoginClientKey(request: Request): string {
  // Generic forwarding headers are attacker-controlled on a directly exposed
  // server. Vercel owns its dedicated header; self-hosted ingress must overwrite
  // the explicitly configured header, never append incoming client values.
  const header = process.env.VERCEL === "1"
    ? "x-vercel-forwarded-for"
    : process.env.ADMIN_TRUSTED_PROXY_IP_HEADER?.trim().toLowerCase();
  const candidate = header ? request.headers.get(header)?.trim() : undefined;
  let client = "shared-unverified-client";
  if (candidate && isIP(candidate)) {
    try {
      client = isIP(candidate) === 6 ? new URL(`http://[${candidate}]/`).hostname : candidate;
    } catch { /* Invalid or scoped IP addresses use the shared safe bucket. */ }
  }
  const secret = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) throw new Error("Admin rate limiting requires configured authentication");
  return createHmac("sha256", secret).update(`admin-login:${client}`).digest("hex");
}

export async function consumeAdminLoginAttempt(request: Request) {
  const { data, error } = await supabaseAdmin.rpc("consume_admin_login_attempt", {
    p_client_key: adminLoginClientKey(request),
  });
  if (error) throw new Error("Admin rate-limit storage is unavailable");
  const result = Array.isArray(data) && data.length === 1 ? data[0] : null;
  if (!result || typeof result.allowed !== "boolean" || !Number.isInteger(result.retry_after) || result.retry_after < 0 || result.retry_after > 600) {
    throw new Error("Invalid admin rate-limit result");
  }
  return { allowed: result.allowed, retryAfter: result.retry_after as number };
}
