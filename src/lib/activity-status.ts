export type ActivityStatus = "active" | "minimal" | "inactive";

export function normalizeInactivityThreshold(value: unknown): number {
  const hours = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(hours) ? Math.min(Math.max(hours, 48), 168) : 48;
}

export function classifyActivity(
  lastActivityAt: Date | null | undefined,
  now = new Date(),
  thresholdHours = 48
): ActivityStatus {
  const timestamp = lastActivityAt?.getTime();
  if (timestamp == null || !Number.isFinite(timestamp)) return "inactive";
  const ageMs = now.getTime() - timestamp;
  // Do not let corrupt future timestamps keep a player active indefinitely.
  if (ageMs < -60_000) return "inactive";
  if (ageMs <= 24 * 60 * 60 * 1000) return "active";
  if (ageMs <= normalizeInactivityThreshold(thresholdHours) * 60 * 60 * 1000) return "minimal";
  return "inactive";
}
