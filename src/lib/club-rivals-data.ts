import { gameRegions, type GameRegion } from "@/lib/game-data";

export type RivalProfile = { tag: string; name: string; description: string; type: string; badgeId: number | null; trophies: number; rosterTrophies: number; requiredTrophies: number; memberCount: number; medianTrophies: number | null; averageTrophies: number | null; lowestTrophies: number | null; highestTrophies: number | null };
export type RivalSnapshot = { tag: string; profile: RivalProfile | null; fetchedAt: string | null; stale: boolean; refreshing: boolean; history: { at: string; trophies: number; memberCount: number }[] };
export type ClubRankObservation = { tag: string; region: GameRegion; at: string; rank: number | null; trophies: number | null };
export type ClubRivalsResponse = { clubTag: string; rivals: RivalSnapshot[]; ranks: ClubRankObservation[]; rankingAt: string | null; rankingStale: boolean; region: GameRegion };
export class RivalInputError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function clubTagInput(value: unknown): string {
  if (typeof value !== "string") throw new RivalInputError("Enter a valid club tag");
  const tag = value.trim().replace(/^%23/i, "#").toUpperCase();
  const normalized = tag.startsWith("#") ? tag : `#${tag}`;
  if (!/^#[0289PYLQGRJCUV]{2,19}$/.test(normalized)) throw new RivalInputError("Enter a valid club tag");
  return normalized;
}
const count = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 2147483647) throw new Error("Invalid club data");
  return Number(value);
};
const text = (value: unknown, max: number) => { if (typeof value !== "string" || value.length > max) throw new Error("Invalid club data"); return value; };
export function normalizeRivalProfile(value: unknown, expectedTag: string): RivalProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid club data");
  const row = value as Record<string, unknown>;
  if (clubTagInput(row.tag) !== expectedTag || !Array.isArray(row.members) || row.members.length > 30) throw new Error("Invalid club data");
  const tags = new Set<string>();
  const trophies = row.members.map(member => {
    const tag = clubTagInput(member?.tag);
    if (tags.has(tag)) throw new Error("Invalid club data");
    tags.add(tag); return count(member?.trophies);
  }).sort((a,b) => a-b);
  const length = trophies.length;
  return { tag: expectedTag, name: text(row.name,160), description: text(row.description ?? "",1000), type: text(row.type,40), badgeId: row.badgeId == null ? null : count(row.badgeId),
    trophies: count(row.trophies), rosterTrophies: count(trophies.reduce((sum,n)=>sum+n,0)), requiredTrophies: count(row.requiredTrophies), memberCount: length,
    medianTrophies: length ? (trophies[Math.floor((length-1)/2)] + trophies[Math.floor(length/2)])/2 : null,
    averageTrophies: length ? Math.round(trophies.reduce((sum,n)=>sum+n,0)/length) : null,
    lowestTrophies: length ? trophies[0] : null, highestTrophies: length ? trophies[length-1] : null };
}
export function projectRivalProfile(value: unknown, expectedTag: string): RivalProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid club snapshot");
  const r = value as RivalProfile;
  if (clubTagInput(r.tag) !== expectedTag || count(r.memberCount)>30) throw new Error("Invalid club snapshot");
  const nullable = (n: unknown) => n == null ? null : count(n);
  if (r.medianTrophies !== null && (typeof r.medianTrophies !== "number" || !Number.isFinite(r.medianTrophies) || r.medianTrophies < 0 || r.medianTrophies > 2147483647)) throw new Error("Invalid club snapshot");
  return {tag:expectedTag,name:text(r.name,160),description:text(r.description,1000),type:text(r.type,40),badgeId:nullable(r.badgeId),trophies:count(r.trophies),rosterTrophies:count(r.rosterTrophies),requiredTrophies:count(r.requiredTrophies),memberCount:r.memberCount,
    medianTrophies:r.medianTrophies,averageTrophies:nullable(r.averageTrophies),lowestTrophies:nullable(r.lowestTrophies),highestTrophies:nullable(r.highestTrophies)};
}
export function rivalRegion(value: unknown): GameRegion {
  if (typeof value !== "string" || !(gameRegions as readonly string[]).includes(value)) throw new RivalInputError("Invalid ranking selection");
  return value as GameRegion;
}
