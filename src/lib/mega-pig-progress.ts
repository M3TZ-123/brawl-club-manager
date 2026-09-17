import type { MegaPigArchiveCycle, MegaPigCycleProgress } from "@/lib/mega-pig-archive-types";

// BTLN, 10 October 2025. This community-reported preset is editable per cycle;
// the official support article still contains superseded 15-ticket/40-win rules.
export const MEGA_PIG_STANDARD_MILESTONES = [16, 32, 48, 64, 80] as const;
export const MEGA_PIG_RULE_REFERENCE_URL = "https://x.com/BrawlStarsBTLN/status/1976562295502229973";
export function megaPigReportedStage(totalWins: number, milestones: readonly number[] = MEGA_PIG_STANDARD_MILESTONES) {
  return milestones.filter(value => totalWins >= value).length;
}

/** Dates end collection; only explicit final confirmation verifies the result. */
export function megaPigCycleProgress(cycle: MegaPigArchiveCycle, now = Date.now()): MegaPigCycleProgress {
  const lifecycle = cycle.finalizedAt ? "finalized" : now < Date.parse(cycle.startsAt) ? "scheduled" : now >= Date.parse(cycle.endsAt) ? "ended" : "active";
  const milestones = cycle.milestones;
  const stages = milestones?.length ?? (cycle.confirmedStage !== null ? 5 : null);
  const totalWins = cycle.finalizedAt ? cycle.finalTotalWins : cycle.reportedTotalWins;
  const target = milestones?.at(-1) ?? null;
  const calculatedStage = totalWins === null || !milestones ? null : milestones.filter(value => totalWins >= value).length;
  const stage = cycle.finalizedAt && cycle.confirmedStage !== null ? cycle.confirmedStage : calculatedStage;
  const basis = cycle.finalizedAt && (stage !== null || totalWins !== null) ? "confirmed" : stage !== null || totalWins !== null ? "observed" : "unknown";
  const complete = stage !== null && stages !== null && stage >= stages;
  // An ended observation window does not prove a final shortfall. Only a
  // confirmed final result may say the club missed its goal.
  const goal = complete ? "achieved" : lifecycle === "finalized" && stage !== null ? "missed" : stage !== null ? "in_progress" : "unknown";
  return { lifecycle, stage, stages, totalWins, target, remainingWins: totalWins === null || target === null ? null : Math.max(0, target - totalWins), goal, basis };
}
