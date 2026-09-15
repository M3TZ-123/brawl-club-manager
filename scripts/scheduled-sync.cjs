const { setTimeout: delay } = require("node:timers/promises");
async function runScheduled({ env = process.env, request = fetch, sleep = delay, now = Date.now } = {}) {
  const base = new URL(env.VERCEL_APP_URL || "https://brawlstatz.vercel.app");
  if (base.protocol !== "https:" || base.username || base.password) throw new Error("VERCEL_APP_URL must be a credential-free HTTPS URL.");
  if (!env.CRON_SECRET) throw new Error("Missing CRON_SECRET.");
  const bucket = Math.floor(now() / 1_800_000);
  const rootKey = `scheduled:${env.GITHUB_RUN_ID || bucket}:${bucket}`;
  let key = rootKey;
  for (let attempt = 0; attempt < 4; attempt++) {
    let response;
    try {
      response = await request(new URL("/api/sync", base), {
        method: "GET", headers: { Authorization: `Bearer ${env.CRON_SECRET}`, "Idempotency-Key": key },
        signal: AbortSignal.timeout(70_000),
      });
    } catch {
      if (attempt === 3) throw new Error("Sync request failed after network retries.");
      await sleep(45_000);
      continue; // The same ID resolves an ambiguous network result safely.
    }
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.success === true && body.runId) {
      console.log(`Sync succeeded; run ${body.runId}; members ${body.synced ?? 0}.`);
      return body;
    }
    if ([401,403,400].includes(response.status)) throw new Error(`Sync configuration rejected (HTTP ${response.status}).`);
    if (attempt === 3) throw new Error(`Sync failed after retries (HTTP ${response.status}, code ${String(body.code || "unknown").replace(/[^a-z_]/gi,"").slice(0,60)}).`);
    // A confirmed terminal failure needs a new operation ID. A busy or unknown
    // result keeps its original ID so the server cannot duplicate a commit.
    if (body.code && !["sync_busy","database_unavailable"].includes(body.code)) key = `${rootKey}:retry${attempt + 1}`;
    await sleep(45_000);
  }
}
if (require.main === module) runScheduled().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { runScheduled };
