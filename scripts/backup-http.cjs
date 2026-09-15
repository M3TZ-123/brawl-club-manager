const { setTimeout: sleep } = require("node:timers/promises");
function backupClient(env = process.env, fetchImpl = fetch) {
  const base = new URL(env.VERCEL_APP_URL || "");
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error("Backup endpoint must use HTTPS");
  if (!env.CRON_SECRET) throw new Error("CRON_SECRET is required");
  return async function call(params, body) {
    const url = new URL("/api/backups", base);
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 5; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(65000),
          headers: { Authorization: `Bearer ${env.CRON_SECRET}`, ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch {
        if (attempt === 4) throw new Error("Backup endpoint could not be reached");
        await sleep(Math.min(1000 * 2 ** attempt, 8000)); continue;
      }
      if (response.ok) return response.json();
      if (attempt === 4 || ![409, 429, 502, 503, 504].includes(response.status)) throw new Error(`Backup endpoint returned HTTP ${response.status}`);
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
    }
  };
}
module.exports = { backupClient };
