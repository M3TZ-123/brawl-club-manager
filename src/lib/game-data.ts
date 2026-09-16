import { normalizeBattleMode } from "@/lib/battle-catalog";

export const gameRegions = ["global", "TN", "DZ", "MA", "FR", "EG", "SA", "US"] as const;
export type GameRegion = typeof gameRegions[number];
export type GameRankingKind = "players" | "clubs";
export type GameEvent = { slotId: number; startTime: string; endTime: string; id: number; mode: string; map: string };
export type GameRanking = { tag: string; name: string; trophies: number; rank: number; memberCount: number | null; clubName: string | null };
export type GameSnapshot<T> = { data: T | null; fetchedAt: string | null; stale: boolean; refreshing: boolean };
export function gameRankingKey(region: string, kind: string): string | null {
  return (gameRegions as readonly string[]).includes(region) && ["players", "clubs"].includes(kind) ? `rankings:${region}:${kind}` : null;
}
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2147483647;
const text = (value: unknown, max = 160) => typeof value === "string" && value.length > 0 && value.length <= max;
function gameTime(value: unknown) {
  if (typeof value !== "string") return null;
  const wire = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  const normalized = wire ? `${wire[1]}-${wire[2]}-${wire[3]}T${wire[4]}:${wire[5]}:${wire[6]}.${(wire[7] || "").padEnd(3, "0")}Z` : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(normalized)) return null;
  const time = Date.parse(normalized);
  // Date.parse normalizes impossible calendar dates (e.g. February30).
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === normalized.slice(0, 19) ? new Date(time).toISOString() : null;
}
export function normalizeGameEvents(value: unknown): GameEvent[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid event rotation");
  return value.map(row => {
    const start = gameTime(row?.startTime), end = gameTime(row?.endTime), event = row?.event;
    if (!start || !end || end <= start || !integer(row?.slotId) || !integer(event?.id) || !text(event?.mode) || !text(event?.map)) throw new Error("Invalid event rotation");
    return { slotId: row.slotId, startTime: start, endTime: end, id: event.id, mode: normalizeBattleMode(event.mode, integer(event.modeId) ? event.modeId : undefined), map: event.map };
  });
}
export function normalizeGameRankings(value: unknown): GameRanking[] {
  const items = value && typeof value === "object" ? (value as {items?: unknown}).items : undefined;
  if (!Array.isArray(items) || items.length > 50) throw new Error("Invalid rankings");
  return items.map(row => {
    if (!/^#[0289PYLQGRJCUV]{2,19}$/.test(row?.tag) || !text(row?.name) || !integer(row?.trophies) || !integer(row?.rank) || row.rank < 1) throw new Error("Invalid rankings");
    return { tag: row.tag, name: row.name, trophies: row.trophies, rank: row.rank,
      memberCount: integer(row.memberCount) ? row.memberCount : null, clubName: text(row.club?.name) ? row.club.name : null };
  });
}

// Stored snapshots use our DTO, not the upstream response envelope. Re-project
// them too so restored or future cache properties never cross the public API.
export function projectGameSnapshot(kind: "events" | "players" | "clubs", value: unknown): GameEvent[] | GameRanking[] {
  if (!Array.isArray(value)) throw new Error("Invalid game snapshot");
  if (kind === "events") return normalizeGameEvents(value.map(row => ({
    slotId: row?.slotId, startTime: row?.startTime, endTime: row?.endTime,
    event: { id: row?.id, mode: row?.mode, map: row?.map },
  })));
  return normalizeGameRankings({ items: value.map(row => ({
    tag: row?.tag, name: row?.name, trophies: row?.trophies, rank: row?.rank,
    memberCount: row?.memberCount, club: { name: row?.clubName },
  })) });
}
