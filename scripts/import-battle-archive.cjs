// Imports battle safety-net archives (*.brlarc) after an outage.
// 1. Download the "battle-archive-*" artifacts from the GitHub Actions runs that
//    cover the outage and unzip them into one folder.
// 2. Run:  node scripts/import-battle-archive.cjs <folder-or-files...>
//    with env BACKUP_ENCRYPTION_KEY, CRON_SECRET and optionally VERCEL_APP_URL.
// Import is insert-only and idempotent: running it twice adds nothing new.
const fs = require("node:fs");
const path = require("node:path");
const { encryptionKey } = require("./backup-format.cjs");
const { decryptArchive } = require("./battle-archive.cjs");

function listFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(input, { recursive: true })) {
        if (String(entry).endsWith(".brlarc")) files.push(path.join(input, String(entry)));
      }
    } else files.push(input);
  }
  return files.sort();
}

async function importArchives(inputs, { env = process.env, request = fetch } = {}) {
  if (!inputs.length) throw new Error("Usage: node scripts/import-battle-archive.cjs <folder-or-.brlarc files>");
  if (!env.CRON_SECRET) throw new Error("Missing CRON_SECRET");
  const key = encryptionKey(env.BACKUP_ENCRYPTION_KEY);
  const base = new URL(env.VERCEL_APP_URL || "https://brawlstatz.vercel.app");
  const files = listFiles(inputs);
  if (!files.length) throw new Error("No .brlarc files found");
  let inserted = 0, received = 0;
  for (const file of files) {
    const archive = decryptArchive(fs.readFileSync(file), key);
    const players = archive.players.filter(p => p.ok !== false).map(p => ({ player_tag: p.player_tag, battlelog: p.battlelog }));
    const response = await request(new URL("/api/sync/archive-import", base), {
      method: "POST", headers: { Authorization: `Bearer ${env.CRON_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ players }), signal: AbortSignal.timeout(90_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Import failed for ${path.basename(file)} (HTTP ${response.status}); earlier files were imported, re-run safely.`);
    inserted += body.inserted || 0; received += body.received || 0;
    console.log(`${path.basename(file)} (captured ${archive.captured_at}): ${body.inserted} new of ${body.received} battles`);
  }
  console.log(`Done: ${inserted} new battles restored from ${files.length} archive(s) (${received} checked).`);
  return { files: files.length, inserted, received };
}

if (require.main === module) importArchives(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { importArchives };
