import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertAcceptedClubRoster, requireAcceptedClubRoster } from "@/lib/accepted-club-roster";
import { refreshMegaPigSource } from "@/lib/mega-pig-source-cache";
import type { MegaPigSourcePayload, MegaPigSourceResponse } from "@/lib/mega-pig-source-types";

export class MegaPigSourceInputError extends Error {}
type Row = Record<string, unknown>;
const invalid = (): never => { throw new Error("Invalid Mega Pig source data"); };
const tagPattern = /^#[A-Z0-9]{1,20}$/;
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) return invalid();
  return value;
}
function count(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) return invalid();
  return value;
}
function date(value: unknown, latest = Date.now()): string | null {
  const at = typeof value === "string" && value.length <= 64 ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= latest ? new Date(at).toISOString() : null;
}
function projectPayload(value: unknown, clubTag: string): MegaPigSourcePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const row = value as Row;
  if (row.clubTag !== clubTag || !Array.isArray(row.members) || row.members.length > 30) return invalid();
  const members = row.members.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const member = value as Row, playerTag = text(member.playerTag, 21);
    if (!tagPattern.test(playerTag)) return invalid();
    return { playerTag, playerName: text(member.playerName, 160),
      reportedWins: member.reportedWins === null ? null : count(member.reportedWins, 1000),
      reportedTicketsRemaining: member.reportedTicketsRemaining === null ? null : count(member.reportedTicketsRemaining, 1000) };
  });
  const source = row.source === undefined ? "BrawlAce" : row.source;
  if (source !== "BrawlAce" && source !== "BrawlTools") return invalid();
  const totalWins = count(row.totalWins, 30000);
  const reportedPlayersPlayed = source === "BrawlTools" && row.reportedPlayersPlayed === null
    ? null : count(row.reportedPlayersPlayed, members.length);
  if (source === "BrawlTools" && reportedPlayersPlayed !== null) return invalid();
  const reportedBattlesPlayed = row.reportedBattlesPlayed == null ? null : count(row.reportedBattlesPlayed, 30000);
  if (source === "BrawlAce" && reportedBattlesPlayed !== null) return invalid();
  if (reportedBattlesPlayed !== null && reportedBattlesPlayed < totalWins) return invalid();
  const knownWins = members.reduce((sum, member) => sum + (member.reportedWins ?? 0), 0);
  if (new Set(members.map(member => member.playerTag)).size !== members.length || knownWins > totalWins
    || (members.every(member => member.reportedWins !== null) && knownWins !== totalWins)) return invalid();
  return { clubTag, source, totalWins, reportedPlayersPlayed, reportedBattlesPlayed, members };
}

export async function readMegaPigSource(params: URLSearchParams): Promise<MegaPigSourceResponse> {
  if ([...params.keys()].length) throw new MegaPigSourceInputError("Unexpected Mega Pig source query.");
  const clubTag = await requireAcceptedClubRoster();
  const [cached, roster] = await Promise.all([
    refreshMegaPigSource(clubTag),
    supabaseAdmin.from("member_history").select("player_tag,player_name").eq("is_current_member", true).order("player_tag").limit(31),
  ]);
  if (roster.error || !Array.isArray(roster.data) || roster.data.length > 30) return invalid();
  const now = Date.now();
  const payload = cached.payload == null ? null : projectPayload(cached.payload, clubTag);
  const fetchedAt = date(cached.fetchedAt, now);
  // Never present uncommitted or invalid-time data as a successful observation.
  if (payload && !fetchedAt) return invalid();
  const lookup = new Map(payload?.members.map(member => [member.playerTag, member]) ?? []);
  const members = roster.data.map((row: Row) => {
    const playerTag = text(row.player_tag, 21);
    if (!tagPattern.test(playerTag)) return invalid();
    const source = lookup.get(playerTag);
    return { playerTag, playerName: text(row.player_name, 160),
      reportedWins: source?.reportedWins ?? null, reportedTicketsRemaining: source?.reportedTicketsRemaining ?? null };
  });
  if (new Set(members.map(member => member.playerTag)).size !== members.length) return invalid();
  await assertAcceptedClubRoster(clubTag);
  const sourceName = payload?.source ?? "BrawlTools";
  return {
    clubTag,
    source: { name: sourceName, url: sourceName === "BrawlAce" ? `https://brawlace.com/clubs/${encodeURIComponent(clubTag)}` : "https://brawltools.net", official: false, cycleVerified: false, updatedAt: null },
    status: payload ? (cached.stale || cached.errorCode ? "stale" : "available") : cached.refreshing ? "pending" : "unavailable",
    fetchedAt, lastAttemptAt: date(cached.lastAttemptAt, now), nextCheckAt: date(cached.nextCheckAt, Infinity),
    changedAt: date(cached.changedAt, now), updating: cached.refreshing === true,
    totalWins: payload?.totalWins ?? null, reportedPlayersPlayed: payload?.reportedPlayersPlayed ?? null,
    reportedBattlesPlayed: payload?.reportedBattlesPlayed ?? null,
    matchedMembers: members.filter(member => lookup.has(member.playerTag)).length,
    sourceMembers: payload?.members.length ?? 0, rosterMembers: members.length, members,
  };
}
