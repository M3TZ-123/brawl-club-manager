import type { BrawlStarsBattleLog } from "./brawl-api";

export interface BattleObservation {
  player_tag: string;
  success: boolean;
  battle_times: string[];
}

// A malformed response is not an empty successful window. Preserve the previous
// coverage baseline and let sync report a partial fetch instead.
export function battleObservation(playerTag: string, log: BrawlStarsBattleLog | null, now = Date.now()): BattleObservation {
  const failed: BattleObservation = { player_tag: playerTag, success: false, battle_times: [] };
  if (!log || !Array.isArray(log.items) || log.items.length > 100) return failed;
  const times: string[] = [];
  for (const item of log.items) {
    if (!item?.battle || typeof item.battle !== "object" || typeof item.battleTime !== "string") return failed;
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{3}))?Z$/.exec(item.battleTime);
    if (!match) return failed;
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7] || "000"}Z`;
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso || date.getTime() > now + 60_000) return failed;
    // Storage identifies battle observations at second precision.
    times.push(new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString());
  }
  return { player_tag: playerTag, success: true, battle_times: [...new Set(times)].sort() };
}

export interface BattleCoverageSummary {
  status: "unknown" | "observed" | "possible_gap";
  monitoredPlayers: number;
  currentPlayers: number;
  affectedPlayers: number;
  lastCheckedAt: string | null;
  lastGapAt: string | null;
  windowDays: number;
}

export function summarizeBattleCoverage(tags: string[], rows: unknown, now = Date.now()): BattleCoverageSummary {
  const current = new Set(tags);
  const summary: BattleCoverageSummary = { status: "unknown", monitoredPlayers: 0, currentPlayers: current.size,
    affectedPlayers: 0, lastCheckedAt: null, lastGapAt: null, windowDays: 28 };
  if (!Array.isArray(rows)) return summary;
  const date = (value: unknown) => {
    const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) && timestamp <= now + 60_000 ? timestamp : null;
  };
  const seen = new Set<string>();
  const checked: number[] = [];
  const gaps: number[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || !current.has(row.player_tag) || seen.has(row.player_tag)) continue;
    seen.add(row.player_tag);
    const baseline = date(row.baseline_started_at);
    const observed = date(row.last_observed_at);
    if (baseline !== null && observed !== null && observed >= baseline) {
      summary.monitoredPlayers++;
      checked.push(observed);
    }
    if (row.possible_gap === true) {
      summary.affectedPlayers++;
      const detected = date(row.last_gap_detected_at);
      if (detected !== null) gaps.push(detected);
    }
  }
  summary.status = summary.affectedPlayers ? "possible_gap" : current.size > 0 && summary.monitoredPlayers === current.size ? "observed" : "unknown";
  summary.lastCheckedAt = checked.length ? new Date(Math.min(...checked)).toISOString() : null;
  summary.lastGapAt = gaps.length ? new Date(Math.max(...gaps)).toISOString() : null;
  return summary;
}
