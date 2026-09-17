import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertAcceptedClubRoster, ClubRosterUnavailableError, requireAcceptedClubRoster } from "@/lib/accepted-club-roster";
import { buildMemberComparison } from "@/lib/member-comparison";
import type { ComparisonMembershipObservation, ComparisonProfile, MemberComparisonRange, RawComparisonMember, RawMemberComparison } from "@/lib/member-comparison-types";

export class MemberComparisonInputError extends Error {}
type Row = Record<string, unknown>;
const invalid = (): never => { throw new Error("Invalid comparison snapshot"); };
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Row;
}
function rows(value: unknown, max: number): Row[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value.map(object);
}
function text(value: unknown, max = 160): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) return invalid();
  return value;
}
function tag(value: unknown): string {
  const result = text(value, 21);
  if (!/^#[A-Z0-9]{1,20}$/.test(result)) return invalid();
  return result;
}
const number = (value: unknown, max = 2147483647): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
function date(value: unknown, now: Date, future = false): string | null {
  const parsed = typeof value === "string" && value.length <= 64 ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && (future || parsed <= now.getTime()) ? new Date(parsed).toISOString() : null;
}
function profile(value: unknown, now: Date): ComparisonProfile {
  const row = object(value);
  return { trophies: number(row.trophies), trophiesCheckedAt: date(row.trophiesCheckedAt, now),
    power11: number(row.power11, 300), profileCheckedAt: date(row.profileCheckedAt, now),
    rank: typeof row.rank === "string" ? text(row.rank, 80) : null, rankedPoints: number(row.rankedPoints),
    rankedSeasonId: number(row.rankedSeasonId), rankedCheckedAt: date(row.rankedCheckedAt, now) };
}
function membershipObservation(value: unknown, now: Date): ComparisonMembershipObservation | undefined {
  if (value == null) return undefined;
  const row = object(value), observedSince = date(row.observedSince, now), checkedAt = date(row.checkedAt, now);
  const graceUntil = date(row.graceUntil, now, true);
  const valid = observedSince !== null && checkedAt !== null && Date.parse(observedSince) <= Date.parse(checkedAt)
    && (row.graceUntil === null || (graceUntil !== null && Date.parse(graceUntil) >= Date.parse(observedSince)));
  return { observedSince, checkedAt, graceUntil,
    // Invalid supplied grace is uncertainty, never permission to remove grace.
    source: valid && (row.source === "recorded_event" || row.source === "roster_snapshot") ? row.source : null };
}
function member(row: Row, now: Date, days: number): RawComparisonMember {
  const spell = object(row.spell), coverage = object(row.coverage);
  const lastActivityAt = date(row.lastActivityAt, now), lastBattleAt = date(row.lastBattleAt, now);
  const invalidActivityTime = (row.lastActivityAt != null && lastActivityAt === null) || (row.lastBattleAt != null && lastBattleAt === null);
  const source = spell.source === "recorded" || spell.source === "reconstructed" ? spell.source : "unknown";
  const kind = spell.kind === "join" || spell.kind === "initial_seen" ? spell.kind : "unknown";
  const absence = row.absence == null ? null : object(row.absence);
  const absenceStart = absence && date(absence.startsAt, now), absenceEnd = absence && date(absence.endsAt, now, true);
  const dayRows = rows(row.days, days), seenDays = new Set<string>();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()), start = end - days * 86400000;
  if (dayRows.length !== days) return invalid();
  return {
    tag: tag(row.tag), name: text(row.name), role: typeof row.role === "string" ? text(row.role, 40) : null,
    profile: profile(row.profile, now), lastActivityAt, lastBattleAt,
    spell: { startedAt: date(spell.startedAt, now), source, kind, uncertain: spell.uncertain !== false || source !== "recorded" || kind === "unknown" },
    graceUntil: date(row.graceUntil, now, true),
    membershipObservation: membershipObservation(row.membershipObservation, now),
    absence: absenceStart && absenceEnd && Date.parse(absenceEnd) > Date.parse(absenceStart) ? { startsAt: absenceStart, endsAt: absenceEnd } : null,
    coverage: { baselineAt: date(coverage.baselineAt, now), checkedAt: date(coverage.checkedAt, now),
      // An invalid reported activity time is uncertainty, not proof of no activity.
      lastStatus: invalidActivityTime ? "unknown" : text(coverage.lastStatus, 30), trailing48hGap: coverage.trailing48hGap !== false,
      trailing48hExcused: coverage.trailing48hExcused !== false },
    days: dayRows.map(day => {
      const value = text(day.date, 10);
      const dayAt = Date.parse(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(dayAt) || dayAt < start || dayAt >= end
        || new Date(dayAt).toISOString().slice(0, 10) !== value || seenDays.has(value)) return invalid();
      seenDays.add(value);
      return { date: value, battles: number(day.battles), possibleGap: day.possibleGap !== false, absenceOverlap: day.absenceOverlap !== false };
    }),
    events: rows(row.events, 100).map(event => {
      const startsAt = date(event.startsAt, now, true), endsAt = date(event.endsAt, now, true);
      const status = event.status, attendance = event.attendance;
      if (!startsAt || !endsAt || !["planned", "completed", "cancelled"].includes(String(status))) return invalid();
      const version = number(event.version);
      if (version == null || version < 1) return invalid();
      const observedAt = date(event.observedAt, now);
      return { id: text(event.id, 36), version, title: text(event.title, 100), kind: text(event.kind, 30), startsAt, endsAt,
        status: status as "planned" | "completed" | "cancelled",
        attendance: ["invited", "confirmed", "present", "absent"].includes(String(attendance)) ? attendance as "invited" | "confirmed" | "present" | "absent" : null,
        observedAt: observedAt && Date.parse(observedAt) >= Date.parse(startsAt) && Date.parse(observedAt) <= Date.parse(endsAt) ? observedAt : null,
        absenceOverlap: event.absenceOverlap !== false };
    }), eventsTruncated: row.eventsTruncated !== false,
  };
}

export async function readMemberComparison(params: URLSearchParams, now = new Date()) {
  if ([...params.keys()].some(key => key !== "range") || params.getAll("range").length > 1) throw new MemberComparisonInputError("Invalid comparison query");
  const range = params.get("range") ?? "7d";
  if (!["7d", "30d", "90d"].includes(range)) throw new MemberComparisonInputError("Choose a 7, 30 or 90 day comparison.");
  const clubTag = await requireAcceptedClubRoster(now);
  const { data, error } = await supabaseAdmin.rpc("member_comparison_read", { p_club: clubTag, p_days: Number.parseInt(range, 10), p_now: now.toISOString() });
  if (error?.code === "40001") throw new ClubRosterUnavailableError();
  if (error) throw new Error("Comparison data is unavailable");
  const result = object(data);
  if (result.clubTag !== clubTag || result.range !== range || date(result.generatedAt, now) !== now.toISOString()) return invalid();
  const members = rows(result.members, 30).map(row => member(row, now, Number.parseInt(range, 10)));
  const tags = new Set(members.map(row => row.tag));
  if (tags.size !== members.length) return invalid();
  const candidates = rows(result.candidates, 100).map(row => ({
    kind: "candidate" as const, tag: tag(row.tag), name: text(row.name), status: text(row.status, 30),
    profile: profile(row.profile, now), commitment: "unknown" as const,
  })).filter(row => !tags.has(row.tag) && !["archived", "joined"].includes(row.status));
  if (new Set(candidates.map(row => row.tag)).size !== candidates.length) return invalid();
  const snapshot: RawMemberComparison = { clubTag, generatedAt: now.toISOString(), range: range as MemberComparisonRange,
    rosterCheckedAt: date(result.rosterCheckedAt, now), members, candidates };
  await assertAcceptedClubRoster(clubTag);
  return buildMemberComparison(snapshot);
}
