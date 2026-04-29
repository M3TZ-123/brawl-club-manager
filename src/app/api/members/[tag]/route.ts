import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getPlayer, getPlayerRankedData, getLastBattleTime, getPlayerBattleStats, getBrawlerPowerDistribution, calculateEnhancedStats, calculateWinRateFromBattleLog, getPlayerBattleLog, processBattleLog, BrawlStarsBattleLog } from "@/lib/brawl-api";
import { rejectCrossOriginRequest } from "@/lib/request-security";

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

type ActivityHistoryRow = {
  id: number;
  player_tag: string;
  trophies: number;
  trophy_change: number;
  activity_type: string;
  recorded_at: string;
};

type StoredBattleForStats = {
  player_tag: string;
  battle_time: string;
  result: string | null;
  trophy_change: number | null;
  is_star_player: boolean | null;
};

async function fetchActivityHistorySince(playerTag: string, sinceISO: string): Promise<ActivityHistoryRow[]> {
  const pageSize = 1000;
  const rows: ActivityHistoryRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("activity_log")
      .select("*")
      .eq("player_tag", playerTag)
      .gte("recorded_at", sinceISO)
      .order("recorded_at", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows.push(...((data || []) as ActivityHistoryRow[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function fetchStoredBattlesForDailyStats(
  playerTag: string,
  fromISO: string,
  toISO: string
): Promise<StoredBattleForStats[]> {
  const pageSize = 1000;
  const rows: StoredBattleForStats[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("battle_history")
      .select("player_tag, battle_time, result, trophy_change, is_star_player")
      .eq("player_tag", playerTag)
      .gte("battle_time", fromISO)
      .lt("battle_time", toISO)
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows.push(...((data || []) as StoredBattleForStats[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

function adjustFutureBattleTimes<T extends { battle_time: string }>(battles: T[]) {
  if (battles.length === 0) return;

  const serverNow = Date.now();
  const maxBattleTime = battles.reduce(
    (max, battle) => Math.max(max, new Date(battle.battle_time).getTime()),
    0
  );

  if (maxBattleTime > serverNow + 60000) {
    const rawOffsetMs = maxBattleTime - serverNow;
    const offsetHours = Math.ceil(rawOffsetMs / 3600000);
    const offsetMs = offsetHours * 3600000;
    for (const battle of battles) {
      battle.battle_time = new Date(new Date(battle.battle_time).getTime() - offsetMs).toISOString();
    }
  }
}

async function rebuildDailyStatsForBattles(playerTag: string, battleTimes: string[]) {
  const affectedDates = [...new Set(battleTimes.map((battleTime) => battleTime.slice(0, 10)))].sort();
  if (affectedDates.length === 0) return;

  const firstDate = affectedDates[0];
  const lastDate = affectedDates[affectedDates.length - 1];
  const affectedKeys = new Set(affectedDates.map((date) => `${playerTag}_${date}`));
  const rangeEnd = new Date(`${lastDate}T00:00:00.000Z`);
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 1);

  const storedBattles = await fetchStoredBattlesForDailyStats(
    playerTag,
    `${firstDate}T00:00:00.000Z`,
    rangeEnd.toISOString()
  );

  const dailyStatsMap = new Map<string, {
    player_tag: string;
    date: string;
    battles: number;
    wins: number;
    losses: number;
    star_player: number;
    trophies_gained: number;
    trophies_lost: number;
  }>();

  for (const battle of storedBattles) {
    const date = String(battle.battle_time).slice(0, 10);
    const key = `${battle.player_tag}_${date}`;
    if (!affectedKeys.has(key)) continue;

    if (!dailyStatsMap.has(key)) {
      dailyStatsMap.set(key, {
        player_tag: battle.player_tag,
        date,
        battles: 0,
        wins: 0,
        losses: 0,
        star_player: 0,
        trophies_gained: 0,
        trophies_lost: 0,
      });
    }

    const stats = dailyStatsMap.get(key)!;
    stats.battles++;
    if (battle.result === "victory") stats.wins++;
    if (battle.result === "defeat") stats.losses++;
    if (battle.is_star_player) stats.star_player++;
    if ((battle.trophy_change || 0) > 0) stats.trophies_gained += battle.trophy_change || 0;
    if ((battle.trophy_change || 0) < 0) stats.trophies_lost += Math.abs(battle.trophy_change || 0);
  }

  const dailyStatsArray = Array.from(dailyStatsMap.values());
  if (dailyStatsArray.length > 0) {
    const { error } = await supabase
      .from("daily_stats")
      .upsert(dailyStatsArray, { onConflict: "player_tag,date" });
    if (error) throw error;
  }
}

async function getInactivityThresholdHours(): Promise<number> {
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "inactivity_threshold")
    .single();

  const parsed = Number.parseInt(data?.value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 48;
}

async function getConfiguredApiKey(): Promise<string | undefined> {
  const { data, error } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "api_key")
    .maybeSingle();

  if (error) {
    console.error("Error loading API key setting:", error);
  }

  const storedApiKey = typeof data?.value === "string" ? data.value.trim() : "";
  return storedApiKey || process.env.BRAWL_API_KEY;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ tag: string }> }
) {
  try {
    const { tag } = await params;
    const playerTag = decodeURIComponent(tag);

    const apiKey = await getConfiguredApiKey();

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

    const activitySince = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString();
    const activityHistory = await fetchActivityHistorySince(playerTag, activitySince);

    const { data: firstActivityRows } = await supabase
      .from("activity_log")
      .select("recorded_at")
      .eq("player_tag", playerTag)
      .order("recorded_at", { ascending: true })
      .limit(1);

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
          getLastBattleTime(playerTag, apiKey),
          getPlayerBattleStats(playerTag, apiKey),
          getPlayer(playerTag, apiKey),
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
    const firstActivity = firstActivityRows?.[0];
    if (firstActivity) {
      const firstDate = new Date(firstActivity.recorded_at);
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
    const crossOriginResponse = rejectCrossOriginRequest(request);
    if (crossOriginResponse) return crossOriginResponse;

    const { tag } = await params;
    const playerTag = decodeURIComponent(tag);
    const apiKey = await getConfiguredApiKey();

    if (!apiKey) {
      return NextResponse.json(
        { error: "API key required" },
        { status: 400 }
      );
    }
    // Fetch player data, ranked data, and battle log in parallel
    const [player, rankedData, battleLog] = await Promise.all([
      getPlayer(playerTag, apiKey),
      getPlayerRankedData(playerTag),
      getPlayerBattleLog(playerTag, apiKey).catch((err) => {
        console.warn(`Battle log unavailable for ${playerTag}: ${err.message}`);
        return { items: [] } as BrawlStarsBattleLog;
      }),
    ]);
    
    // Calculate win rate from battle log
    const winRateData = calculateWinRateFromBattleLog(battleLog);

    // Get previous data so refresh does not wipe good rank/icon values when a side API is unavailable.
    const { data: existingMember } = await supabase
      .from("members")
      .select("trophies, rank_current, rank_highest, icon_id")
      .eq("player_tag", playerTag)
      .single() as { data: { trophies: number; rank_current: string | null; rank_highest: string | null; icon_id: number | null } | null };

    const trophyChange = existingMember
      ? player.trophies - existingMember.trophies
      : 0;

    const processedBattles = processBattleLog(playerTag, battleLog);
    adjustFutureBattleTimes(processedBattles);
    const inactivityThreshold = await getInactivityThresholdHours();
    const thresholdTimeMs = Date.now() - inactivityThreshold * 60 * 60 * 1000;
    const hasRecentBattle = processedBattles.some(
      (battle) => new Date(battle.battle_time).getTime() >= thresholdTimeMs
    );

    let activityType = "inactive";
    if (Math.abs(trophyChange) >= 20) {
      activityType = "active";
    } else if (Math.abs(trophyChange) > 0 || hasRecentBattle) {
      activityType = "minimal";
    }

    const resolvedCurrentRank = rankedData.currentRank !== "Unranked"
      ? rankedData.currentRank
      : (existingMember?.rank_current || "Unranked");
    const resolvedHighestRank = rankedData.highestRank !== "Unranked"
      ? rankedData.highestRank
      : (existingMember?.rank_highest || "Unranked");

    // Update member
    const { data: updatedMember, error } = await supabase
      .from("members")
      .update({
        player_name: player.name,
        icon_id: player.icon?.id || existingMember?.icon_id || null,
        trophies: player.trophies,
        highest_trophies: player.highestTrophies,
        exp_level: player.expLevel,
        rank_current: resolvedCurrentRank,
        rank_highest: resolvedHighestRank,
        win_rate: winRateData.winRate,
        brawlers_count: player.brawlers.length,
        solo_victories: player.soloVictories,
        duo_victories: player.duoVictories,
        trio_victories: player["3vs3Victories"],
        is_active: activityType !== "inactive",
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

    if (processedBattles.length > 0) {
      const { error: battleError } = await supabase
        .from("battle_history")
        .upsert(processedBattles, {
          onConflict: "player_tag,battle_time",
          ignoreDuplicates: false,
        });

      if (battleError) throw battleError;
      await rebuildDailyStatsForBattles(
        playerTag,
        processedBattles.map((battle) => battle.battle_time)
      );
    }

    if (player.brawlers.length > 0) {
      const today = new Date();
      const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      const tomorrowStart = new Date(todayStart);
      tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);

      const { error: deleteSnapshotsError } = await supabase
        .from("brawler_snapshots")
        .delete()
        .eq("player_tag", playerTag)
        .gte("recorded_at", todayStart.toISOString())
        .lt("recorded_at", tomorrowStart.toISOString());

      if (deleteSnapshotsError) throw deleteSnapshotsError;

      const snapshotRows = player.brawlers.map((brawler) => ({
        player_tag: playerTag,
        brawler_id: brawler.id,
        brawler_name: brawler.name,
        power_level: brawler.power,
        trophies: brawler.trophies,
        rank: brawler.rank,
        gadgets_count: brawler.gadgets?.length || 0,
        star_powers_count: brawler.starPowers?.length || 0,
        gears_count: brawler.gears?.length || 0,
      }));

      const { error: insertSnapshotsError } = await supabase
        .from("brawler_snapshots")
        .insert(snapshotRows);

      if (insertSnapshotsError) throw insertSnapshotsError;
    }

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
