// Game color markup is presentation-only. Keep every other character as text;
// callers must still render this through React's normal text escaping.
export function stripBrawlColorTags(text: string): string {
  return text.replace(/<c(?:[0-9a-f]{6}|[0-9a-f]{8}|[0-9]{1,2})>|<\/c>/gi, "");
}

export function formatBrawlName(name: string | null | undefined, fallback: string): string {
  return stripBrawlColorTags(name ?? "").trim() || fallback;
}
