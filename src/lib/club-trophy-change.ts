export type ClubTrophyChange = {
  status: "complete_period" | "partial_period" | "insufficient_history";
  requestedStart: string;
  requestedEnd: string;
  startAt: string | null;
  endAt: string | null;
  totalChange: number | null;
  commonProgress: number | null;
  addedTrophies: number | null;
  removedTrophies: number | null;
  commonMembers: number | null;
  addedMembers: number | null;
  removedMembers: number | null;
  points: Array<{ day: string; observedAt: string; totalTrophies: number; members: number }>;
};

type Member = { tag: string; trophies: number };
type Observation = { at: string; time: number; members: Member[]; total: number };
const DAY_MS = 86_400_000;
const BASELINE_AGE_MS = 36 * 3_600_000;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid roster history");
  return value as Record<string, unknown>;
}

function members(value: unknown): Member[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid roster history");
  const result = value.map(value => {
    const member = record(value);
    if (typeof member.tag !== "string" || !/^#[A-Z0-9]{2,20}$/.test(member.tag)
      || typeof member.trophies !== "number" || !Number.isSafeInteger(member.trophies)
      || member.trophies < 0 || member.trophies > 2_147_483_647) throw new Error("Invalid roster history");
    return { tag: member.tag, trophies: member.trophies };
  });
  if (new Set(result.map(member => member.tag)).size !== result.length) throw new Error("Invalid roster history");
  return result;
}

/** Compare complete observed rosters, without implying progress was earned while continuously in this club. */
export function buildClubTrophyChange(value: unknown, requestedStart: Date, requestedEnd: Date): ClubTrophyChange {
  const startMs = requestedStart.getTime(), endMs = requestedEnd.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || endMs - startMs > 90 * DAY_MS) {
    throw new Error("Invalid roster history period");
  }
  if (!Array.isArray(value) || value.length > 93) throw new Error("Invalid roster history");

  const observations: Observation[] = [];
  const days = new Set<string>();
  for (const valueRow of value) {
    const row = record(valueRow), day = row.snapshot_day;
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || days.has(day)) throw new Error("Invalid roster history");
    days.add(day);
    const firstMs = typeof row.first_observed_at === "string" ? Date.parse(row.first_observed_at) : NaN;
    const lastMs = typeof row.last_observed_at === "string" ? Date.parse(row.last_observed_at) : NaN;
    if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || firstMs > lastMs
      || new Date(firstMs).toISOString().slice(0, 10) !== day || new Date(lastMs).toISOString().slice(0, 10) !== day) {
      throw new Error("Invalid roster history");
    }
    for (const [time, roster] of [[firstMs, row.first_members], [lastMs, row.last_members]] as const) {
      // A future or out-of-range endpoint must never become a baseline or latest result.
      if (time < startMs - BASELINE_AGE_MS || time > endMs) continue;
      const projected = members(roster);
      observations.push({ at: new Date(time).toISOString(), time, members: projected,
        total: projected.reduce((sum, member) => sum + member.trophies, 0) });
    }
  }
  observations.sort((a, b) => a.time - b.time);
  const unique = [...new Map(observations.map(observation => [observation.at, observation])).values()];
  const inPeriod = unique.filter(observation => observation.time >= startMs);
  const baseline = unique.filter(observation => observation.time <= startMs).at(-1);
  const start = baseline || inPeriod[0];
  const end = inPeriod.at(-1);
  const comparable = !!start && !!end && end.time > start.time;
  const first = new Map((start?.members || []).map(member => [member.tag, member.trophies]));
  const last = new Map((end?.members || []).map(member => [member.tag, member.trophies]));
  const common = [...first.keys()].filter(tag => last.has(tag));
  const added = [...last.keys()].filter(tag => !first.has(tag));
  const removed = [...first.keys()].filter(tag => !last.has(tag));

  return {
    status: comparable ? baseline ? "complete_period" : "partial_period" : "insufficient_history",
    requestedStart: requestedStart.toISOString(), requestedEnd: requestedEnd.toISOString(),
    startAt: start?.at || null, endAt: end?.at || null,
    totalChange: comparable ? end.total - start.total : null,
    commonProgress: comparable ? common.reduce((sum, tag) => sum + last.get(tag)! - first.get(tag)!, 0) : null,
    addedTrophies: comparable ? added.reduce((sum, tag) => sum + last.get(tag)!, 0) : null,
    removedTrophies: comparable ? removed.reduce((sum, tag) => sum + first.get(tag)!, 0) : null,
    commonMembers: comparable ? common.length : null,
    addedMembers: comparable ? added.length : null,
    removedMembers: comparable ? removed.length : null,
    points: [...new Map(inPeriod.map(observation => [observation.at.slice(0, 10), observation])).entries()]
      .map(([day, observation]) => ({ day, observedAt: observation.at, totalTrophies: observation.total, members: observation.members.length })),
  };
}
