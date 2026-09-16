import type { ClubMetadata, ClubSnapshot } from "./club-intelligence-types";

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
const tag = (value: unknown) => typeof value === "string" ? "#" + value.trim().replace(/^%23/i, "#").replace(/^#/, "").toUpperCase() : "";

export function publicClubMetadata(value: unknown): ClubMetadata {
  const row = object(value) || {}, result: ClubMetadata = {};
  for (const field of ["name", "description", "type"] as const) {
    const max = field === "description" ? 1000 : 160;
    if (typeof row[field] === "string" && row[field].length <= max && !row[field].includes("\0") && (field === "description" || row[field].trim())) result[field] = row[field].trim();
  }
  for (const field of ["badgeId", "requiredTrophies"] as const) if (integer(row[field])) result[field] = row[field];
  return result;
}

// This is the complete club endpoint roster, not a total reconstructed from
// individual profile requests collected at different moments. No extra HTTP.
export function normalizeClubSnapshot(value: unknown, clubTag: string): ClubSnapshot | null {
  const club = object(value);
  if (!club || (club.tag !== undefined && tag(club.tag) !== tag(clubTag)) || !Array.isArray(club.members) || club.members.length > 100) return null;
  const members = [], seen = new Set<string>();
  for (const raw of club.members) {
    const member = object(raw); if (!member) return null;
    const playerTag = tag(member.tag);
    if (!/^#[A-Z0-9]{2,20}$/.test(playerTag) || seen.has(playerTag) || typeof member.name !== "string" || !member.name.trim() || member.name.length > 160
      || typeof member.role !== "string" || !member.role.trim() || member.role.length > 160 || !integer(member.trophies)) return null;
    seen.add(playerTag);
    members.push({ tag: playerTag, name: member.name, role: member.role, trophies: member.trophies });
  }
  return { metadata: publicClubMetadata(club), members: members.sort((a, b) => a.tag.localeCompare(b.tag)) };
}
