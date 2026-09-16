import { describeBattleContext } from "./battle-catalog";

export function battlePointData(battle: {
  trophy_change?: number | null;
  trophy_change_reported?: boolean | null;
  battle_type?: string | null;
}) {
  // Legacy zeroes may have been synthesized for a missing API property. Only
  // fresh explicit observations prove a value was reported, including real zero.
  const reported = battle.trophy_change_reported === true && Number.isFinite(battle.trophy_change);
  // The old ingestion only synthesized zero, so a nonzero legacy value remains
  // meaningful, while its unit/source provenance is still unverified.
  const legacyNonzero = Number.isFinite(battle.trophy_change) && battle.trophy_change !== 0;
  return {
    change: reported || legacyNonzero ? battle.trophy_change! : null,
    unit: reported && describeBattleContext(battle).key === "ladder" ? "trophies" as const : "unknown" as const,
    source: reported ? "battle.trophyChange" as const : null,
  };
}
