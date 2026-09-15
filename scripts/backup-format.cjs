const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { createCipheriv, createDecipheriv, createHash, randomBytes } = require("node:crypto");
const { createGzip, gunzipSync } = require("node:zlib");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const MAGIC = Buffer.from("BRLBKP1\n");
function encryptionKey(value = process.env.BACKUP_ENCRYPTION_KEY) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error("BACKUP_ENCRYPTION_KEY must be a base64 32-byte key");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new Error("Invalid backup encryption key");
  return key;
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function validateManifest(manifest) {
  if (!manifest || manifest.format !== "brawl-backup-v1" || !Array.isArray(manifest.tables) || !Array.isArray(manifest.sequences) || !Array.isArray(manifest.functions)) throw new Error("Unsupported backup manifest");
  const names = new Set();
  for (const table of manifest.tables) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(table.name) || names.has(table.name) || !Array.isArray(table.chunks) || !Array.isArray(table.columns) || !Number.isSafeInteger(table.row_count) || table.row_count < 0) throw new Error("Invalid backup table metadata");
    names.add(table.name);
    for (const [index, chunk] of table.chunks.entries()) {
      if (chunk.index !== index || !Number.isInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > 524288 || !/^[0-9a-f]{64}$/.test(chunk.sha256)) throw new Error("Invalid backup chunk metadata");
    }
  }
}
function verifyChunk(chunk, expected) {
  if (typeof chunk.payload !== "string" || chunk.payload.length > 700000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.payload)) throw new Error("Invalid backup chunk encoding");
  const bytes = Buffer.from(chunk.payload, "base64");
  if (bytes.toString("base64") !== chunk.payload || bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error("Backup chunk integrity check failed");
  return bytes;
}
async function writeEncryptedBackup(manifest, getChunk, output, key) {
  validateManifest(manifest);
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  const digest = createHash("sha256").update(header);
  const partial = `${output}.partial`;
  const handle = await fsp.open(partial, "wx", 0o600);
  await handle.write(header);
  await handle.close();
  async function* records() {
    yield `${JSON.stringify({ kind: "manifest", manifest })}\n`;
    for (const table of manifest.tables) {
      let count = 0;
      for (let offset = 0; offset < table.chunks.length; offset += 4) {
        const batch = table.chunks.slice(offset, offset + 4);
        // Bound both concurrent requests and retained responses. Settle this
        // entire batch on failure so no detached fetch outlives the export.
        const fetched = await Promise.allSettled(batch.map(async expected => getChunk(table.name, expected.index)));
        for (const [index, expected] of batch.entries()) {
          const result = fetched[index];
          if (result.status === "rejected") throw result.reason;
          const chunk = result.value;
          const bytes = verifyChunk(chunk, expected);
          for (const byte of bytes) if (byte === 10) count++;
          yield `${JSON.stringify({ kind: "chunk", table: table.name, index: expected.index, payload: chunk.payload })}\n`;
          // Release each payload before beginning the next bounded batch.
          fetched[index] = null;
        }
      }
      if (count !== table.row_count) throw new Error(`Backup row count mismatch for ${table.name}`);
    }
  }
  try {
    await pipeline(Readable.from(records()), createGzip(), cipher,
      new Transform({ transform(chunk, encoding, callback) { digest.update(chunk); callback(null, chunk); } }),
      fs.createWriteStream(partial, { flags: "a", mode: 0o600 }));
    const tag = cipher.getAuthTag();
    await fsp.appendFile(partial, tag);
    digest.update(tag);
    // link is atomic and refuses to overwrite an existing completed artifact.
    await fsp.link(partial, output);
    await fsp.unlink(partial);
    return { snapshot_id: manifest.snapshot_id, artifact_sha256: digest.digest("hex"), tables: manifest.tables.length,
      rows: manifest.tables.reduce((total, table) => total + table.row_count, 0) };
  } catch (error) { await fsp.rm(partial, { force: true }); throw error; }
}
async function readEncryptedBackup(filename, key) {
  // Decrypt/authenticate completely before returning any SQL or row payload.
  // A corrupt tag must never cause even a partial restore.
  const file = await fsp.readFile(filename);
  if (file.length < 36 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid backup file header");
  const header = file.subarray(0, 20);
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(8));
  decipher.setAAD(header);
  decipher.setAuthTag(file.subarray(-16));
  let compressed;
  try { compressed = Buffer.concat([decipher.update(file.subarray(20, -16)), decipher.final()]); }
  catch { throw new Error("Backup authentication failed: wrong key or corrupted ciphertext"); }
  const plain = gunzipSync(compressed, { maxOutputLength: 1024 * 1024 * 1024 });
  const records = plain.toString("utf8").trimEnd().split("\n");
  const first = JSON.parse(records.shift());
  if (first.kind !== "manifest") throw new Error("Missing backup manifest");
  const manifest = first.manifest;
  validateManifest(manifest);
  const chunks = new Map();
  for (const record of records) {
    const chunk = JSON.parse(record);
    const table = manifest.tables.find(table => table.name === chunk.table);
    const expected = table?.chunks[chunk.index];
    const id = `${chunk.table}:${chunk.index}`;
    if (chunk.kind !== "chunk" || !expected || chunks.has(id)) throw new Error("Unexpected or duplicate backup chunk");
    chunks.set(id, verifyChunk(chunk, expected));
  }
  const tables = new Map();
  for (const table of manifest.tables) {
    const bytes = Buffer.concat(table.chunks.map(chunk => {
      const found = chunks.get(`${table.name}:${chunk.index}`);
      if (!found) throw new Error("Missing backup chunk");
      return found;
    }));
    let count = 0;
    for (const byte of bytes) if (byte === 10) count++;
    if (count !== table.row_count || (bytes.length && bytes[bytes.length - 1] !== 10)) throw new Error(`Invalid backup row count for ${table.name}`);
    tables.set(table.name, bytes);
  }
  return { manifest, tables, artifact_sha256: sha256(file) };
}
module.exports = { encryptionKey, sha256, validateManifest, verifyChunk, writeEncryptedBackup, readEncryptedBackup };
