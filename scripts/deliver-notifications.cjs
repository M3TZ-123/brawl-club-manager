const { setTimeout: delay } = require("node:timers/promises");

async function runDelivery({ env = process.env, request = fetch, sleep = delay } = {}) {
  const base = new URL(env.VERCEL_APP_URL || "https://brawlstatz.vercel.app");
  if (base.protocol !== "https:" || base.username || base.password) throw new Error("VERCEL_APP_URL must be a credential-free HTTPS URL.");
  if (!env.CRON_SECRET) throw new Error("Missing CRON_SECRET.");
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await request(new URL("/api/sync/deliver", base), {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CRON_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ suppressDelivery: env.NOTIFICATION_DELIVERY_DRY_RUN === "true" }),
        signal: AbortSignal.timeout(65_000),
      });
    } catch {
      if (attempt === 2) throw new Error("Notification delivery endpoint was unavailable after network retries.");
      await sleep(10_000);
      continue;
    }
    const body = await response.json().catch(() => ({}));
    if (response.ok && typeof body.suppressed === "boolean" && Number.isInteger(body.processed) && body.processed >= 0
      && Number.isInteger(body.delivered) && Number.isInteger(body.retried)) {
      console.log(body.suppressed ? "Notification delivery is disabled or suppressed."
        : `Notification outbox processed ${body.processed}; delivered ${body.delivered}; queued for retry ${body.retried}; failed ${body.failed ?? 0}.`);
      return body;
    }
    if ([400, 401, 403].includes(response.status)) throw new Error(`Notification delivery configuration rejected (HTTP ${response.status}).`);
    if (attempt === 2) throw new Error(`Notification delivery failed after retries (HTTP ${response.status}).`);
    // The database worker lease prevents another request from claiming active
    // deliveries when a response is lost; expired claims recover on a later run.
    await sleep(10_000);
  }
}

if (require.main === module) runDelivery().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { runDelivery };
