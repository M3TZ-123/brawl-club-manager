const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { backupClient } = require("./backup-http.cjs");
const { encryptionKey, writeEncryptedBackup } = require("./backup-format.cjs");

async function main() {
  const key = encryptionKey();
  const call = backupClient();
  const output = path.resolve(process.env.BACKUP_OUTPUT || `backup-${new Date().toISOString().replaceAll(":", "-")}.brawlbackup`);
  if (!output.endsWith(".brawlbackup")) throw new Error("BACKUP_OUTPUT must end in .brawlbackup");
  await fs.mkdir(path.dirname(output), { recursive: true });
  const requestFile = `${output}.request.json`;
  let requestId = process.env.BACKUP_REQUEST_ID;
  if (!requestId) {
    try { requestId = JSON.parse(await fs.readFile(requestFile, "utf8")).request_id; }
    catch (error) { if (error.code !== "ENOENT") throw error; requestId = randomUUID(); }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error("Invalid BACKUP_REQUEST_ID");
  await fs.writeFile(requestFile, JSON.stringify({ request_id: requestId }), { mode: 0o600 });
  const begun = await call(null, { action: "begin", request_id: requestId });
  if (begun.status === "complete") throw new Error("Snapshot was already exported; start a new backup request");
  const manifest = await call({ snapshot_id: requestId });
  const receipt = await writeEncryptedBackup(manifest, (table, chunk) => call({ snapshot_id: requestId, table, chunk }), output, key);
  await fs.writeFile(`${output}.receipt.json`, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...receipt, output }));
  // Completion is separate: retain retryable private DB chunks until the
  // offsite artifact upload succeeds and backup-complete.cjs acknowledges it.
}
if (require.main === module) main().catch(() => { console.error("Encrypted backup export failed; private snapshot remains retryable until expiry."); process.exitCode = 1; });
module.exports = { main };
