import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readSyncSettings, SyncError } from "@/lib/sync-service";

export async function deliverSyncOutbox(suppressDelivery = false) {
  if (suppressDelivery || process.env.SYNC_DISABLE_DELIVERY === "true") return { suppressed: true, processed: 0, delivered: 0, retried: 0, failed: 0 };
  const settings = await readSyncSettings();
  if (settings.notifications_enabled !== "true" || !settings.discord_webhook) return { suppressed: true, processed: 0, delivered: 0, retried: 0, failed: 0 };
  const webhook = new URL(settings.discord_webhook);
  if (webhook.protocol !== "https:" || webhook.hostname !== "discord.com" || !/^\/api\/webhooks\/[^/]+\/[^/]+$/.test(webhook.pathname) || webhook.username || webhook.password) {
    throw new SyncError("invalid_webhook", "Configure a valid Discord webhook before delivering notifications.", 400);
  }
  const worker = randomUUID();
  const { data: rows, error } = await supabaseAdmin.rpc("claim_notification_outbox", { p_worker: worker, p_limit: 10 });
  if (error) throw new SyncError("outbox_unavailable", "Pending notifications could not be claimed.");
  const pending = (rows || []) as Array<{ id: string; payload: unknown; attempts: number }>;
  let next = 0; let delivered = 0; let retried = 0; let failed = 0;
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (next < pending.length) {
      const row = pending[next++];
      let success = false; let status: number | null = null; let code: string | null = null; let retry: number | null = null;
      try {
        const response = await fetch(webhook, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(row.payload) });
        status = response.status; success = response.ok;
        if (!success) {
          code = status === 429 ? "http_429" : "http_error";
          const seconds = Number(response.headers.get("retry-after"));
          if (Number.isFinite(seconds) && seconds > 0) retry = Math.min(3600, Math.ceil(seconds));
        }
      } catch { code = "delivery_network_error"; }
      const result = await supabaseAdmin.rpc("complete_notification_outbox", { p_id: row.id, p_worker: worker,
        p_success: success, p_http_status: status, p_error_code: code, p_retry_seconds: retry });
      if (result.error || result.data !== true) throw new SyncError("delivery_outcome_unrecorded", "A notification outcome could not be recorded; its lease will expire for recovery.");
      if (success) delivered++; else if (row.attempts >= 8) failed++; else retried++;
    }
  }));
  if (outcomes.some((outcome) => outcome.status === "rejected")) throw new SyncError("delivery_outcome_unrecorded", "Some delivery outcomes could not be recorded; expired leases will be retried.");
  return { suppressed: false, processed: pending.length, delivered, retried, failed };
}
