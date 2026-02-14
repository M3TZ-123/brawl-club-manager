import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);
    const offset = parseInt(searchParams.get("offset") || "0");
    const mode = searchParams.get("mode") || null;
    const player = searchParams.get("player") || null;

    // Get current member tags and names
    const { data: members } = await supabase
      .from("members")
      .select("player_tag, player_name");

    const nameMap = new Map((members || []).map((m) => [m.player_tag, m.player_name]));
    const clubTags = new Set(nameMap.keys());

    // Build query - fetch raw battles
    let query = supabase
      .from("battle_history")
      .select("*", { count: "exact" })
      .order("battle_time", { ascending: false })
      .range(offset, offset + limit - 1);

    if (mode) {
      query = query.eq("mode", mode);
    }

    if (player) {
      query = query.eq("player_tag", player);
    }

    const { data: battles, error, count } = await query;
    if (error) throw error;

    // Group battles into matches
    // Key: battle_time + mode + map (battles at the same time on the same map = same match)
    const matchMap = new Map<string, {
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
      teams: { tag: string; name: string; brawler: string | null; power: number | null; trophies: number | null }[][] | null;
    }>();

    for (const b of battles || []) {
      const key = `${b.battle_time}|${b.mode}|${b.map}`;

      if (!matchMap.has(key)) {
        // Parse teams_json if available
        let teams = null;
        if (b.teams_json) {
          try {
            teams = typeof b.teams_json === "string" ? JSON.parse(b.teams_json) : b.teams_json;
          } catch { /* ignore */ }
        }

        matchMap.set(key, {
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

      // If this battle has teams_json and the match doesn't yet, use it
      if (!match.teams && b.teams_json) {
        try {
          match.teams = typeof b.teams_json === "string" ? JSON.parse(b.teams_json) : b.teams_json;
        } catch { /* ignore */ }
      }
    }

    // Convert to array, sorted by time descending
    const matches = [...matchMap.values()].sort(
      (a, b) => new Date(b.battle_time).getTime() - new Date(a.battle_time).getTime()
    );

    // For each match, identify which team is "ours" and which is "theirs"
    const enrichedMatches = matches.map((match) => {
      let ourTeam: { tag: string; name: string; brawler: string | null; power: number | null }[] = [];
      let theirTeam: { tag: string; name: string; brawler: string | null; power: number | null }[] = [];

      if (match.teams && match.teams.length >= 2) {
        // Find which team contains a club member
        const clubPlayerTags = new Set(match.clubPlayers.map((p) => p.tag));
        let ourTeamIndex = -1;

        for (let i = 0; i < match.teams.length; i++) {
          const team = match.teams[i];
          if (team.some((p: { tag: string }) => clubPlayerTags.has(p.tag) || clubTags.has(p.tag))) {
            ourTeamIndex = i;
            break;
          }
        }

        if (ourTeamIndex >= 0) {
          ourTeam = match.teams[ourTeamIndex].map((p: { tag: string; name: string; brawler: string | null; power: number | null }) => ({
            tag: p.tag,
            name: nameMap.get(p.tag) || p.name,
            brawler: p.brawler,
            power: p.power,
          }));

          // All other teams are opponents
          for (let i = 0; i < match.teams.length; i++) {
            if (i !== ourTeamIndex) {
              theirTeam.push(
                ...match.teams[i].map((p: { tag: string; name: string; brawler: string | null; power: number | null }) => ({
                  tag: p.tag,
                  name: p.name,
                  brawler: p.brawler,
                  power: p.power,
                }))
              );
            }
          }
        }
      }

      return {
        battle_time: match.battle_time,
        mode: match.mode,
        map: match.map,
        clubPlayers: match.clubPlayers,
        ourTeam: ourTeam.length > 0 ? ourTeam : null,
        theirTeam: theirTeam.length > 0 ? theirTeam : null,
      };
    });

    // Fix timezone offset for existing data: if battles appear in the future, adjust them
    const serverNow = Date.now();
    const matchBattleTimes = enrichedMatches.map(m => new Date(m.battle_time).getTime());
    const maxMatchTime = matchBattleTimes.length > 0 ? Math.max(...matchBattleTimes) : 0;
    
    if (maxMatchTime > serverNow + 60000) { // More than 1 minute in the future
      const rawOffsetMs = maxMatchTime - serverNow;
      const offsetHours = Math.ceil(rawOffsetMs / 3600000);
      const offsetMs = offsetHours * 3600000;
      for (const match of enrichedMatches) {
        match.battle_time = new Date(new Date(match.battle_time).getTime() - offsetMs).toISOString();
      }
    }

    // Get distinct modes for filter
    const { data: modes } = await supabase
      .from("battle_history")
      .select("mode")
      .not("mode", "is", null);

    const uniqueModes = [...new Set((modes || []).map((m) => m.mode))].filter(Boolean).sort();

    // Build members list for filter dropdown
    const memberList = (members || []).map((m) => ({
      tag: m.player_tag,
      name: m.player_name,
    })).sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      matches: enrichedMatches,
      total: count || 0,
      modes: uniqueModes,
      members: memberList,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching battle feed:", error);
    return NextResponse.json({ error: "Failed to fetch battle feed" }, { status: 500 });
  }
}
