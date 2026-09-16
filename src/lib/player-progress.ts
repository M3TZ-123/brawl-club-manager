export type ReportedEquipment = { id: number; name: string | null; level?: number | null };
export type ReportedBuffies = { gadget?: boolean; starPower?: boolean; hyperCharge?: boolean };
export type ProfileProgress = { exp_points?: number; total_prestige_level?: number; fame?: number; fame_tier_name?: string };
export type BrawlerProgress = {
  highest_trophies?: number; prestige_level?: number; current_win_streak?: number; max_win_streak?: number;
  skin?: ReportedEquipment; gadgets?: ReportedEquipment[]; star_powers?: ReportedEquipment[];
  gears?: ReportedEquipment[]; hyper_charges?: ReportedEquipment[]; buffies?: ReportedBuffies;
};

export function optionalProgressInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 160 ? value.trim() : undefined;
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function equipment(value: unknown): ReportedEquipment | undefined {
  const item = object(value); if (!item) return;
  const id = optionalProgressInteger(item.id); if (id === undefined) return;
  const result: ReportedEquipment = { id, name: text(item.name) ?? null };
  if (item.level !== undefined) {
    const level = optionalProgressInteger(item.level); if (level === undefined) return;
    result.level = level;
  }
  return result;
}
export function normalizeReportedEquipment(value: unknown): ReportedEquipment[] | undefined {
  if (!Array.isArray(value) || value.length > 200) return;
  const result = new Map<number, ReportedEquipment>();
  for (const raw of value) {
    const item = equipment(raw); if (!item || result.has(item.id)) return;
    result.set(item.id, item);
  }
  return [...result.values()].sort((a, b) => a.id - b.id);
}
export function normalizeProfileProgress(value: unknown): ProfileProgress {
  const source = object(value) || {};
  return Object.fromEntries(Object.entries({
    exp_points: optionalProgressInteger(source.expPoints), total_prestige_level: optionalProgressInteger(source.totalPrestigeLevel),
    fame: optionalProgressInteger(source.fame), fame_tier_name: text(source.fameTierName),
  }).filter(([, item]) => item !== undefined));
}
export function normalizeBrawlerProgress(value: unknown): BrawlerProgress {
  const source = object(value) || {};
  const rawBuffies = object(source.buffies);
  const buffies = rawBuffies ? Object.fromEntries(["gadget", "starPower", "hyperCharge"].filter(key => typeof rawBuffies[key] === "boolean").map(key => [key, rawBuffies[key]])) : {};
  return Object.fromEntries(Object.entries({
    highest_trophies: optionalProgressInteger(source.highestTrophies), prestige_level: optionalProgressInteger(source.prestigeLevel),
    current_win_streak: optionalProgressInteger(source.currentWinStreak), max_win_streak: optionalProgressInteger(source.maxWinStreak),
    skin: equipment(source.skin), gadgets: normalizeReportedEquipment(source.gadgets), star_powers: normalizeReportedEquipment(source.starPowers),
    gears: normalizeReportedEquipment(source.gears), hyper_charges: normalizeReportedEquipment(source.hyperCharges),
    buffies: Object.keys(buffies).length ? buffies : undefined,
  }).filter(([, item]) => item !== undefined));
}

export interface PlayerProgressResponse {
  playerTag: string;
  period: { key: string; days: number; start: string; end: string; aggregation: "utc_days" };
  profile: {
    highestTrophies: number | null; expPoints: number | null; totalPrestigeLevel: number | null;
    fame: number | null; fameTierName: string | null; lastCheckedAt: string | null; fieldCheckedAt: Record<string, string>;
  };
  collection: { items: Array<{
    id: number; name: string; power: number; trophies: number; rank: number | null; highestTrophies: number | null;
    prestigeLevel: number | null; currentWinStreak: number | null; maxWinStreak: number | null;
    skin: ReportedEquipment | null; gadgets: ReportedEquipment[] | null; starPowers: ReportedEquipment[] | null;
    gears: ReportedEquipment[] | null; hyperCharges: ReportedEquipment[] | null;
    buffies: { gadget: boolean | null; starPower: boolean | null; hyperCharge: boolean | null } | null;
    lastCheckedAt: string; fieldCheckedAt: Record<string, string>;
  }>; nextCursor: number | null; total: number; lastCheckedAt: string | null };
  rankedHistory: { items: Array<{
    id: string; observedAt: string; kind: "initial" | "change" | "season_reset"; seasonId: number | null;
    currentRank: string | null; points: number | null; seasonBest: string | null; seasonBestPoints: number | null;
    allTimeBest: string | null; allTimeBestPoints: number | null; source: string | null; provenance: Record<string, unknown>;
  }>; nextCursor: string | null; coverageStart: string | null; coverageEnd: string | null;
    retention: { detailedDays: 7; dailyDays: 90; olderAggregation: "latest_per_utc_day_and_season" } };
  brawlerHistory: { brawlerId: number | null; items: Array<{
    recordedAt: string; power: number; trophies: number; rank: number | null; gadgetsCount: number | null; starPowersCount: number | null; gearsCount: number | null;
  }>; coverageStart: string | null; coverageEnd: string | null };
}
