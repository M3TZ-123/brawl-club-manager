import "server-only";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { officialGameRequest } from "@/lib/official-game-api";
import { candidateInput, candidateProfile, candidateTag, candidateSnapshot, CandidateInputError } from "@/lib/recruitment-data";
const columns = "player_tag,status,notes,version,created_at,updated_at,profile,profile_checked_at,manual_compatibility";
export async function listCandidates() {
  const { data, error } = await supabaseAdmin.from("recruitment_candidates").select(columns).order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error("Candidate list unavailable");
  return (data || []).map(candidateSnapshot);
}
export async function saveCandidate(body: unknown) {
  const input = candidateInput(body);
  const { data, error } = await supabaseAdmin.rpc(input.manual_compatibility ? "save_recruitment_candidate_details" : "save_recruitment_candidate", {
    p_tag: input.player_tag, p_status: input.status, p_notes: input.notes, p_version: input.version,
    ...(input.manual_compatibility ? { p_manual: input.manual_compatibility } : {}) });
  if (error?.code === "40001") throw new CandidateInputError("Candidate changed. Reload before saving.", 409);
  if (error?.code === "54000") throw new CandidateInputError("The watchlist supports up to 100 candidates.", 409);
  if (error) throw new Error("Candidate list unavailable");
  return candidateSnapshot(data);
}
async function readCandidate(tag: string) {
  const result = await supabaseAdmin.from("recruitment_candidates").select(columns).eq("player_tag", tag).maybeSingle();
  if (result.error) throw new Error("Candidate list unavailable");
  if (!result.data) throw new CandidateInputError("Candidate not found", 404);
  return candidateSnapshot(result.data);
}
export async function refreshCandidate(value: unknown) {
  const tag = candidateTag(value), token = randomUUID();
  await readCandidate(tag);
  const { data: acquired, error } = await supabaseAdmin.rpc("claim_recruitment_refresh", { p_tag: tag, p_token: token });
  if (error) throw new Error("Candidate list unavailable");
  if (!acquired) return { candidate: await readCandidate(tag), refreshed: false };
  try {
    const value = await officialGameRequest(`/players/${encodeURIComponent(tag)}`);
    const profile = candidateProfile(value, tag);
    const result = await supabaseAdmin.rpc("finish_recruitment_refresh", { p_tag: tag, p_token: token, p_profile: profile });
    if (result.error || result.data !== true) throw new Error("Candidate refresh unavailable");
    // Notes may have been edited while the upstream request was in flight.
    // Return the actual current revision rather than repopulating the old form.
    return { candidate: await readCandidate(tag), refreshed: true };
  } catch {
    await supabaseAdmin.rpc("finish_recruitment_refresh", { p_tag: tag, p_token: token });
    throw new CandidateInputError("Player refresh failed. Saved notes and previous data are preserved.", 503);
  }
}
