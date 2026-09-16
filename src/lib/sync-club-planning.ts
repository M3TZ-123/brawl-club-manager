import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";

// Goals use already committed records. Optional summaries must never change a
// successful sync into a failure or hold its fencing transaction open.
export async function refreshPlanningAfterSync(clubTag: string) {
  try {
    const result = await supabaseAdmin.rpc("club_planning_refresh_goals", { p_club: clubTag }).abortSignal(AbortSignal.timeout(5500));
    if (result.error) console.warn("Club goal summaries deferred until the next refresh");
  } catch { console.warn("Club goal summaries deferred until the next refresh"); }
}
