// Refresh the small bundled asset index manually when updating game catalogs.
// Runtime pages do not need the full external descriptions/gadgets/star powers.
const fs = require("node:fs/promises");
const path = require("node:path");
(async () => {
  const response = await fetch("https://api.brawlapi.com/v1/brawlers", { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Brawler catalog returned ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.list) || data.list.length < 50) throw new Error("Incomplete brawler catalog");
  const rows = data.list.map(row => {
    if (typeof row.name !== "string" || !Number.isSafeInteger(row.id) || row.id < 16000000) throw new Error("Invalid brawler catalog entry");
    return [row.name, row.id];
  }).sort(([left], [right]) => left.localeCompare(right));
  await fs.writeFile(path.join(__dirname, "../src/lib/brawler-ids.json"), JSON.stringify(Object.fromEntries(rows), null, 2) + "\n");
  console.log(`Updated ${rows.length} brawler asset IDs`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
