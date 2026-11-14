const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { captureArchive, encryptArchive, decryptArchive } = require("../scripts/battle-archive.cjs");
const { importArchives } = require("../scripts/import-battle-archive.cjs");
const { runScheduled } = require("../scripts/scheduled-sync.cjs");

const keyText = randomBytes(32).toString("base64");
const key = Buffer.from(keyText, "base64");

test("archive round-trips and rejects tampering or a wrong key", () => {
  const bytes = encryptArchive({ version: 1, players: [{ player_tag: "#ABC" }] }, key);
  assert.deepEqual(decryptArchive(bytes, key).players[0].player_tag, "#ABC");
  const tampered = Buffer.from(bytes); tampered[tampered.length - 20] ^= 1;
  assert.throws(() => decryptArchive(tampered, key));
  assert.throws(() => decryptArchive(bytes, randomBytes(32)));
});

test("capture stores each member's battle log and import posts it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-"));
  const api = async (url) => {
    if (String(url).includes("/clubs/")) return Response.json({ members: [{ tag: "#P1", name: "One", role: "member", trophies: 1 }, { tag: "#P2", name: "Two", role: "member", trophies: 2 }] });
    if (String(url).includes("%23P2")) return new Response("", { status: 500 });
    return Response.json({ items: [{ battleTime: "20261114T100000.000Z", battle: { result: "victory" }, event: {} }] });
  };
  const result = await captureArchive({ env: { BRAWL_API_KEY: "k", CLUB_TAG: "#2PP0Q8", BACKUP_ENCRYPTION_KEY: keyText, ARCHIVE_DIR: dir }, request: api });
  assert.equal(result.members, 2);
  assert.equal(result.battles, 1);
  assert.equal(result.failed, 1);

  let posted;
  const outcome = await importArchives([dir], { env: { CRON_SECRET: "s", BACKUP_ENCRYPTION_KEY: keyText }, request: async (url, options) => {
    assert.match(String(url), /\/api\/sync\/archive-import$/);
    assert.equal(options.headers.Authorization, "Bearer s");
    posted = JSON.parse(options.body);
    return Response.json({ inserted: 1, received: 1 });
  } });
  assert.equal(outcome.inserted, 1);
  assert.deepEqual(posted.players.map(p => p.player_tag), ["#P1"]);
});

test("backup scheduler skips while the primary scheduler is fresh and syncs when stale", async () => {
  const env = { CRON_SECRET: "s", SYNC_ONLY_IF_STALE_MINUTES: "25" };
  const now = () => Date.parse("2026-11-14T12:00:00Z");
  let syncCalls = 0;
  const request = (lastFull) => async (url) => {
    if (String(url).endsWith("/api/sync/status")) return Response.json({ lastFullSuccessAt: lastFull });
    syncCalls++;
    return Response.json({ success: true, runId: "r1", synced: 30 });
  };
  assert.deepEqual(await runScheduled({ env, now, request: request("2026-11-14T11:50:00Z"), sleep: async () => {} }), { skipped: true });
  assert.equal(syncCalls, 0);
  await runScheduled({ env, now, request: request("2026-11-14T11:00:00Z"), sleep: async () => {} });
  assert.equal(syncCalls, 1);
});
