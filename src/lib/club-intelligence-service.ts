import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildClubIntelligence } from "./club-intelligence";
import type { ClubIntelligenceRange } from "./club-intelligence-types";

export async function readClubIntelligence(range: ClubIntelligenceRange, now = new Date()) {
  const { data, error } = await supabaseAdmin.rpc("club_intelligence_read", { p_days: Number.parseInt(range, 10), p_now: now.toISOString() }).abortSignal(AbortSignal.timeout(10_000));
  if (error) throw new Error("Club insights are temporarily unavailable.");
  return buildClubIntelligence(data, range, now);
}
