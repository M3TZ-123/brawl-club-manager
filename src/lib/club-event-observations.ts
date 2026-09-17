import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertAcceptedClubRoster, ClubRosterUnavailableError, requireAcceptedClubRoster } from "@/lib/accepted-club-roster";
import type { ClubEventCoverageStatus, ClubEventObservedMember, ClubEventObservationsResponse } from "@/lib/club-event-observations-types";

export class ClubEventObservationsError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409) { super(message); }
}
type Row = Record<string, unknown>;
const invalid = (): never => { throw new Error("Invalid event observations"); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses: readonly ClubEventCoverageStatus[] = ["unknown", "baseline", "observed", "possible_gap", "failed", "empty", "regressing"];
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Row;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.length || value.length > max || value.includes("\0")) return invalid();
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function date(value: unknown, latest = Infinity): string | null {
  const at = typeof value === "string" && value.length <= 64 ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= latest ? new Date(at).toISOString() : null;
}
function member(value: unknown, now: number, start: number, until: number): ClubEventObservedMember {
  const row = object(value), coverage = object(row.coverage);
  const playerTag = text(row.playerTag, 21), playerName = text(row.playerName, 160);
  if (!/^#[A-Z0-9]{1,20}$/.test(playerTag)) return invalid();
  const observedBattles = count(row.observedBattles), explicitMegaPigBattles = count(row.explicitMegaPigBattles);
  if (explicitMegaPigBattles > observedBattles || typeof coverage.possibleGap !== "boolean") return invalid();
  const lastObservedBattleAt = date(row.lastObservedBattleAt, now), lastExplicitMegaPigBattleAt = date(row.lastExplicitMegaPigBattleAt, now);
  if ((row.lastObservedBattleAt != null && lastObservedBattleAt === null)
    || (row.lastExplicitMegaPigBattleAt != null && lastExplicitMegaPigBattleAt === null)) return invalid();
  for (const [total, at] of [[observedBattles, lastObservedBattleAt], [explicitMegaPigBattles, lastExplicitMegaPigBattleAt]] as const) {
    if (total === 0 ? at !== null : at === null || Date.parse(at) < start || Date.parse(at) >= until) return invalid();
  }
  if (lastExplicitMegaPigBattleAt && lastObservedBattleAt && lastExplicitMegaPigBattleAt > lastObservedBattleAt) return invalid();
  let baselineAt = date(coverage.baselineAt, now), checkedAt = date(coverage.checkedAt, now);
  let status: ClubEventCoverageStatus = statuses.includes(coverage.status as ClubEventCoverageStatus) ? coverage.status as ClubEventCoverageStatus : "unknown";
  if ((coverage.baselineAt != null && baselineAt === null) || (coverage.checkedAt != null && checkedAt === null)
    || (baselineAt !== null && checkedAt !== null && baselineAt > checkedAt)) {
    baselineAt = null; checkedAt = null; status = "unknown";
  }
  if (["baseline", "observed", "possible_gap"].includes(status) && (!baselineAt || !checkedAt)) status = "unknown";
  return { playerTag, playerName, observedBattles, lastObservedBattleAt, explicitMegaPigBattles, lastExplicitMegaPigBattleAt,
    authoritativeWins: null, ticketsRemaining: null, coverage: { baselineAt, checkedAt, status, possibleGap: coverage.possibleGap } };
}

export async function readClubEventObservations(params: URLSearchParams, now = new Date()): Promise<ClubEventObservationsResponse> {
  const eventId = params.get("event"), rawVersion = params.get("version");
  if ([...params.keys()].some(key => !["event", "version"].includes(key)) || params.getAll("event").length !== 1 || params.getAll("version").length !== 1
    || !eventId || !uuid.test(eventId) || !rawVersion || !/^[1-9][0-9]{0,9}$/.test(rawVersion) || Number(rawVersion) > 2147483647) {
    throw new ClubEventObservationsError("Choose a saved event and its current version.", 400);
  }
  const clubTag = await requireAcceptedClubRoster(now);
  const { data, error } = await supabaseAdmin.rpc("club_event_observations_read", { p_club: clubTag, p_event: eventId.toLowerCase(), p_now: now.toISOString() })
    .abortSignal(AbortSignal.timeout(6000));
  if (error?.code === "40001") throw new ClubRosterUnavailableError();
  if (error?.code === "P0002") throw new ClubEventObservationsError("Saved Mega Pig event not found.", 404);
  if (error) throw new Error("Event observations could not be loaded.");
  const row = object(data), sync = object(row.sync), at = now.getTime();
  if (row.clubTag !== clubTag || row.eventId !== eventId.toLowerCase() || date(row.generatedAt, at) !== now.toISOString()) return invalid();
  const eventVersion = count(row.eventVersion);
  if (eventVersion !== Number(rawVersion)) throw new ClubEventObservationsError("This event changed. Reload its saved version.", 409);
  if (!["planned", "completed", "cancelled"].includes(String(row.status))) return invalid();
  const startsAt = date(row.startsAt), endsAt = date(row.endsAt), observedUntil = date(row.observedUntil, at);
  if (!startsAt || !endsAt || !observedUntil || endsAt <= startsAt || Date.parse(endsAt) - Date.parse(startsAt) > 31 * 86400000
    || Date.parse(observedUntil) !== Math.min(Date.parse(endsAt), at)) return invalid();
  if (!Array.isArray(row.members) || row.members.length > 30) return invalid();
  const members = row.members.map(value => member(value, at, Date.parse(startsAt), Date.parse(observedUntil)));
  if (new Set(members.map(value => value.playerTag)).size !== members.length) return invalid();
  const lastFullSyncAt = date(sync.lastFullSyncAt, at), lastBattleSyncAt = date(sync.lastBattleSyncAt, at);
  await assertAcceptedClubRoster(clubTag);
  return { clubTag, eventId: eventId.toLowerCase(), eventVersion, status: row.status as ClubEventObservationsResponse["status"],
    startsAt, endsAt, observedUntil, generatedAt: now.toISOString(), hasStarted: at > Date.parse(startsAt),
    historyLimited: true, classification: "explicit_battle_type_only",
    sync: { lastFullSyncAt, lastBattleSyncAt, stale: lastBattleSyncAt === null || Date.parse(lastBattleSyncAt) < at - 35 * 60000 }, members };
}
