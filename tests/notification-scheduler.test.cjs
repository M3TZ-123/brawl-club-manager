const test = require("node:test");
const assert = require("node:assert/strict");
const { runDelivery } = require("../scripts/deliver-notifications.cjs");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const env = { VERCEL_APP_URL: "https://example.test", CRON_SECRET: "test-only-token" };

test("notification scheduler uses POST, scheduler credentials, and bounded network retries", async () => {
  const requests = []; const waits = [];
  const result = await runDelivery({ env, sleep: async ms => { waits.push(ms); }, request: async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) throw new Error("untrusted upstream text");
    return Response.json({ suppressed: false, processed: 3, delivered: 2, retried: 1 });
  }});
  assert.equal(result.processed, 3); assert.deepEqual(waits, [10000]);
  assert.equal(requests[1].url.pathname, "/api/sync/deliver"); assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.headers.Authorization, "Bearer test-only-token");
  assert.equal(JSON.parse(requests[1].options.body).suppressDelivery, false);
});

test("notification scheduler supports suppression and rejects configuration failures without retry", async () => {
  await runDelivery({ env: { ...env, NOTIFICATION_DELIVERY_DRY_RUN: "true" }, request: async (_url, options) => {
    assert.equal(JSON.parse(options.body).suppressDelivery, true);
    return Response.json({ suppressed: true, processed: 0, delivered: 0, retried: 0 });
  }});
  let calls = 0;
  await assert.rejects(runDelivery({ env, request: async () => { calls++; return new Response("private server message", { status: 401 }); } }), /HTTP 401/);
  assert.equal(calls, 1);
  await assert.rejects(runDelivery({ env: { ...env, VERCEL_APP_URL: "http://example.test" } }), /HTTPS/);
});

test("notification scheduler exhausts retries without disclosing upstream bodies", async () => {
  let calls = 0;
  await assert.rejects(runDelivery({ env, sleep: async () => {}, request: async () => { calls++; return new Response("secret response", { status: 503 }); } }), error => {
    assert.equal(error.message, "Notification delivery failed after retries (HTTP 503)."); return true;
  });
  assert.equal(calls, 3);
});

test("disabled notifications suppress queued delivery before claims or external requests", async () => {
  const outbox = loadTypeScript("src/lib/sync-outbox.ts", {
    "@/lib/supabase-admin": { supabaseAdmin: { rpc: () => { throw new Error("No claim is permitted while disabled"); } } },
    "@/lib/sync-service": { readSyncSettings: async () => ({ notifications_enabled: "false", discord_webhook: "https://discord.com/api/webhooks/test/token" }), SyncError: Error },
  }, { process: { env: { SYNC_DISABLE_DELIVERY: "false" } } });
  const result = await outbox.deliverSyncOutbox();
  assert.equal(result.suppressed, true); assert.equal(result.processed, 0);
});

test("the final unsuccessful delivery attempt is reported as failed rather than queued again", async () => {
  const outbox = loadTypeScript("src/lib/sync-outbox.ts", {
    "@/lib/supabase-admin": { supabaseAdmin: { rpc: async name => ({ data: name === "claim_notification_outbox" ? [{ id: "message", payload: {}, attempts: 8 }] : true, error: null }) } },
    "@/lib/sync-service": { readSyncSettings: async () => ({ notifications_enabled: "true", discord_webhook: "https://discord.com/api/webhooks/test/token" }), SyncError: Error },
  }, { process: { env: { SYNC_DISABLE_DELIVERY: "false" } }, fetch: async () => new Response(null, { status: 503 }) });
  const result = await outbox.deliverSyncOutbox();
  assert.equal(result.failed, 1); assert.equal(result.retried, 0);
});
