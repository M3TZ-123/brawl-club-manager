export type ActivityStatus = "active" | "minimal" | "inactive" | "unknown";

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
  if (timestamp == null || !Number.isFinite(timestamp)) return "unknown";
  const ageMs = now.getTime() - timestamp;
  // Missing or corrupt evidence cannot establish either activity or inactivity.
  if (!Number.isFinite(ageMs) || ageMs < -60_000) return "unknown";
  if (ageMs <= 24 * 60 * 60 * 1000) return "active";
  if (ageMs <= normalizeInactivityThreshold(thresholdHours) * 60 * 60 * 1000) return "minimal";
  return "inactive";
}
