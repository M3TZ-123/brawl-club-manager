import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertAcceptedClubRoster, requireAcceptedClubRoster } from "@/lib/accepted-club-roster";
import { archiveMilestones, archiveObject, archiveUuid, MegaPigArchiveError, megaPigArchiveInput, megaPigArchiveQuery } from "@/lib/mega-pig-archive-input";
import { validateMegaPigSourcePayload } from "@/lib/mega-pig-source-provider";
import type { MegaPigArchiveCycle, MegaPigArchiveMember, MegaPigArchiveResponse, MegaPigObservationSummary } from "@/lib/mega-pig-archive-types";

type Row = Record<string, unknown>;
const invalid = (): never => { throw new Error("Invalid archive response."); };
function integer(value: unknown, max = 30000): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : invalid();
}
const nullableInteger = (value: unknown, max = 30000) => value === null ? null : integer(value, max);
function text(value: unknown, max = 2000): string {
  return typeof value === "string" && value.length <= max && !value.includes("\0") ? value : invalid();
}
function date(value: unknown, nullable = true): string | null {
  if (nullable && value === null) return null;
  const at = typeof value === "string" && value.length <= 64 ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : invalid();
}
function boolean(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function rows(value: unknown, limit: number): Row[] {
  if (!Array.isArray(value) || value.length > limit) return invalid();
  return value.map(archiveObject);
}
function nextOffset(value: unknown, offset: number): number | null {
  if (value === null) return null;
  const next = integer(value, 1000000); return next > offset ? next : invalid();
}
function cycle(row: Row, clubTag: string): MegaPigArchiveCycle {
  if (row.club_tag !== clubTag || !["unknown", "received", "not_received"].includes(String(row.reward_status))
    || (row.capture_paused_reason !== null && row.capture_paused_reason !== "counters_decreased")) return invalid();
  const startsAt = date(row.starts_at, false)!, endsAt = date(row.ends_at, false)!;
  const milestones = archiveMilestones(row.milestones), confirmedStage = nullableInteger(row.confirmed_stage, milestones?.length ?? 5);
  if (startsAt >= endsAt || integer(row.version, 2147483647) < 1) return invalid();
  return { id: archiveUuid(row.id), title: text(row.title, 100), startsAt, endsAt, milestones, version: Number(row.version),
    createdAt: date(row.created_at, false)!, updatedAt: date(row.updated_at, false)!,
    captureEnabled: boolean(row.capture_enabled), capturePausedReason: row.capture_paused_reason as "counters_decreased" | null,
    initialObservationId: row.initial_observation_id === null ? null : archiveUuid(row.initial_observation_id),
    lastCapturedAt: date(row.last_captured_at), reportedTotalWins: nullableInteger(row.reported_total_wins), reportedPlayersPlayed: nullableInteger(row.reported_players_played, 30),
    finalTotalWins: nullableInteger(row.final_total_wins), confirmedStage, rewardStatus: row.reward_status as MegaPigArchiveCycle["rewardStatus"],
    finalizedAt: date(row.finalized_at), notes: text(row.notes) };
}
function member(row: Row, cycleId: string): MegaPigArchiveMember {
  if (row.cycle_id !== cycleId || typeof row.player_tag !== "string" || !/^#[A-Z0-9]{1,20}$/.test(row.player_tag)) return invalid();
  return { playerTag: row.player_tag, playerName: text(row.player_name, 160), isCurrentMember: boolean(row.is_current_member),
    firstObservedAt: date(row.first_observed_at), lastObservedAt: date(row.last_observed_at),
    wins: nullableInteger(row.wins, 1000), ticketsRemaining: nullableInteger(row.tickets_remaining, 1000),
    winsObservedAt: date(row.wins_observed_at), ticketsObservedAt: date(row.tickets_observed_at),
    latestWinsUnknown: boolean(row.latest_wins_unknown), latestTicketsUnknown: boolean(row.latest_tickets_unknown) };
}
function observation(row: Row, clubTag: string): MegaPigObservationSummary {
  if (row.club_tag !== undefined && row.club_tag !== clubTag) return invalid();
  const sourceMembers = integer(row.source_members, 30), unknownMembers = integer(row.unknown_members, sourceMembers);
  const firstFetchedAt = date(row.first_fetched_at), lastFetchedAt = date(row.last_fetched_at);
  if (firstFetchedAt && lastFetchedAt && firstFetchedAt > lastFetchedAt) return invalid();
  return { id: archiveUuid(row.id), firstFetchedAt, lastFetchedAt, totalWins: integer(row.total_wins),
    reportedPlayersPlayed: integer(row.reported_players_played, sourceMembers), sourceMembers, unknownMembers };
}
function databaseError(error: { code?: string; message?: string } | null) {
  if (!error) return;
  const message = error.message || "";
  if (error.code === "P0002") throw new MegaPigArchiveError("Mega Pig archive record not found.", 404, "not_found");
  if (message.includes("archive_capture_overlap")) throw new MegaPigArchiveError("Automatic collection dates overlap another cycle.", 409, "conflict");
  if (message.includes("archive_dates_locked")) throw new MegaPigArchiveError("This cycle already has saved readings. Its dates cannot be changed.", 409, "conflict");
  if (message.includes("archive_not_ended")) throw new MegaPigArchiveError("Wait until the cycle ends before confirming its final result.", 409, "conflict");
  if (message.includes("archive_cycle_finalized") || message.includes("archive_not_finalized")) throw new MegaPigArchiveError("This cycle's finalization status changed. Reload its saved version.", 409, "conflict");
  if (message.includes("archive_reconfirmation_required")) throw new MegaPigArchiveError("Counters decreased. Confirm a new reading belongs to this same cycle and explain the correction.", 409, "conflict");
  if (message.includes("archive_confirmation_required")) throw new MegaPigArchiveError("Confirm a saved reading belongs to this cycle before enabling automatic collection.");
  if (["40001", "23505"].includes(error.code || "")) throw new MegaPigArchiveError("Mega Pig history changed. Reload the saved version before saving. Your draft is preserved.", 409, "conflict");
  if (["22023", "22P02", "22007", "22008", "23514"].includes(error.code || "")) throw new MegaPigArchiveError();
  throw new Error("Mega Pig archive unavailable.");
}
export async function readMegaPigArchive(params: URLSearchParams): Promise<MegaPigArchiveResponse> {
  const query = megaPigArchiveQuery(params), clubTag = await requireAcceptedClubRoster();
  const result = await supabaseAdmin.rpc("mega_pig_archive_read", {
    p_club: clubTag, p_mode: query.mode, p_id: query.id, p_player: query.player, p_offset: query.offset,
  }).abortSignal(AbortSignal.timeout(7000));
  databaseError(result.error);
  let response: MegaPigArchiveResponse;
  try {
    const data = archiveObject(result.data); response = { clubTag };
    if (query.mode === "cycles") {
      response.cycles = rows(data.cycles, 20).map(row => cycle(row, clubTag));
      response.nextOffset = nextOffset(data.next_offset, query.offset); response.observationCount = integer(data.observation_count, 2147483647);
      response.latestObservation = data.latest_observation === null ? null : observation(archiveObject(data.latest_observation), clubTag);
    } else if (query.mode === "readings") {
      response.observations = rows(data.observations, 20).map(row => observation(row, clubTag));
      response.nextOffset = nextOffset(data.next_offset, query.offset);
    } else if (query.mode === "cycle") {
      response.cycle = cycle(archiveObject(data.cycle), clubTag);
      if (response.cycle.id !== query.id) return invalid();
      response.members = rows(data.members, 50).map(row => member(row, response.cycle!.id));
      response.nextOffset = nextOffset(data.next_offset, query.offset);
      response.latestObservation = data.latest_observation === null ? null : observation(archiveObject(data.latest_observation), clubTag);
    } else if (query.mode === "reading") {
      const row = archiveObject(data.observation), payload = validateMegaPigSourcePayload(row.payload, clubTag), summary = observation(row, clubTag);
      if (summary.id !== query.id || payload.totalWins !== summary.totalWins || payload.members.length !== summary.sourceMembers) return invalid();
      response.observation = { ...summary, members: payload.members };
    } else {
      if (data.player_tag !== query.player) return invalid();
      response.playerTag = query.player!;
      response.history = rows(data.history, 20).map(row => {
        const cycleData = cycle(archiveObject(row.cycle), clubTag), memberData = member(archiveObject(row.member), cycleData.id);
        if (memberData.playerTag !== query.player) return invalid();
        return { cycle: cycleData, member: memberData };
      });
      response.playerReadings = rows(data.player_readings, 20).map(row => {
        const sourceMember = archiveObject(row.member);
        if (sourceMember.playerTag !== query.player) return invalid();
        return { observation: observation(archiveObject(row.observation), clubTag), member: {
          playerTag: query.player!, playerName: text(sourceMember.playerName, 160),
          reportedWins: nullableInteger(sourceMember.reportedWins, 1000),
          reportedTicketsRemaining: nullableInteger(sourceMember.reportedTicketsRemaining, 1000),
        } };
      });
      response.nextOffset = nextOffset(data.next_offset, query.offset);
    }
  } catch { throw new Error("Invalid archive response."); }
  await assertAcceptedClubRoster(clubTag);
  return response;
}
export async function mutateMegaPigArchive(value: unknown) {
  const body = megaPigArchiveInput(value), clubTag = await requireAcceptedClubRoster();
  const result = await supabaseAdmin.rpc("mega_pig_archive_write", { p_club: clubTag, p_action: body.action, p_body: body }).abortSignal(AbortSignal.timeout(10000));
  databaseError(result.error);
  await assertAcceptedClubRoster(clubTag);
  try {
    const row = archiveObject(result.data);
    return { id: archiveUuid(row.cycle_id), version: integer(row.version, 2147483647), replayed: boolean(row.replayed) };
  } catch { throw new Error("Invalid archive save response."); }
}
