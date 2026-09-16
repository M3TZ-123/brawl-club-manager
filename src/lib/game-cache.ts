import "server-only";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { officialGameRequest } from "@/lib/official-game-api";
import { gameRankingKey, normalizeGameEvents, normalizeGameRankings, projectGameSnapshot, type GameSnapshot } from "@/lib/game-data";

// Only the 17 allowlisted public cache keys can enter this map. The database lease
// still coordinates different workers; readers in this worker share its result.
const pending = new Map<string, Promise<GameSnapshot<unknown>>>();

export async function loadGameData(kind: "events" | "players" | "clubs", region = "global") {
  const key = kind === "events" ? "events" : gameRankingKey(region, kind);
  if (!key) throw new Error("Invalid ranking selection");
  const existing = pending.get(key);
  if (existing) return existing;
  const request = readGameData(kind, region, key).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

async function readGameData(kind: "events" | "players" | "clubs", region: string, key: string): Promise<GameSnapshot<unknown>> {
  const token = randomUUID();
  const { data: claim, error } = await supabaseAdmin.rpc("claim_game_cache", { p_key: key, p_token: token });
  if (error || !claim || typeof claim.acquired !== "boolean" || !claim.entry || typeof claim.entry !== "object") throw new Error("Game data temporarily unavailable");
  const entry = claim.entry;
  let cached = null;
  try { if (entry.payload != null) cached = projectGameSnapshot(kind, entry.payload); } catch { /* Invalid stored data is unavailable, never public or fresh. */ }
  const fetched = Date.parse(entry.fetched_at || ""), expiry = Date.parse(entry.expires_at || "");
  const snapshot: GameSnapshot<unknown> = { data: cached, fetchedAt: cached !== null && Number.isFinite(fetched) ? new Date(fetched).toISOString() : null,
    stale: cached === null || !Number.isFinite(fetched) || !Number.isFinite(expiry) || expiry <= Date.now(), refreshing: false };
  if (!claim.acquired) return { ...snapshot, refreshing: Date.parse(entry.lease_until || "") > Date.now() };
  try {
    const value = await officialGameRequest(kind === "events" ? "/events/rotation" : `/rankings/${region}/${kind}?limit=50`);
    const payload = kind === "events" ? normalizeGameEvents(value) : normalizeGameRankings(value);
    const done = await supabaseAdmin.rpc("finish_game_cache", { p_key: key, p_token: token, p_payload: payload });
    if (done.error || done.data !== true) throw new Error("Cache refresh not committed");
    return { data: payload, fetchedAt: new Date().toISOString(), stale: false, refreshing: false };
  } catch {
    await supabaseAdmin.rpc("finish_game_cache", { p_key: key, p_token: token });
    return snapshot;
  }
}
