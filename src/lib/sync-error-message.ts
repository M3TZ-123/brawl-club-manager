// User-facing text for retryable sync failures; request IDs remain an API concern.
export function syncErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const code = (payload as { code?: unknown }).code;
  if (code === "database_timeout") return "Sync took too long. Please try again.";
  if (code === "backup_busy") return "A backup is in progress. Please try again shortly.";
  return null;
}
