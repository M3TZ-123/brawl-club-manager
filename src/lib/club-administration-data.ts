export const decisionKinds = ["note", "decision", "departure_reason", "correction", "follow_up"] as const;
export type DecisionKind = typeof decisionKinds[number];
export type ClubAdministration = { club_tag: string; grace_hours: number; recruitment_open: boolean; min_trophies: number; min_power11: number; min_ranked_points: number | null; language: string; availability: string; version: number; updated_at: string | null };
export type MemberDecision = { id: string; kind: DecisionKind | "absence_declared" | "absence_cancelled"; body: string; departure_event_id: string | null; departure_occurred_at?: string | null; corrects_id: string | null; follow_up_at: string | null; created_at: string };
export type MemberAbsence = { id: string; player_tag: string; starts_at: string; ends_at: string; reason: string; created_at: string; cancelled_at: string | null };
export type DepartureChoice = { id: string; occurred_at: string; source: string };
export type MemberAdministration = { decisions: MemberDecision[]; nextCursor: string | null; absences: MemberAbsence[]; departures: DepartureChoice[]; departuresLimited: boolean };
export type RecruitmentApplication = { id: string; player_tag: string; message: string; language: string; availability: string; status: "pending" | "reviewing" | "accepted" | "rejected" | "archived"; private_notes: string; version: number; created_at: string; updated_at: string };
export type PublicJoinInfo = Pick<ClubAdministration, "club_tag" | "recruitment_open" | "min_trophies" | "min_power11" | "min_ranked_points" | "language" | "availability">;
export class AdministrationInputError extends Error { constructor(message: string, public readonly status = 400) { super(message); } }
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdministrationInputError("Invalid administration request");
  return value as Record<string, unknown>;
}
export function textInput(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0") || (required && !value.trim())) throw new AdministrationInputError("Check the text fields and try again.");
  return value.trim();
}
export function uuidInput(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new AdministrationInputError("Invalid record reference");
  return value;
}
export function dateInput(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,6})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new AdministrationInputError("Provide a valid date and timezone.");
  if (new Date(`${value.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10) !== value.slice(0,10)) throw new AdministrationInputError("Provide a valid date and timezone.");
  return value;
}
export function integerInput(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new AdministrationInputError("Check the numeric limits and try again.");
  return value as number;
}
export function administrationInput(value: unknown) {
  const row = objectInput(value);
  if (typeof row.recruitment_open !== "boolean") throw new AdministrationInputError("Invalid recruitment setting");
  return { grace_hours: integerInput(row.grace_hours,168), recruitment_open: row.recruitment_open,
    min_trophies: integerInput(row.min_trophies,2000000), min_power11: integerInput(row.min_power11,300),
    min_ranked_points: row.min_ranked_points == null ? null : integerInput(row.min_ranked_points,1000000),
    language: textInput(row.language,120), availability: textInput(row.availability,240), version: integerInput(row.version,2147483646) };
}
