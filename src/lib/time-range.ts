export const TIME_RANGES = {
  "24h": { days: 1, label: "Last 24 hours", shortLabel: "24h", metric: "trophies_24h" },
  "3d": { days: 3, label: "Last 3 days", shortLabel: "3 days", metric: "trophies_3d" },
  "7d": { days: 7, label: "Last 7 days", shortLabel: "7 days", metric: "trophies_7d" },
  "30d": { days: 30, label: "Last 30 days", shortLabel: "1 month", metric: "trophies_30d" },
  "90d": { days: 90, label: "Last 90 days", shortLabel: "3 months", metric: "trophies_90d" },
} as const;

export type TimeRangeKey = keyof typeof TIME_RANGES;
export type TrophyPeriodMetric = (typeof TIME_RANGES)[TimeRangeKey]["metric"];

export function parseTimeRange(value: string | null | undefined, fallback: TimeRangeKey = "7d"): TimeRangeKey {
  return value && Object.prototype.hasOwnProperty.call(TIME_RANGES, value) ? value as TimeRangeKey : fallback;
}
