import type { MegaPigArchiveMutation } from "@/lib/mega-pig-archive-types";

export class MegaPigArchiveError extends Error {
  constructor(message = "Check the Mega Pig archive fields and try again.", public readonly status = 400,
    public readonly code: "invalid" | "conflict" | "not_found" | "unavailable" = "invalid") { super(message); }
}
const bad = (): never => { throw new MegaPigArchiveError(); };
export const archiveUuid = (value: unknown): string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : bad();
export function archiveObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
  return value as Record<string, unknown>;
}
function keys(row: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(row).some(key => !allowed.includes(key))) bad();
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (!empty && !value.trim())) return bad();
  return value.trim();
}
function integer(value: unknown, min: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : bad();
}
function at(value: unknown): string {
  const raw = text(value, 64), date = new Date(raw);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) return bad();
  return date.toISOString();
}
export function archiveMilestones(value: unknown): number[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return bad();
  const values = value.map(value => integer(value, 1, 30000));
  if (values.some((value, index) => index > 0 && value <= values[index - 1])) return bad();
  return values;
}
export function megaPigArchiveInput(value: unknown): MegaPigArchiveMutation {
  const row = archiveObject(value);
  if (row.action === "save_cycle") {
    keys(row, ["action", "id", "version", "requestId", "cycle"]);
    const id = row.id === null ? null : archiveUuid(row.id), version = integer(row.version, id ? 1 : 0, id ? 2147483647 : 0);
    const cycle = archiveObject(row.cycle);
    keys(cycle, ["title", "startsAt", "endsAt", "milestones", "captureEnabled", "initialObservationId", "notes"]);
    const startsAt = at(cycle.startsAt), endsAt = at(cycle.endsAt);
    if (Date.parse(endsAt) <= Date.parse(startsAt) || Date.parse(endsAt) - Date.parse(startsAt) > 90 * 86400000 || typeof cycle.captureEnabled !== "boolean") return bad();
    const initialObservationId = cycle.initialObservationId === null ? null : archiveUuid(cycle.initialObservationId);
    if (!id && cycle.captureEnabled && !initialObservationId) throw new MegaPigArchiveError("Confirm a saved reading belongs to this cycle before enabling automatic collection.");
    return { action: "save_cycle", id, version, requestId: archiveUuid(row.requestId), cycle: {
      title: text(cycle.title, 100), startsAt, endsAt, milestones: archiveMilestones(cycle.milestones),
      captureEnabled: cycle.captureEnabled, initialObservationId, notes: text(cycle.notes, 2000, true),
    } };
  }
  if (row.action === "finalize_cycle") {
    keys(row, ["action", "id", "version", "finalTotalWins", "confirmedStage", "rewardStatus", "notes"]);
    if (!["unknown", "received", "not_received"].includes(String(row.rewardStatus))) return bad();
    return { action: "finalize_cycle", id: archiveUuid(row.id), version: integer(row.version, 1, 2147483647),
      finalTotalWins: row.finalTotalWins === null ? null : integer(row.finalTotalWins, 0, 30000),
      confirmedStage: row.confirmedStage === null ? null : integer(row.confirmedStage, 0, 10),
      rewardStatus: row.rewardStatus as "unknown" | "received" | "not_received", notes: text(row.notes, 2000, true) };
  }
  if (row.action === "reopen_cycle") {
    keys(row, ["action", "id", "version", "reason"]);
    return { action: "reopen_cycle", id: archiveUuid(row.id), version: integer(row.version, 1, 2147483647), reason: text(row.reason, 2000) };
  }
  return bad();
}
export function megaPigArchiveQuery(params: URLSearchParams) {
  const allowed = ["mode", "id", "player", "offset"];
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) return bad();
  const mode = params.get("mode") || "cycles";
  if (!["cycles", "readings", "cycle", "reading", "player"].includes(mode)) return bad();
  const needsId = mode === "cycle" || mode === "reading";
  if (params.has("id") !== needsId || params.has("player") !== (mode === "player")) return bad();
  const rawOffset = params.get("offset") ?? "0";
  if (!/^(0|[1-9]\d{0,6})$/.test(rawOffset) || (mode === "reading" && rawOffset !== "0")) return bad();
  const offset = integer(Number(rawOffset), 0, 1000000);
  const rawPlayer = params.get("player"), player = rawPlayer === null ? null : `#${rawPlayer.trim().replace(/^#/, "").toUpperCase()}`;
  if (player !== null && !/^#[0289PYLQGRJCUV]{2,19}$/.test(player)) return bad();
  return { mode, id: needsId ? archiveUuid(params.get("id")) : null, player, offset };
}
