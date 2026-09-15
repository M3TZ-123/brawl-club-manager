import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const REVIEW_COLUMNS = "player_tag, status, follow_up_at, notes, updated_at";
export type MemberReview = {
  player_tag: string;
  status: "pending" | "reviewed" | "follow_up";
  follow_up_at: string | null;
  notes: string | null;
  updated_at: string;
};

export class ReviewInputError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export function normalizeReviewTag(value: unknown): string {
  if (typeof value !== "string") throw new ReviewInputError("player_tag is required");
  const tag = value.trim().toUpperCase();
  if (!/^#[A-Z0-9]{1,19}$/.test(tag)) throw new ReviewInputError("Provide a valid player_tag beginning with #");
  return tag;
}

export async function loadMemberReviews(playerTag?: string): Promise<MemberReview[]> {
  const rows: MemberReview[] = [];
  for (let from = 0; ; from += 1000) {
    let query = supabaseAdmin.from("member_reviews").select(REVIEW_COLUMNS)
      .order("player_tag", { ascending: true }).range(from, from + 999);
    if (playerTag) query = query.eq("player_tag", playerTag);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...((data || []) as MemberReview[]));
    if (!data || data.length < 1000) return rows;
  }
}

export async function saveMemberReview(body: unknown): Promise<MemberReview> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ReviewInputError("Invalid review payload");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["player_tag", "status", "follow_up_at", "notes"].includes(key))) {
    throw new ReviewInputError("Unknown review field");
  }
  const playerTag = normalizeReviewTag(input.player_tag);
  const update: Record<string, unknown> = { player_tag: playerTag };
  if (Object.hasOwn(input, "status")) {
    if (typeof input.status !== "string" || !["pending", "reviewed", "follow_up"].includes(input.status)) {
      throw new ReviewInputError("Invalid review status");
    }
    update.status = input.status;
    update.follow_up_at = null;
    if (input.status === "follow_up") {
      if (typeof input.follow_up_at !== "string" || input.follow_up_at.length > 64 || !/(Z|[+-]\d{2}:\d{2})$/.test(input.follow_up_at)) {
        throw new ReviewInputError("A dated follow_up requires follow_up_at with a timezone");
      }
      const followUp = new Date(input.follow_up_at);
      if (!Number.isFinite(followUp.getTime())) throw new ReviewInputError("Invalid follow_up_at");
      update.follow_up_at = followUp.toISOString();
    } else if (input.follow_up_at != null) {
      throw new ReviewInputError("Only follow_up reviews may have follow_up_at");
    }
  } else if (Object.hasOwn(input, "follow_up_at")) {
    throw new ReviewInputError("Include status when changing follow_up_at");
  }
  if (Object.hasOwn(input, "notes")) {
    if (input.notes !== null && typeof input.notes !== "string") throw new ReviewInputError("notes must be text or null");
    const notes = typeof input.notes === "string" ? input.notes.trim() : "";
    if (notes.length > 1000 || notes.includes("\0")) throw new ReviewInputError("Notes must contain at most 1000 characters");
    update.notes = notes || null;
  }
  if (Object.keys(update).length === 1) throw new ReviewInputError("Provide notes or a review status");
  const { data: member, error: memberError } = await supabaseAdmin.from("member_history")
    .select("player_tag").eq("player_tag", playerTag).maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw new ReviewInputError("Member not found", 404);
  // A single-row partial upsert updates only the supplied fields. Notes-only
  // edits must preserve an existing status and follow-up date.
  const { data, error } = await supabaseAdmin.from("member_reviews")
    .upsert(update, { onConflict: "player_tag" }).select(REVIEW_COLUMNS).single();
  if (error) throw error;
  return data as MemberReview;
}
