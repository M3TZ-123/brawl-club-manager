import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseTimeRange, TIME_RANGES } from "@/lib/time-range";

function parseBoundedInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

type BattleModeRow = {
  mode: string | null;
};

function normalizeTag(tag: string): string {
  const decoded = tag.trim().replace(/^%23/i, "#").toUpperCase();
  return decoded.startsWith("#") ? decoded : `#${decoded}`;
}

function participantKey(raw: unknown, mode: string | null, playerTag: string): string | null {
  // Missing opponents can make two partial rosters look identical. Only known
  // complete mode rosters may identify a shared match; unknown formats stay apart.
  const expectedPlayers: Record<string, number> = {
    gemgrab: 6, brawlball: 6, heist: 6, bounty: 6, siege: 6, hotzone: 6,
    knockout: 6, wipeout: 6, payload: 6, trophythieves: 6, paintbrawl: 6,
    basketbrawl: 6, volleybrawl: 6, holdthetrophy: 6, airhockey: 6, brawlarena: 6,
    brawlball5v5: 10, gemgrab5v5: 10, wipeout5v5: 10, knockout5v5: 10,
    soloshowdown: 10, duoshowdown: 10, showdown: 10, trioshowdown: 12,
    duels: 2, biggame: 6, bossfight: 3, roborumble: 3, laststand: 3,
    lonestar: 10, takedown: 10, hunters: 10,
  };
  const expected = expectedPlayers[mode?.toLowerCase() || ""];
  if (!expected || !raw || typeof raw !== "object") return null;
  const object = raw as Record<string, unknown>;
  const source = Array.isArray(raw) ? raw : Array.isArray(object.teams) ? object.teams : object.players;
  if (!Array.isArray(source) || source.length === 0) return null;
  const nested = Array.isArray(source[0]);
  if (source.some(value => Array.isArray(value) !== nested || (Array.isArray(value) && value.length === 0))) return null;
  const players: unknown[] = nested ? source.flat() : source;
  if (players.length !== expected) return null;
  const tags: string[] = [];
  for (const player of players) {
    if (!player || typeof player !== "object" || !("tag" in player) || typeof player.tag !== "string") return null;
    const tag = normalizeTag(player.tag);
    if (!/^#[A-Z0-9]{1,20}$/.test(tag)) return null;
    tags.push(tag);
  }
  if (new Set(tags).size !== tags.length || !tags.includes(normalizeTag(playerTag))) return null;
  return JSON.stringify(tags.sort());
}

async function fetchRecentBattleModes(playerTags: string[]): Promise<BattleModeRow[]> {
  if (playerTags.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("battle_history")
    .select("mode")
    .in("player_tag", playerTags)
    .not("mode", "is", null)
    .order("battle_time", { ascending: false })
    .order("player_tag", { ascending: true })
    .limit(1500);

  if (error) throw error;
  return (data || []) as BattleModeRow[];
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseBoundedInt(searchParams.get("limit"), 50, 1, 200);
    const offset = parseBoundedInt(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const mode = searchParams.get("mode") || null;
    const player = searchParams.get("player") || null;
    const date = searchParams.get("date") || null; // YYYY-MM-DD
    const range = searchParams.get("range");
    const now = Date.now();
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) {
      return NextResponse.json({ error: "Invalid date" }, { status: 400 });
    }

    // Get only current club member tags from member_history
    const { data: currentMemberHistory, error: historyError } = await supabaseAdmin
      .from("member_history")
      .select("player_tag")
      .eq("is_current_member", true);
    if (historyError) throw historyError;

    const currentMemberTags = currentMemberHistory?.map((m) => m.player_tag) || [];

    // Get current member names from members table
    const { data: members, error: membersError } = await supabaseAdmin
      .from("members")
      .select("player_tag, player_name")
      .in("player_tag", currentMemberTags.length > 0 ? currentMemberTags : [""]);
    if (membersError) throw membersError;

    const nameMap = new Map((members || []).map((m) => [m.player_tag, m.player_name]));
    const clubTags = new Set(nameMap.keys());

    const buildBattleQuery = () => {
      let query = supabaseAdmin
        .from("battle_history")
        .select(
          "player_tag, battle_time, mode, map, result, trophy_change, is_star_player, brawler_name, brawler_power, teams_json",
          { count: "exact" }
        )
        .in("player_tag", currentMemberTags.length > 0 ? currentMemberTags : [""])
        .order("battle_time", { ascending: false })
        .order("player_tag", { ascending: true });

      if (mode) query = query.eq("mode", mode);
      if (player) query = query.eq("player_tag", player);

      if (date) {
        const dayStart = `${date}T00:00:00.000Z`;
        const dayEnd = `${date}T23:59:59.999Z`;
        query = query.gte("battle_time", dayStart).lte("battle_time", dayEnd);
      } else if (range != null) {
        query = query.gte("battle_time", new Date(now - TIME_RANGES[parseTimeRange(range)].days * 86_400_000).toISOString());
      }
      query = query.lte("battle_time", new Date(now + 60_000).toISOString());
      return query;
    };

    const { data: page, error, count } = await buildBattleQuery().range(offset, offset + limit - 1);
    if (error) throw error;
    const battles = [...(page || [])];

    // Finish every match at the boundary timestamp before advancing the cursor.
    // Team members can straddle the raw row limit, and same-time matches can interleave.
    const boundaryTime = battles.at(-1)?.battle_time;
    if (boundaryTime && offset + battles.length < (count || 0)) {
      const boundaryRows = battles.filter((battle) => battle.battle_time === boundaryTime).length;
      battles.splice(battles.length - boundaryRows, boundaryRows);
      const batchSize = 200;
      for (let boundaryOffset = 0; ; boundaryOffset += batchSize) {
        const { data: tail, error: tailError } = await buildBattleQuery()
          .eq("battle_time", boundaryTime)
          .range(boundaryOffset, boundaryOffset + batchSize - 1);
        if (tailError) throw tailError;
        battles.push(...(tail || []));
        if (!tail || tail.length < batchSize) break;
      }
    }
    const nextOffset = offset + battles.length;

    // A timestamp/map can contain separate matches. Shared identity additionally
    // requires the same complete participant set, independent of team ordering.
    const matchMap = new Map<string, {
      matchId: string;
      battle_time: string;
      mode: string;
      map: string;
      clubPlayers: {
        tag: string;
        name: string;
        brawler: string | null;
        power: number | null;
        result: string;
        trophy_change: number;
        is_star_player: boolean;
      }[];
      teams: unknown;
    }>();

    for (const b of battles || []) {
      let teams: unknown = null;
      if (b.teams_json) {
        try { teams = typeof b.teams_json === "string" ? JSON.parse(b.teams_json) : b.teams_json; } catch { /* Keep this observation separate. */ }
      }
      const participants = participantKey(teams, b.mode, b.player_tag);
      const key = JSON.stringify([b.battle_time, b.mode, b.map,
        participants ? ["participants", participants] : ["observation", normalizeTag(b.player_tag)]]);

      if (!matchMap.has(key)) {
        matchMap.set(key, {
          matchId: key,
          battle_time: b.battle_time,
          mode: b.mode || "unknown",
          map: b.map || "unknown",
          clubPlayers: [],
          teams,
        });
      }

      const match = matchMap.get(key)!;
      // Add this club member to the match (avoid duplicates)
      if (!match.clubPlayers.some((p) => p.tag === b.player_tag)) {
        match.clubPlayers.push({
          tag: b.player_tag,
          name: nameMap.get(b.player_tag) || b.player_tag,
          brawler: b.brawler_name,
          power: b.brawler_power,
          result: b.result || "unknown",
          trophy_change: b.trophy_change || 0,
          is_star_player: b.is_star_player || false,
        });
      }

    }

    // Convert to array, sorted by time descending
    const matches = [...matchMap.values()].sort(
      (a, b) => new Date(b.battle_time).getTime() - new Date(a.battle_time).getTime()
    );

    // Detect Showdown modes
    const isShowdownMode = (mode: string) =>
      mode === "soloShowdown" || mode === "duoShowdown" || mode === "showdown";

    type RawPlayer = {
      tag?: string;
      name?: string;
      brawler?: string | null;
      power?: number | null;
      trophies?: number | null;
    };

    type TeamPlayer = { tag: string; name: string; brawler: string | null; power: number | null; trophies: number | null };

    const toTeamPlayer = (p: RawPlayer): TeamPlayer | null => {
      if (typeof p?.tag !== "string" || !p.tag.trim()) return null;
      const tag = normalizeTag(p.tag);
      return {
        tag,
        name: nameMap.get(tag) || p.name || tag,
        brawler: p.brawler ?? null,
        power: p.power ?? null,
        trophies: p.trophies ?? null,
      };
    };

    const normalizeTeams = (raw: unknown): TeamPlayer[][] => {
      if (!raw) return [];

      const value = raw as unknown;
      const asObject = typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

      const source =
        Array.isArray(value) ? value :
        Array.isArray(asObject?.teams) ? asObject.teams :
        Array.isArray(asObject?.players) ? asObject.players :
        [];

      if (!Array.isArray(source) || source.length === 0) return [];

      const first = source[0];

      // Flat players array => showdown-style one player per team
      if (!Array.isArray(first)) {
        return source
          .map((player) => toTeamPlayer(player as RawPlayer))
          .filter((player): player is TeamPlayer => !!player)
          .map((player) => [player]);
      }

      // teams[][] shape
      return source
        .map((team) =>
          (Array.isArray(team) ? team : [])
            .map((player) => toTeamPlayer(player as RawPlayer))
            .filter((player): player is TeamPlayer => !!player)
        )
        .filter((team) => team.length > 0);
    };

    // For each match, identify which team is "ours" and which is "theirs"
    const enrichedMatches = matches.map((match) => {
      let ourTeam: { tag: string; name: string; brawler: string | null; power: number | null }[] = [];
      const theirTeam: { tag: string; name: string; brawler: string | null; power: number | null }[] = [];
      const isShowdown = isShowdownMode(match.mode);

      const normalizedTeams = normalizeTeams(match.teams);

      if (normalizedTeams.length > 0) {
        const clubPlayerTags = new Set(match.clubPlayers.map((p) => p.tag));

        if (isShowdown) {
          // Showdown: each "team" is a single player (solo) or a duo
          // Club player(s) go into ourTeam, everyone else into theirTeam
          for (const team of normalizedTeams) {
            const hasClubPlayer = team.some((p: { tag: string }) => {
              const nt = normalizeTag(p.tag);
              return clubPlayerTags.has(nt) || clubTags.has(nt);
            });
            const mapped = team.map((p: { tag: string; name: string; brawler: string | null; power: number | null }) => ({
              tag: normalizeTag(p.tag),
              name: nameMap.get(normalizeTag(p.tag)) || p.name,
              brawler: p.brawler,
              power: p.power,
            }));
            if (hasClubPlayer) {
              ourTeam.push(...mapped);
            } else {
              theirTeam.push(...mapped);
            }
          }
        } else {
          // Standard team modes: find which team contains a club member
          let ourTeamIndex = -1;

          for (let i = 0; i < normalizedTeams.length; i++) {
            const team = normalizedTeams[i];
            if (team.some((p: { tag: string }) => {
              const nt = normalizeTag(p.tag);
              return clubPlayerTags.has(nt) || clubTags.has(nt);
            })) {
              ourTeamIndex = i;
              break;
            }
          }

          if (ourTeamIndex >= 0) {
            ourTeam = normalizedTeams[ourTeamIndex].map((p: { tag: string; name: string; brawler: string | null; power: number | null }) => ({
              tag: normalizeTag(p.tag),
              name: nameMap.get(normalizeTag(p.tag)) || p.name,
              brawler: p.brawler,
              power: p.power,
            }));

            // All other teams are opponents
            for (let i = 0; i < normalizedTeams.length; i++) {
              if (i !== ourTeamIndex) {
                theirTeam.push(
                  ...normalizedTeams[i].map((p: { tag: string; name: string; brawler: string | null; power: number | null }) => ({
                    tag: normalizeTag(p.tag),
                    name: nameMap.get(normalizeTag(p.tag)) || p.name,
                    brawler: p.brawler,
                    power: p.power,
                  }))
                );
              }
            }
          }
        }
      }

      return {
        matchId: match.matchId,
        battle_time: match.battle_time,
        mode: match.mode,
        map: match.map,
        clubPlayers: match.clubPlayers,
        ourTeam: ourTeam.length > 0 ? ourTeam : null,
        theirTeam: theirTeam.length > 0 ? theirTeam : null,
        isShowdown,
      };
    });

    // Get distinct modes for filter
    const modes = await fetchRecentBattleModes(currentMemberTags);

    const uniqueModes = [...new Set(modes.map((m) => m.mode))].filter(Boolean).sort();

    // Build members list for filter dropdown
    const memberList = (members || []).map((m) => ({
      tag: m.player_tag,
      name: m.player_name,
    })).sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      matches: enrichedMatches,
      total: count || 0,
      nextOffset: nextOffset < (count || 0) ? nextOffset : null,
      modes: uniqueModes,
      members: memberList,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching battle feed:", error);
    return NextResponse.json({ error: "Failed to fetch battle feed" }, { status: 500 });
  }
}
