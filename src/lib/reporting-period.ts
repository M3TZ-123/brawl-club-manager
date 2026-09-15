const DAY_MS = 24 * 60 * 60 * 1000;

// Daily aggregates use UTC dates: the current UTC day and its six predecessors.
export function getWeeklyReportingPeriod(now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(today - 6 * DAY_MS);
  return {
    start,
    end: now,
    previousStart: new Date(start.getTime() - 7 * DAY_MS),
    dates: Array.from({ length: 7 }, (_, index) =>
      new Date(start.getTime() + index * DAY_MS).toISOString().slice(0, 10)
    ),
  };
}
