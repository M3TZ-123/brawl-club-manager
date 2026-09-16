const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { encryptionKey, sha256, writeEncryptedBackup, readEncryptedBackup } = require("../scripts/backup-format.cjs");
const { validateRestoreTarget, validateRestoreConnection } = require("../scripts/restore-backup.cjs");
const next = { NextResponse: { json: (body, init) => Response.json(body, init) } };

test("backup admission contention retries the same request with the bounded existing backoff", async () => {
  const waits=[],requests=[];
  const {backupClient}=loadTypeScript('scripts/backup-http.cjs',{'node:timers/promises':{setTimeout:async ms=>{waits.push(ms);}}});
  const call=backupClient({VERCEL_APP_URL:'https://app.test',CRON_SECRET:'fixture-only'},async(_url,options)=>{
    requests.push(JSON.parse(options.body));return requests.length<3?Response.json({error:'Backup is busy; retry shortly'},{status:409}):Response.json({status:'ready'});
  });
  const body={action:'begin',request_id:'00000000-0000-4000-8000-000000000001'};
  assert.equal((await call(null,body)).status,'ready');assert.deepEqual(waits,[1000,2000]);
  assert.deepEqual(requests,[body,body,body]);
  waits.length=0;let attempts=0;
  const busy=backupClient({VERCEL_APP_URL:'https://app.test',CRON_SECRET:'fixture-only'},async()=>{attempts++;return Response.json({error:'busy'},{status:409});});
  await assert.rejects(busy(null,body),/HTTP 409/);assert.equal(attempts,5);assert.deepEqual(waits,[1000,2000,4000,8000]);
});

test("backup restore refuses remote, general-purpose and connection-override targets", () => {
  for (const target of ["postgres://x:pass@prod.example/brawl_restore_tests", "postgres://x:pass@127.0.0.1/postgres", "postgres://x:pass@127.0.0.1/brawl_restore_tests?host=prod.example", "postgres://x:pass@127.0.0.1/brawl_restore_tests?options=-csearch_path=evil"]) {
    assert.throws(() => validateRestoreTarget(target), /loopback-only/);
  }
  assert.equal(validateRestoreTarget("postgresql://x:pass@127.0.0.1:55432/brawl_backup_tests"), "brawl_backup_tests");
});

test("restore accepts an actual loopback TCP peer despite a container-side bridge address", () => {
  const target = { db: "brawl_backup_restore", encoding: "UTF8", address: "172.18.0.2" };
  for (const peer of ["127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    assert.doesNotThrow(() => validateRestoreConnection(peer, target, "brawl_backup_restore"));
  }
});

test("restore fails closed for nonloopback/missing TCP peers and mismatched database or encoding", () => {
  const target = { db: "brawl_backup_restore", encoding: "UTF8", address: "127.0.0.1" };
  for (const peer of [undefined, null, "", "localhost", "127.0.0.1.example", "172.18.0.2", "10.0.0.1", "203.0.113.5", "2001:db8::1", "::ffff:10.0.0.1"]) {
    assert.throws(() => validateRestoreConnection(peer, target, "brawl_backup_restore"), /local UTF8/);
  }
  assert.throws(() => validateRestoreConnection("127.0.0.1", { ...target, db: "postgres" }, "brawl_backup_restore"), /local UTF8/);
  assert.throws(() => validateRestoreConnection("127.0.0.1", { ...target, encoding: "WIN1252" }, "brawl_backup_restore"), /local UTF8/);
});

test("backup key validation rejects missing, short, and noncanonical keys", () => {
  for (const key of ["", "password", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64")]) assert.throws(() => encryptionKey(key), /key/i);
  assert.equal(encryptionKey(Buffer.alloc(32, 1).toString("base64")).length, 32);
});

function route({ admin = false, scheduler = false, database } = {}) {
  return loadTypeScript("src/app/api/backups/route.ts", {
    "next/server": next,
    "@/lib/admin-auth": { verifyAdminSession: () => admin },
    "@/lib/scheduler-auth": { isAuthorizedSchedulerRequest: async () => scheduler },
    "@/lib/supabase-admin": { supabaseAdmin: database || { from() { throw new Error("Unauthorized storage access"); }, rpc() { throw new Error("Unauthorized RPC"); } } },
  }, { console: { error() {} } });
}
test("backup metadata and actions require scheduler or admin authentication", async () => {
  const api = route();
  const get = await api.GET(new Request("http://localhost/api/backups?snapshot_id=00000000-0000-4000-8000-000000000001"));
  const post = await api.POST(new Request("http://localhost/api/backups", { method: "POST", body: JSON.stringify({ action: "begin", request_id: "00000000-0000-4000-8000-000000000001" }) }));
  assert.equal(get.status, 401); assert.equal(post.status, 401);
  assert.equal(get.headers.get("cache-control"), "no-store");
});
test("backup begin accepts the scheduler token and rejects cross-origin admin requests", async () => {
  const calls = [];
  const api = route({ scheduler: true, database: { async rpc(name, args) { calls.push({ name, args }); return { data: { snapshot_id: args.p_request_id, status: "ready" }, error: null }; } } });
  const body = JSON.stringify({ action: "begin", request_id: "00000000-0000-4000-8000-000000000001" });
  const response = await api.POST(new Request("http://localhost/api/backups", { method: "POST", body }));
  assert.equal(response.status, 200);
  assert.equal(calls[0].name, "create_backup_snapshot");
  const denied = await route({ admin: true }).POST(new Request("http://localhost/api/backups", { method: "POST", body, headers: { host: "localhost", origin: "https://attacker.example" } }));
  assert.equal(denied.status, 403);
});

function chunkFixture(count) {
  const chunks = Array.from({ length: count }, (_, index) => Buffer.from(`${JSON.stringify({ id: index })}\n`));
  const manifest = { format: "brawl-backup-v1", snapshot_id: "00000000-0000-4000-8000-000000000001", sequences: [], functions: [],
    tables: [{ name: "members", columns: [], row_count: count, chunks: chunks.map((bytes, index) => ({ index, bytes: bytes.length, sha256: sha256(bytes) })) }] };
  return { chunks, manifest };
}

test("backup fetches at most four chunks concurrently and verifies/yields in manifest order", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "brawl-backup-concurrency-"));
  const output = path.join(directory, "ordered.brawlbackup");
  t.after(async () => { await fs.rm(output, { force: true }); await fs.rm(`${output}.partial`, { force: true }); await fs.rmdir(directory); });
  const { chunks, manifest } = chunkFixture(9);
  const key = Buffer.alloc(32, 1);
  let active = 0; let maximum = 0;
  const completed = []; const verified = [];
  await writeEncryptedBackup(manifest, async (table, index) => {
    assert.equal(table, "members");
    maximum = Math.max(maximum, ++active);
    await sleep((4 - index % 4) * 5);
    active--; completed.push(index);
    return { get payload() { if (verified.at(-1) !== index) verified.push(index); return chunks[index].toString("base64"); } };
  }, output, key);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.deepEqual(completed.slice(0, 4), [3, 2, 1, 0]);
  assert.deepEqual(verified, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const restored = await readEncryptedBackup(output, key);
  assert.deepEqual(restored.tables.get("members"), Buffer.concat(chunks));
});

test("a corrupted concurrent chunk rejects once, settles its batch, and leaves no artifact", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "brawl-backup-corruption-"));
  const output = path.join(directory, "invalid.brawlbackup");
  t.after(async () => { await fs.rm(output, { force: true }); await fs.rm(`${output}.partial`, { force: true }); await fs.rmdir(directory); });
  const { chunks, manifest } = chunkFixture(9);
  let active = 0; let rejections = 0;
  const requested = [];
  const exporting = writeEncryptedBackup(manifest, async (table, index) => {
    requested.push(index); active++;
    await sleep((index + 1) * 5);
    active--;
    const bytes = Buffer.from(chunks[index]);
    if (index === 1) bytes[0] ^= 1;
    return { payload: bytes.toString("base64") };
  }, output, Buffer.alloc(32, 1)).catch(error => { rejections++; throw error; });
  await assert.rejects(exporting, /integrity check failed/);
  assert.equal(rejections, 1);
  assert.equal(active, 0);
  assert.deepEqual(requested, [0, 1, 2, 3]);
  await assert.rejects(fs.access(output), error => error.code === "ENOENT");
  await assert.rejects(fs.access(`${output}.partial`), error => error.code === "ENOENT");
});
