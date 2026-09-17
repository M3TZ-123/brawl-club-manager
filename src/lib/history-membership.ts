import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { MemberHistory } from "@/types/database";

type MembershipEvent = NonNullable<MemberHistory["latest_membership_event"]>;
type EventTime = { at: string; time: string };
type Candidate = MembershipEvent & { id: string; time: string };
export type HistoryMemberRow = Record<string, unknown> & {
  player_tag: string;
  first_seen?: string | null;
  last_left_at?: string | null;
  last_seen?: string | null;
  is_current_member?: boolean | null;
};
const PAGE_SIZE = 1000;
const TAG_BATCH_SIZE = 200;
const MEMBERSHIP_TYPES = ["join", "leave", "initial_seen"] as const;
const SOURCE_PRIORITY = { recorded: 2, reconstructed: 1, unknown: 0 };

function timestamp(value: unknown, now: Date): EventTime | null {
  const time = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time > now.getTime()) return null;
  const iso = new Date(time).toISOString();
  const extra = typeof value === "string" ? (/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/i.exec(value)?.[1] || "").padEnd(6, "0").slice(3, 6) : "000";
  const precise = iso.replace(/Z$/, `${extra}Z`);
  if (precise > now.toISOString().replace(/Z$/, "000Z")) return null;
  return { at: extra === "000" ? iso : precise, time: precise };
}

function newer(first: Candidate | undefined, second: Candidate): Candidate {
  if (!first || second.time > first.time) return second;
  if (second.time < first.time) return first;
  const priority = SOURCE_PRIORITY[second.source] - SOURCE_PRIORITY[first.source];
  return priority > 0 || priority === 0 && second.id > first.id ? second : first;
}

export async function historyClubTag(): Promise<string> {
  const { data, error } = await supabaseAdmin.from("settings").select("value").eq("key", "club_tag").maybeSingle();
  if (error) throw new Error("Club history configuration is unavailable");
  const value = String(data?.value || process.env.CLUB_TAG || "").trim().replace(/^%23/i, "#");
  const tag = `#${value.replace(/^#/, "").toUpperCase()}`;
  if (!/^#[A-Z0-9]{1,20}$/.test(tag)) throw new Error("Club history configuration is unavailable");
  return tag;
}

/** The canonical audit already includes imported legacy events and their original provenance. */
export async function latestHistoryMembershipEvents(clubTag: string, history: HistoryMemberRow[], now: Date): Promise<Map<string, MembershipEvent | null>> {
  const tags = [...new Set(history.map(row => row.player_tag))];
  const latest = new Map<string, Candidate>();
  for (let batch = 0; batch < tags.length; batch += TAG_BATCH_SIZE) {
    const remaining = new Set(tags.slice(batch, batch + TAG_BATCH_SIZE));
    let from = 0;
    while (remaining.size) {
      const { data, error } = await supabaseAdmin.from("membership_change_events")
        .select("id,player_tag,event_type,occurred_at,source")
        .eq("club_tag", clubTag).in("player_tag", [...remaining]).in("event_type", [...MEMBERSHIP_TYPES])
        .lte("occurred_at", now.toISOString())
        .order("occurred_at", { ascending: false }).order("id", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new Error("Membership history is unavailable");
      const events = data || [];
      if (events.length > PAGE_SIZE) throw new Error("Invalid membership history page");
      for (const event of events) {
        const observed = timestamp(event.occurred_at, now);
        if (!remaining.has(event.player_tag) || !observed || !MEMBERSHIP_TYPES.includes(event.event_type)
          || typeof event.id !== "string") continue;
        const source = event.source === "recorded" || event.source === "reconstructed" ? event.source : "unknown";
        latest.set(event.player_tag, newer(latest.get(event.player_tag), { type: event.event_type, ...observed, source, id: event.id }));
      }
      if (events.length < PAGE_SIZE) break;
      const tailAt = timestamp(events.at(-1)?.occurred_at, now);
      // Finish every tie at the page boundary before trusting provenance. Once
      // resolved, remove busy players from the next query instead of scanning
      // their entire audit history to reach another player's latest event.
      const resolved = tailAt ? [...remaining].filter(tag => (latest.get(tag)?.time || "") > tailAt.time) : [];
      if (resolved.length) {
        resolved.forEach(tag => remaining.delete(tag));
        from = 0;
      } else from += PAGE_SIZE;
    }
  }

  return new Map(history.map(row => {
    let selected = latest.get(row.player_tag);
    const firstSeen = timestamp(row.first_seen, now), lastLeft = timestamp(row.last_left_at, now);
    if (firstSeen) selected = newer(selected, { type: "initial_seen", ...firstSeen, source: "unknown", id: "" });
    if (lastLeft) selected = newer(selected, { type: "leave", ...lastLeft, source: "unknown", id: "leave" });
    // last_seen is a routine observation, not proof of a membership change.
    return [row.player_tag, selected ? { type: selected.type, at: selected.at, source: selected.source } : null];
  }));
}
