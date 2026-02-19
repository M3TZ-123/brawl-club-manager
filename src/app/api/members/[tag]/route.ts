import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getPlayer, setApiKey, getPlayerRankedData, getLastBattleTime, getPlayerBattleStats, getBrawlerPowerDistribution, calculateEnhancedStats, calculateWinRateFromBattleLog, getPlayerBattleLog } from "@/lib/brawl-api";

type RecentMatch = {
  battle_time: string;
  mode: string | null;
  map: string | null;
  result: string | null;
  trophy_change: number;
  is_star_player: boolean;
  brawler_name: string | null;
  brawler_power: number | null;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tag: string }> }
) {
  try {
    const { tag } = await params;
    const playerTag = decodeURIComponent(tag);

    // Get API key from query params or environment
    const { searchParams } = new URL(request.url);
    const apiKey = searchParams.get('apiKey') || process.env.BRAWL_API_KEY;
    console.log(`[Member API] API key found: ${apiKey ? 'Yes' : 'No'}`);
    if (apiKey) {
      setApiKey(apiKey);
    }

    // Get member from database
    const { data: member, error } = await supabase
      .from("members")
      .select("*")
      .eq("player_tag", playerTag)
      .single();

    if (error || !member) {
      return NextResponse.json(
        { error: "Member not found" },
        { status: 404 }
      );
    }

    // Get activity history
    const { data: activityHistory } = await supabase
      .from("activity_log")
      .select("*")
      .eq("player_tag", playerTag)
      .order("recorded_at", { ascending: false })
      .limit(30);

    // Get recent matches for this player (mini battle feed)
    const { data: recentMatches } = await supabase
      .from("battle_history")
      .select("battle_time, mode, map, result, trophy_change, is_star_player, brawler_name, brawler_power")
      .eq("player_tag", playerTag)
      .order("battle_time", { ascending: false })
      .limit(25);

    // Get member history
    const { data: memberHistory } = await supabase
      .from("member_history")
      .select("*")
      .eq("player_tag", playerTag)
      .single();

    // Get daily stats from database (last 28 days)
    const twentyEightDaysAgo = new Date();
    twentyEightDaysAgo.setDate(twentyEightDaysAgo.getDate() - 28);
    
    const { data: dailyStats } = await supabase
      .from("daily_stats")
      .select("*")
      .eq("player_tag", playerTag)
      .gte("date", twentyEightDaysAgo.toISOString().slice(0, 10))
      .order("date", { ascending: true });

    // Get player tracking info
    const { data: playerTracking } = await supabase
      .from("player_tracking")
      .select("*")
      .eq("player_tag", playerTag)
      .single();

    // Calculate enhanced stats from stored data
    let enhancedStats = null;
    if (dailyStats && dailyStats.length > 0) {
      enhancedStats = calculateEnhancedStats(dailyStats, playerTracking);
    }

    // Fetch additional data from API
    let lastBattleTime = null;
    let battleStats = null;
    let powerDistribution = null;
    let brawlers = null;
    let topBrawlers: Array<{
      id: number;
      name: string;
      trophies: number;
      highestTrophies: number;
      power: number;
      rank: number;
      icon_url: string;
    }> = [];
    let playerTags: string[] = [];

    if (apiKey) {
      try {
        // Run API calls in parallel
        const [battleTimeResult, battleStatsResult, playerData] = await Promise.all([
          getLastBattleTime(playerTag),
          getPlayerBattleStats(playerTag),
          getPlayer(playerTag),
        ]);

        lastBattleTime = battleTimeResult;
        
        // Convert Map and Set to serializable format (this is from current battle log - last 25 battles)
        battleStats = {
          battles: battleStatsResult.battles,
          wins: battleStatsResult.wins,
          losses: battleStatsResult.losses,
          winRate: battleStatsResult.winRate,
          starPlayer: battleStatsResult.starPlayer,
          trophyChange: battleStatsResult.trophyChange,
          activeDays: battleStatsResult.activeDays.size,
          battlesByDay: Object.fromEntries(battleStatsResult.battlesByDay),
        };

        brawlers = playerData.brawlers;
        powerDistribution = getBrawlerPowerDistribution(playerData.brawlers);

        // Top brawlers by trophies
        topBrawlers = [...playerData.brawlers]
          .sort((a, b) => b.trophies - a.trophies)
          .slice(0, 5)
          .map((brawler) => ({
            id: brawler.id,
            name: brawler.name,
            trophies: brawler.trophies,
            highestTrophies: brawler.highestTrophies,
            power: brawler.power,
            rank: brawler.rank,
            icon_url: `https://cdn.brawlify.com/brawlers/borders/${brawler.id}.png`,
          }));

        // Optional player tags (bonus metadata if available)
        const playerProfile = playerData as unknown as {
          title?: string | null;
          nameColor?: string | null;
        };
        const tags: string[] = [];
        if (playerProfile.title && playerProfile.title.trim().length > 0) {
          tags.push(playerProfile.title.trim());
        }
        if (playerProfile.nameColor && playerProfile.nameColor !== "0xffffffff") {
          tags.push("Custom Name Color");
        }
        playerTags = tags;
      } catch (apiError) {
        console.error("Error fetching API data:", apiError);
      }
    }

    // Build calendar data from daily_stats (more reliable than battle log)
    const calendarBattlesByDay: Record<string, number> = {};
    if (dailyStats) {
      for (const stat of dailyStats) {
        if (stat.battles > 0) {
          calendarBattlesByDay[stat.date] = stat.battles;
        }
      }
    }

    // Calculate tracked days from first activity log or member creation
    let trackedDays = 1;
    if (activityHistory && activityHistory.length > 0) {
      const oldest = activityHistory[activityHistory.length - 1]; // oldest (sorted desc)
      const firstDate = new Date(oldest.recorded_at);
      trackedDays = Math.max(1, Math.floor((Date.now() - firstDate.getTime()) / (24 * 60 * 60 * 1000)));
    }

    // Override tracked days in enhanced stats if we have better data
    if (enhancedStats) {
      enhancedStats.trackedDays = trackedDays;
    }

    // Fallback: if API top brawlers unavailable, derive from latest brawler snapshots
    if (topBrawlers.length === 0) {
      const { data: snapshotRows } = await supabase
        .from("brawler_snapshots")
        .select("brawler_id, brawler_name, power_level, trophies, rank, recorded_at")
        .eq("player_tag", playerTag)
        .order("recorded_at", { ascending: false })
        .limit(500);

      const latestByBrawler = new Map<number, {
        brawler_id: number;
        brawler_name: string;
        power_level: number;
        trophies: number;
        rank: number;
        max_trophies: number;
      }>();

      for (const row of snapshotRows || []) {
        const existing = latestByBrawler.get(row.brawler_id);
        if (!existing) {
          latestByBrawler.set(row.brawler_id, {
            brawler_id: row.brawler_id,
            brawler_name: row.brawler_name,
            power_level: row.power_level,
            trophies: row.trophies,
            rank: row.rank,
            max_trophies: row.trophies,
          });
        } else if (row.trophies > existing.max_trophies) {
          existing.max_trophies = row.trophies;
          latestByBrawler.set(row.brawler_id, existing);
        }
      }

      topBrawlers = Array.from(latestByBrawler.values())
        .sort((a, b) => b.trophies - a.trophies)
        .slice(0, 5)
        .map((brawler) => ({
          id: brawler.brawler_id,
          name: brawler.brawler_name,
          trophies: brawler.trophies,
          highestTrophies: brawler.max_trophies,
          power: brawler.power_level,
          rank: brawler.rank,
          icon_url: `https://cdn.brawlify.com/brawlers/borders/${brawler.brawler_id}.png`,
        }));
    }

    return NextResponse.json({
      member,
      activityHistory: activityHistory || [],
      memberHistory,
      lastBattleTime,
      battleStats,
      enhancedStats,
      powerDistribution,
      brawlers,
      topBrawlers,
      recentMatches: (recentMatches || []) as RecentMatch[],
      playerTags,
      calendarBattlesByDay,
    });
  } catch (error) {
    console.error("Error fetching member:", error);
    return NextResponse.json(
      { error: "Failed to fetch member details" },
      { status: 500 }
    );
  }
}

// Refresh individual player data
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tag: string }> }
) {
  try {
    const { tag } = await params;
    const playerTag = decodeURIComponent(tag);
    const body = await request.json();
    const apiKey = body.apiKey || process.env.BRAWL_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "API key required" },
        { status: 400 }
      );
    }

    setApiKey(apiKey);
    
    // Fetch player data, ranked data, and battle log in parallel
    const [player, rankedData, battleLog] = await Promise.all([
      getPlayer(playerTag),
      getPlayerRankedData(playerTag),
      getPlayerBattleLog(playerTag),
    ]);
    
    // Calculate win rate from battle log
    const winRateData = calculateWinRateFromBattleLog(battleLog);

    // Get previous trophies
    const { data: existingMember } = await supabase
      .from("members")
      .select("trophies")
      .eq("player_tag", playerTag)
      .single() as { data: { trophies: number } | null };

    const trophyChange = existingMember
      ? player.trophies - existingMember.trophies
      : 0;

    let activityType = "inactive";
    if (Math.abs(trophyChange) >= 20) {
      activityType = "active";
    } else if (Math.abs(trophyChange) > 0) {
      activityType = "minimal";
    }

    // Update member
    const { data: updatedMember, error } = await supabase
      .from("members")
      .update({
        player_name: player.name,
        trophies: player.trophies,
        highest_trophies: player.highestTrophies,
        exp_level: player.expLevel,
        rank_current: rankedData.currentRank,
        rank_highest: rankedData.highestRank,
        win_rate: winRateData.winRate,
        brawlers_count: player.brawlers.length,
        solo_victories: player.soloVictories,
        duo_victories: player.duoVictories,
        trio_victories: player["3vs3Victories"],
        is_active: activityType === "active",
        last_updated: new Date().toISOString(),
      })
      .eq("player_tag", playerTag)
      .select()
      .single();

    if (error) throw error;

    // Log activity
    await supabase.from("activity_log").insert({
      player_tag: playerTag,
      trophies: player.trophies,
      trophy_change: trophyChange,
      activity_type: activityType,
    });

    return NextResponse.json({
      success: true,
      member: updatedMember,
      brawlers: player.brawlers,
    });
  } catch (error) {
    console.error("Error refreshing member:", error);
    return NextResponse.json(
      { error: "Failed to refresh member data" },
      { status: 500 }
    );
  }
}
