import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { CLUB_ROSTER_UNAVAILABLE_MESSAGE } from "@/lib/club-roster-message";

export class ClubRosterUnavailableError extends Error {
  constructor() { super(CLUB_ROSTER_UNAVAILABLE_MESSAGE); }
}

/** A changed club keeps historical member rows, but clears these acceptance markers. */
export async function requireAcceptedClubRoster(now?: Date): Promise<string> {
  const { data, error } = await supabaseAdmin.from("settings").select("key,value")
    .in("key", ["club_tag", "last_roster_sync_time", "last_sync_time"]);
  if (error) throw new Error("Club configuration could not be loaded.");
  const settings = Object.fromEntries((data || []).map(row => [row.key, row.value]));
  const value = String(settings.club_tag || process.env.CLUB_TAG || "").trim().replace(/^%23/i, "#");
  const clubTag = `#${value.replace(/^#/, "").toUpperCase()}`;
  const accepted = [settings.last_roster_sync_time, settings.last_sync_time].some(value => {
    const timestamp = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) && timestamp <= (now?.getTime() ?? Date.now());
  });
  if (!/^#[A-Z0-9]{1,20}$/.test(clubTag) || !accepted) throw new ClubRosterUnavailableError();
  return clubTag;
}

/** Reject a response assembled while the configured club changed. */
export async function assertAcceptedClubRoster(clubTag: string, now?: Date): Promise<void> {
  if (await requireAcceptedClubRoster(now) !== clubTag) throw new ClubRosterUnavailableError();
}
