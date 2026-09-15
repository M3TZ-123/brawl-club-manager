const fs = require("node:fs/promises");
const { backupClient } = require("./backup-http.cjs");
const { sha256 } = require("./backup-format.cjs");
async function main() {
  const filename = process.env.BACKUP_OUTPUT;
  if (!filename) throw new Error("BACKUP_OUTPUT is required");
  const receipt = JSON.parse(await fs.readFile(`${filename}.receipt.json`, "utf8"));
  if (sha256(await fs.readFile(filename)) !== receipt.artifact_sha256) throw new Error("Artifact hash no longer matches its receipt");
  await backupClient()(null, { action: "complete", snapshot_id: receipt.snapshot_id, artifact_sha256: receipt.artifact_sha256 });
  console.log(JSON.stringify({ snapshot_id: receipt.snapshot_id, completed: true }));
}
if (require.main === module) main().catch(() => { console.error("Backup completion failed; retry after confirming offsite upload."); process.exitCode = 1; });
module.exports = { main };
