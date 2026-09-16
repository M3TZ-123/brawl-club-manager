import { TIME_RANGES, type TimeRangeKey } from "@/lib/time-range";

const DAY_MS = 24 * 60 * 60 * 1000;

// Daily aggregates include the current UTC date; trophy comparisons use rolling baselines.
export function getReportingPeriod(key: TimeRangeKey = "7d", now = new Date()) {
  const days = TIME_RANGES[key].days;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(today - (days - 1) * DAY_MS);
  return {
    key,
    days,
    start,
    end: now,
    previousStart: new Date(start.getTime() - days * DAY_MS),
    dates: Array.from({ length: days }, (_, index) =>
      new Date(start.getTime() + index * DAY_MS).toISOString().slice(0, 10)
    ),
  };
}

export function reportingPeriodMetadata(period: ReturnType<typeof getReportingPeriod>) {
  return {
    key: period.key,
    days: period.days,
    start: period.start.toISOString(),
    end: period.end.toISOString(),
    dates: period.dates,
    aggregation: "utc_days" as const,
    trophyProgressBasis: "rolling_account_baseline" as const,
    trophyProgressStart: new Date(period.end.getTime() - period.days * DAY_MS).toISOString(),
    maximumBaselineAgeHours: 24,
  };
}

export function getWeeklyReportingPeriod(now = new Date()) {
  return getReportingPeriod("7d", now);
}
