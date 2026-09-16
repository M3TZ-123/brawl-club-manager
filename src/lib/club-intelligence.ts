import { publicClubMetadata } from "./club-intelligence-snapshot";
import type { ActivityCell, ClubIntelligenceRange, ClubIntelligenceResponse, ClubRosterMember, MembershipSpell } from "./club-intelligence-types";

type Row = Record<string, unknown>;
const DAY = 86_400_000;
const object = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid club intelligence response");
  return value as Row;
};
const rows = (value: unknown, limit: number): Row[] => {
  if (!Array.isArray(value) || value.length > limit) throw new Error("Club intelligence response exceeded its limit");
  return value.map(object);
};
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid club intelligence count");
  return value;
};
const text = (value: unknown, max = 160) => {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid club intelligence text");
  return value;
};
const date = (value: unknown, now: number): string | null => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= now ? new Date(at).toISOString() : null;
};
const source = (value: unknown): MembershipSpell["source"] => value === "recorded" || value === "reconstructed" ? value : "unknown";
const roster = (value: unknown): ClubRosterMember[] => {
  const members = rows(value, 100).map(row => ({ tag: text(row.tag, 30), name: text(row.name), role: text(row.role), trophies: count(row.trophies) }));
  if (new Set(members.map(member => member.tag)).size !== members.length) throw new Error("Duplicate snapshot member");
  return members;
};
export function intelligenceRange(value: string | null): ClubIntelligenceRange {
  if (value === null || value === "7d") return "7d";
  if (value === "30d" || value === "90d") return value;
  throw new Error("Choose a 7, 30 or 90 day club period.");
}
export function activityCellLink(tag: string, day: string) {
  return `/battle-feed?${new URLSearchParams({ member: tag, day })}`;
}

export function buildClubIntelligence(value: unknown, range: ClubIntelligenceRange, now = new Date()): ClubIntelligenceResponse {
  const raw = object(value), ms = now.getTime(), daysCount = Number.parseInt(range, 10);
  const today = Date.parse(now.toISOString().slice(0, 10)), generatedAt = now.toISOString();
  const days = Array.from({ length: daysCount }, (_, i) => new Date(today - (daysCount - i - 1) * DAY).toISOString().slice(0, 10));
  const members = rows(raw.members, 100).map(row => ({ ...roster([row])[0], rank: typeof row.rank === "string" ? text(row.rank) : null,
    updatedAt: date(row.updatedAt, ms), inventory: count(row.inventory), unknownPower: count(row.unknownPower),
    power9: count(row.power9), power10: count(row.power10), power11: count(row.power11) }));
  const tags = new Set(members.map(member => member.tag));
  const daily = new Map(rows(raw.daily, 9000).map(row => [`${text(row.tag, 30)}:${text(row.day, 10)}`, {
    battles: row.battles == null ? null : count(row.battles), wins: row.wins == null ? null : count(row.wins),
  }]));
  const coverage = new Map(rows(raw.coverage, 100).map(row => [text(row.tag, 30), { baseline: date(row.baselineAt, ms), checked: date(row.checkedAt, ms) }]));
  const gaps = rows(raw.gaps, 10000).map(row => ({ tag: text(row.tag, 30), start: date(row.start, ms), end: date(row.end, ms) }));
  const calendarRows = members.map(member => {
    const evidence = coverage.get(member.tag), baseline = evidence?.baseline || null, checked = evidence?.checked || null;
    const cells: ActivityCell[] = days.map(day => {
      const start = Date.parse(day), end = start + DAY;
      const entry = daily.get(`${member.tag}:${day}`);
      let quality: ActivityCell["coverage"] = "monitored";
      if (!baseline || Date.parse(baseline) >= end) quality = "before_tracking";
      else if (Date.parse(baseline) > start) quality = "partial";
      else if (start < ms - 28 * DAY) quality = "limited";
      else if (!checked || Date.parse(checked) < end || end > ms) quality = "partial";
      if (gaps.some(gap => gap.tag === member.tag && gap.start && gap.end && Date.parse(gap.start) < end && Date.parse(gap.end) >= start)) quality = "possible_gap";
      return { day, battles: entry ? entry.battles : quality === "monitored" ? 0 : null, wins: entry?.wins ?? null,
        coverage: quality, href: activityCellLink(member.tag, day) };
    });
    return { playerTag: member.tag, playerName: member.name, baselineAt: baseline, lastCheckedAt: checked,
      observedBattles: cells.reduce((sum, cell) => sum + (cell.battles || 0), 0), cells };
  });

  const snapshots = rows(raw.snapshots, 93).flatMap(row => [
    { at: date(row.firstAt, ms), members: roster(row.first) }, { at: date(row.lastAt, ms), members: roster(row.last) },
  ]).filter((row): row is { at: string; members: ClubRosterMember[] } => row.at !== null).sort((a, b) => a.at.localeCompare(b.at));
  const uniqueSnapshots = [...new Map(snapshots.map(row => [row.at, row])).values()];
  const cutoff = ms - daysCount * DAY;
  const start = uniqueSnapshots.filter(row => Date.parse(row.at) <= cutoff && Date.parse(row.at) >= cutoff - 36 * 3_600_000).at(-1);
  const end = uniqueSnapshots.at(-1);
  const comparable = !!start && !!end && end.at > start.at;
  const first = new Map((start?.members || []).map(member => [member.tag, member]));
  const last = new Map((end?.members || []).map(member => [member.tag, member]));
  const common = [...first.keys()].filter(tag => last.has(tag));
  const added = [...last.keys()].filter(tag => !first.has(tag));
  const removed = [...first.keys()].filter(tag => !last.has(tag));
  const total = (items: ClubRosterMember[]) => items.reduce((sum, member) => sum + member.trophies, 0);

  const events = rows(raw.events, 20001).map(row => ({ id: text(row.id, 100), tag: text(row.tag, 30), name: text(row.name),
    type: text(row.type, 30), at: date(row.at, ms), source: source(row.source) })).filter((event): event is typeof event & { at: string } => event.at !== null)
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const spells: MembershipSpell[] = [], open = new Map<string, MembershipSpell>(), visited = new Set<string>();
  for (const event of events) {
    if (event.type === "leave") {
      const spell = open.get(event.tag);
      if (spell) { spell.endedAt = event.at; if (event.source !== "recorded") spell.uncertain = true; open.delete(event.tag); }
      visited.add(event.tag);
    } else if (event.type === "join" || event.type === "initial_seen") {
      const previous = open.get(event.tag);
      if (previous) previous.uncertain = true;
      const spell: MembershipSpell = { playerTag: event.tag, playerName: event.name, startedAt: event.at, endedAt: null,
        kind: event.type === "join" ? "join" : "first_observed", source: event.source, returning: visited.has(event.tag), uncertain: !!previous };
      spells.push(spell); open.set(event.tag, spell);
    }
  }
  for (const spell of open.values()) if (!tags.has(spell.playerTag)) spell.uncertain = true;
  const followupAt = end?.at || null, cohortStart = ms - 90 * DAY;
  const cohorts = ([7, 30] as const).map(horizon => {
    let eligible = 0, retained = 0, departed = 0, pending = 0, excluded = 0;
    for (const spell of spells.filter(spell => Date.parse(spell.startedAt) >= cohortStart)) {
      if (spell.kind !== "join" || spell.source !== "recorded" || spell.uncertain || raw.eventsTruncated === true) { excluded++; continue; }
      const due = Date.parse(spell.startedAt) + horizon * DAY;
      if (due > ms || (!spell.endedAt && (!followupAt || Date.parse(followupAt) < due))) { pending++; continue; }
      eligible++;
      if (spell.endedAt && Date.parse(spell.endedAt) < due) departed++; else retained++;
    }
    return { days: horizon, eligible, retained, departed, pending, excluded, rate: eligible ? Math.round(retained * 1000 / eligible) / 10 : null };
  });
  const values = members.map(member => member.trophies).sort((a, b) => a - b), midpoint = Math.floor(values.length / 2);
  const rankCounts = new Map<string | null, number>();
  members.forEach(member => rankCounts.set(member.rank, (rankCounts.get(member.rank) || 0) + 1));
  const profile = raw.profile ? object(raw.profile) : null;
  const metadataHistory = rows(raw.metadataHistory, 50).flatMap(row => {
    const at = date(row.at, ms); if (!at) return [];
    return [{ id: text(row.id, 100), observedAt: at, before: row.before == null ? null : publicClubMetadata(row.before),
      after: publicClubMetadata(row.after), changedFields: Array.isArray(row.fields) ? row.fields.filter((field): field is string => typeof field === "string" && ["name", "description", "type", "badgeId", "requiredTrophies"].includes(field)) : [] }];
  });
  return {
    club: { tag: text(raw.clubTag, 30), metadata: profile ? publicClubMetadata(profile.metadata) : null, observedAt: profile ? date(profile.observedAt, ms) : null,
      memberCount: members.length, rosterTrophies: total(members), openSeats: Math.max(0, 30 - members.length),
      leaders: members.filter(member => ["president", "vicepresident"].includes(member.role.toLowerCase())).map(({ tag, name, role }) => ({ tag, name, role })) },
    calendar: { days, timezone: "UTC", rows: calendarRows, observedParticipations: calendarRows.reduce((sum, row) => sum + row.observedBattles, 0),
      recordedDays: new Set(calendarRows.flatMap(row => row.cells.filter(cell => (cell.battles || 0) > 0).map(cell => cell.day))).size, gapHistoryDays: 28, completeHistory: false },
    growth: { requestedStart: new Date(cutoff).toISOString(), availableFrom: uniqueSnapshots[0]?.at || null, startAt: start?.at || null, endAt: end?.at || null,
      status: comparable ? "observed" : "insufficient_history", startTotal: comparable ? total(start.members) : null, endTotal: end ? total(end.members) : null,
      totalChange: comparable ? total(end.members) - total(start.members) : null,
      commonProgress: comparable ? common.reduce((sum, tag) => sum + last.get(tag)!.trophies - first.get(tag)!.trophies, 0) : null,
      addedTrophies: comparable ? added.reduce((sum, tag) => sum + last.get(tag)!.trophies, 0) : null,
      removedTrophies: comparable ? removed.reduce((sum, tag) => sum + first.get(tag)!.trophies, 0) : null,
      commonMembers: comparable ? common.length : 0, addedMembers: comparable ? added.length : 0, removedMembers: comparable ? removed.length : 0,
      returningMembers: comparable ? common.filter(tag => events.some(event => event.tag === tag && event.type === "leave" && event.at > start.at && event.at <= end.at
        && events.some(join => join.tag === tag && join.type === "join" && join.at > event.at && join.at <= end.at))).length : 0,
      points: [...new Map(uniqueSnapshots.filter(row => Date.parse(row.at) >= cutoff).map(row => [row.at.slice(0, 10), row])).values()]
        .map(row => ({ observedAt: row.at, totalTrophies: total(row.members), members: row.members.length })) },
    strength: { observedAt: members.map(member => member.updatedAt).filter((at): at is string => !!at).sort()[0] || null,
      members: members.length, medianTrophies: values.length ? values.length % 2 ? values[midpoint] : (values[midpoint - 1] + values[midpoint]) / 2 : null,
      top10Average: values.length ? Math.round(values.slice(-10).reduce((sum, n) => sum + n, 0) / Math.min(10, values.length)) : null, topCount: Math.min(10, values.length),
      trophyBands: [0, 10000, 20000, 30000, 50000, 100000].map((min, i, bands) => ({ min, max: bands[i + 1] ?? null, members: values.filter(n => n >= min && (bands[i + 1] === undefined || n < bands[i + 1])).length })),
      ranks: [...rankCounts].map(([rank, members]) => ({ rank, members })), inventoryMembers: members.filter(member => member.inventory > 0).length,
      brawlersObserved: members.reduce((sum, member) => sum + member.inventory, 0), unknownPower: members.reduce((sum, member) => sum + member.unknownPower, 0),
      power: ([9, 10, 11] as const).map(minimum => ({ minimum, brawlers: members.reduce((sum, member) => sum + member[`power${minimum}`], 0), members: members.filter(member => member[`power${minimum}`] > 0).length })) },
    retention: { cohortStart: new Date(cohortStart).toISOString(), followupAt, cohorts, spells: spells.slice(-200).reverse(), truncated: raw.eventsTruncated === true || spells.length > 200 },
    metadataHistory, generatedAt,
  };
}
