export const candidateStatuses = ["watching", "shortlisted", "contacted", "joined", "archived"] as const;
export type CandidateStatus = typeof candidateStatuses[number];
export type CandidateProfile = { name: string; trophies: number; highestTrophies: number; brawlers: number; power11: number; rank: string | null; rankedPoints: number | null; clubName: string | null };
export type Candidate = { player_tag: string; status: CandidateStatus; notes: string; version: number; created_at: string; updated_at: string; profile: CandidateProfile | null; profile_checked_at: string | null };
export class CandidateInputError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function candidateTag(value: unknown) {
  const raw = typeof value === "string" ? value.trim().toUpperCase().replace(/^#/, "") : "";
  if (!/^[0289PYLQGRJCUV]{2,19}$/.test(raw)) throw new CandidateInputError("Provide a valid Brawl Stars player tag");
  return `#${raw}`;
}
export function candidateInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CandidateInputError("Invalid candidate");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["player_tag", "status", "notes", "version"].includes(key))) throw new CandidateInputError("Invalid candidate");
  if (!(candidateStatuses as readonly unknown[]).includes(row.status) || typeof row.notes !== "string" || row.notes.length > 1000 || row.notes.includes("\0") || !Number.isSafeInteger(row.version) || Number(row.version) < 0 || Number(row.version) > 2147483646) throw new CandidateInputError("Invalid candidate");
  return { player_tag: candidateTag(row.player_tag), status: row.status as CandidateStatus, notes: row.notes.trim(), version: row.version as number };
}
export function candidateProfile(value: unknown, tag: string): CandidateProfile {
  if (!value || typeof value !== "object") throw new Error("Invalid player profile");
  const row = value as Record<string, unknown>;
  const counter = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 2147483647;
  if (row.tag !== tag || typeof row.name !== "string" || row.name.length < 1 || row.name.length > 160 || !counter(row.trophies) || !counter(row.highestTrophies) || !Array.isArray(row.brawlers) || row.brawlers.length > 300 || row.brawlers.some(b => !counter(b?.power) || b.power < 1 || b.power > 11)) throw new Error("Invalid player profile");
  const club = row.club as {name?: unknown} | undefined;
  return { name: row.name, trophies: row.trophies as number, highestTrophies: row.highestTrophies as number, brawlers: row.brawlers.length,
    power11: row.brawlers.filter(b => b.power === 11).length,
    rank: typeof row.rankedRankName === "string" && row.rankedRankName.length <= 80 ? row.rankedRankName : null,
    rankedPoints: counter(row.rankedElo) ? row.rankedElo as number : null,
    clubName: typeof club?.name === "string" && club.name.length <= 160 ? club.name : null };
}

export function candidateSnapshot(value: unknown): Candidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid candidate snapshot");
  const row = value as Record<string, unknown>;
  const boundedText = (value: unknown, max: number) => {
    if (typeof value !== "string" || value.length > max) throw new Error("Invalid candidate snapshot");
    return value;
  };
  const counter = (value: unknown) => {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 2147483647) throw new Error("Invalid candidate snapshot");
    return value as number;
  };
  const date = (value: unknown) => {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid candidate snapshot");
    return new Date(value).toISOString();
  };
  if (!(candidateStatuses as readonly unknown[]).includes(row.status)) throw new Error("Invalid candidate snapshot");
  let profile: CandidateProfile | null = null;
  if (row.profile != null) {
    if (typeof row.profile !== "object" || Array.isArray(row.profile)) throw new Error("Invalid candidate snapshot");
    const p = row.profile as Record<string, unknown>;
    profile = { name: boundedText(p.name, 160), trophies: counter(p.trophies), highestTrophies: counter(p.highestTrophies),
      brawlers: counter(p.brawlers), power11: counter(p.power11), rank: p.rank == null ? null : boundedText(p.rank, 80),
      rankedPoints: p.rankedPoints == null ? null : counter(p.rankedPoints), clubName: p.clubName == null ? null : boundedText(p.clubName, 160) };
  }
  return { player_tag: candidateTag(row.player_tag), status: row.status as CandidateStatus, notes: boundedText(row.notes, 1000),
    version: counter(row.version), created_at: date(row.created_at), updated_at: date(row.updated_at), profile,
    profile_checked_at: row.profile_checked_at == null ? null : date(row.profile_checked_at) };
}
