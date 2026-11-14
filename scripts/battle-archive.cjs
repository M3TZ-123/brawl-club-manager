// Battle safety-net archive. Captures every club member's battle log straight
// from the Brawl Stars API (via the RoyaleAPI proxy) without Vercel or Supabase,
// so battles survive an outage of either. The API only keeps each player's last
// 25 battles; run this at least hourly. Output is gzip + AES-256-GCM encrypted
// with BACKUP_ENCRYPTION_KEY because workflow artifacts of a public repo are
// downloadable. Import later with scripts/import-battle-archive.cjs.
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");
const { gzipSync, gunzipSync } = require("node:zlib");
const { encryptionKey } = require("./backup-format.cjs");

const API = "https://bsproxy.royaleapi.dev/v1";
const MAGIC = Buffer.from("BRLARC1\n");

function normalizeTag(value) {
  const tag = String(value || "").trim().toUpperCase().replace(/^%23/, "#");
  const full = tag.startsWith("#") ? tag : `#${tag}`;
  if (!/^#[0-9A-Z]{3,15}$/.test(full)) throw new Error("CLUB_TAG is not a valid tag");
  return full;
}

async function api(pathname, apiKey, { request = fetch, attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await request(`${API}${pathname}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      if (attempt >= attempts) throw new Error(`Network error for ${pathname.split("/")[1]}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (response.ok) return response.json();
    if ([401, 403].includes(response.status)) throw new Error(`Brawl API rejected the key (HTTP ${response.status}). Allow the RoyaleAPI proxy IP 45.79.218.79 on the key.`);
    if (response.status === 404) return null;
    if (attempt >= attempts) throw new Error(`Brawl API HTTP ${response.status}`);
    await new Promise(r => setTimeout(r, response.status === 429 ? 10_000 : 2000 * attempt));
  }
}

function encryptArchive(object, key) {
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(object)))), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

function decryptArchive(bytes, key) {
  if (bytes.length < MAGIC.length + 28 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not a battle archive");
  const header = bytes.subarray(0, MAGIC.length + 12);
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length));
  decipher.setAAD(header);
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  const plain = Buffer.concat([decipher.update(bytes.subarray(header.length, bytes.length - 16)), decipher.final()]);
  return JSON.parse(gunzipSync(plain).toString("utf8"));
}

async function captureArchive({ env = process.env, request = fetch, now = () => new Date() } = {}) {
  const apiKey = env.BRAWL_API_KEY;
  if (!apiKey) throw new Error("Missing BRAWL_API_KEY");
  const key = encryptionKey(env.BACKUP_ENCRYPTION_KEY);
  const clubTag = normalizeTag(env.CLUB_TAG);
  const club = await api(`/clubs/${encodeURIComponent(clubTag)}`, apiKey, { request });
  if (!club || !Array.isArray(club.members)) throw new Error("Club not found or roster unavailable");

  const players = [];
  let failed = 0;
  const queue = [...club.members];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const member = queue.shift();
      try {
        const log = await api(`/players/${encodeURIComponent(member.tag)}/battlelog`, apiKey, { request });
        players.push({ player_tag: member.tag, player_name: member.name, role: member.role, trophies: member.trophies,
          battlelog: { items: Array.isArray(log?.items) ? log.items : [] }, ok: Boolean(log) });
      } catch {
        failed++;
        players.push({ player_tag: member.tag, player_name: member.name, role: member.role, trophies: member.trophies, battlelog: { items: [] }, ok: false });
      }
    }
  }));
  if (players.length && failed === players.length) throw new Error("Every battle log request failed");

  const capturedAt = now().toISOString();
  const archive = { version: 1, club_tag: clubTag, captured_at: capturedAt, players };
  const outDir = env.ARCHIVE_DIR || "battle-archive";
  await fsp.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `battles-${capturedAt.replace(/[:.]/g, "-")}.brlarc`);
  await fsp.writeFile(file, encryptArchive(archive, key), { mode: 0o600, flag: "wx" });
  const battles = players.reduce((n, p) => n + p.battlelog.items.length, 0);
  console.log(`Archived ${battles} battles for ${players.length} members (${failed} failed) -> ${path.basename(file)}`);
  return { file, members: players.length, battles, failed };
}

if (require.main === module) captureArchive().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { captureArchive, encryptArchive, decryptArchive, normalizeTag };
