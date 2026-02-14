import axios from "axios";
import { encodeTag } from "./utils";

// Use RoyaleAPI proxy to bypass IP restrictions
// Docs: https://docs.royaleapi.com/proxy.html
// Whitelist IP: 45.79.218.79
const BRAWL_API_BASE = "https://bsproxy.royaleapi.dev/v1";

// Create axios instance with default config
const brawlApi = axios.create({
  baseURL: BRAWL_API_BASE,
  headers: {
    Accept: "application/json",
  },
});

// Add API key to requests
export function setApiKey(apiKey: string) {
  brawlApi.defaults.headers.common["Authorization"] = `Bearer ${apiKey}`;
}

export interface BrawlStarsClub {
  tag: string;
  name: string;
  description: string;
  type: string;
  badgeId: number;
  requiredTrophies: number;
  trophies: number;
  members: BrawlStarsMember[];
}

export interface BrawlStarsMember {
  tag: string;
  name: string;
  nameColor: string;
  role: string;
  trophies: number;
  icon: {
    id: number;
  };
}

export interface BrawlStarsPlayer {
  tag: string;
  name: string;
  nameColor: string;
  icon: {
    id: number;
  };
  trophies: number;
  highestTrophies: number;
  expLevel: number;
  expPoints: number;
  isQualifiedFromChampionshipChallenge: boolean;
  "3vs3Victories": number;
  soloVictories: number;
  duoVictories: number;
  bestRoboRumbleTime: number;
  bestTimeAsBigBrawler: number;
  club?: {
    tag: string;
    name: string;
  };
  brawlers: BrawlStarsBrawler[];
}

export interface BrawlStarsBrawler {
  id: number;
  name: string;
  power: number;
  rank: number;
  trophies: number;
  highestTrophies: number;
  gears: { id: number; name: string; level: number }[];
  starPowers: { id: number; name: string }[];
  gadgets: { id: number; name: string }[];
}

export interface BrawlStarsBattleLog {
  items: BrawlStarsBattle[];
}

export interface BrawlStarsBattle {
  battleTime: string;
  event: {
    id: number;
    mode: string;
    map: string;
  };
  battle: {
    mode: string;
    type: string;
    result?: string;
    rank?: number;
    duration?: number;
    trophyChange?: number;
    starPlayer?: {
      tag: string;
      name: string;
    };
    teams?: {
      tag: string;
      name: string;
      brawler: {
        id: number;
        name: string;
        power: number;
        trophies: number;
      };
    }[][];
    players?: {
      tag: string;
      name: string;
      brawler?: {
        id: number;
        name: string;
        power: number;
        trophies: number;
      };
      brawlers?: {
        id: number;
        name: string;
        power: number;
        trophies: number;
      }[];
    }[];
  };
}

// Helper to handle API errors with detailed logging
function handleApiError(error: unknown, endpoint: string): never {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const responseData = error.response?.data;
    const reason = responseData?.reason || responseData?.message || "Unknown";
    
    console.error(`API Error on ${endpoint}:`, {
      status,
      reason,
      responseData,
      url: error.config?.url,
      headers: error.config?.headers ? { 
        ...error.config.headers,
        Authorization: error.config.headers.Authorization ? "[REDACTED]" : "Not set"
      } : "No headers"
    });
    
    if (status === 403) {
      throw new Error(`API 403 Forbidden: ${reason}. This usually means the API key is invalid or not authorized for the RoyaleAPI proxy IP (45.79.218.79). Please generate a new key at https://developer.brawlstars.com with IP: 45.79.218.79`);
    }
    if (status === 404) {
      throw new Error(`API 404 Not Found: The requested resource was not found. Check if the tag is correct.`);
    }
    if (status === 429) {
      throw new Error(`API 429 Rate Limited: Too many requests. Please wait before trying again.`);
    }
  }
  throw error;
}

// Wrapper that auto-retries on 429 rate limit
async function apiCallWithRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 2): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429 && attempt < maxRetries) {
        const waitMs = 1000 * (attempt + 1); // 1s, then 2s
        console.warn(`Rate limited on ${label}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Unreachable`);
}

// API Functions
export async function getClub(clubTag: string): Promise<BrawlStarsClub> {
  try {
    return await apiCallWithRetry(
      () => brawlApi.get(`/clubs/${encodeTag(clubTag)}`).then(r => r.data),
      `getClub(${clubTag})`
    );
  } catch (error) {
    handleApiError(error, `getClub(${clubTag})`);
  }
}

export async function getPlayer(playerTag: string): Promise<BrawlStarsPlayer> {
  try {
    return await apiCallWithRetry(
      () => brawlApi.get(`/players/${encodeTag(playerTag)}`).then(r => r.data),
      `getPlayer(${playerTag})`
    );
  } catch (error) {
    handleApiError(error, `getPlayer(${playerTag})`);
  }
}

export async function getPlayerBattleLog(playerTag: string): Promise<BrawlStarsBattleLog> {
  try {
    return await apiCallWithRetry(
      () => brawlApi.get(`/players/${encodeTag(playerTag)}/battlelog`).then(r => r.data),
      `getPlayerBattleLog(${playerTag})`
    );
  } catch (error) {
    handleApiError(error, `getPlayerBattleLog(${playerTag})`);
  }
}

// RNT API for ranked data
const RNT_API_URL = "https://api.rnt.dev";

export interface RntPlayerResponse {
  ok: boolean;
  result: {
    stats: {
      id: number;
      name: string;
      value: number;
    }[];
  };
}

// Official Brawl Stars Ranked ELO thresholds
// Each entry: [minPoints, rankName]
const RANK_THRESHOLDS: [number, string][] = [
  [11250, "Pro"],
  [10250, "Masters III"],
  [9250, "Masters II"],
  [8250, "Masters I"],
  [7500, "Legendary III"],
  [6750, "Legendary II"],
  [6000, "Legendary I"],
  [5500, "Mythic III"],
  [5000, "Mythic II"],
  [4500, "Mythic I"],
  [4000, "Diamond III"],
  [3500, "Diamond II"],
  [3000, "Diamond I"],
  [2500, "Gold III"],
  [2000, "Gold II"],
  [1500, "Gold I"],
  [1250, "Silver III"],
  [1000, "Silver II"],
  [750, "Silver I"],
  [500, "Bronze III"],
  [250, "Bronze II"],
  [0, "Bronze I"],
];

export function formatLeagueRankFromPoints(points: number): string {
  if (points < 0) return "Unranked";
  
  for (const [minPoints, rankName] of RANK_THRESHOLDS) {
    if (points >= minPoints) {
      return rankName;
    }
  }
  
  return "Unranked";
}

// Fetch real ranked data from RNT API (with retry)
export async function getPlayerRankedData(playerTag: string): Promise<{
  currentRank: string;
  highestRank: string;
  currentPoints: number;
  highestPoints: number;
}> {
  const MAX_RETRIES = 1;
  const cleanTag = playerTag.replace('#', '');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(`${RNT_API_URL}/profile?tag=${cleanTag}`, {
        timeout: 4000,
      });
      
      if (!response.data?.ok || !response.data?.result?.stats) {
        return {
          currentRank: "Unranked",
          highestRank: "Unranked",
          currentPoints: 0,
          highestPoints: 0,
        };
      }
      
      const stats = response.data.result.stats;
      
      // Find ranked stats by ID:
      // 24: CurrentRankedPoints
      // 25: HighestRankedPoints
      const currentPoints = stats.find((s: { id: number }) => s.id === 24)?.value || 0;
      const highestPoints = stats.find((s: { id: number }) => s.id === 25)?.value || 0;
      
      return {
        currentRank: formatLeagueRankFromPoints(currentPoints),
        highestRank: formatLeagueRankFromPoints(highestPoints),
        currentPoints,
        highestPoints,
      };
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        // Wait briefly before retrying
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      console.error(`Error fetching ranked data for ${playerTag} after ${MAX_RETRIES + 1} attempts:`, error);
      return {
        currentRank: "Unranked",
        highestRank: "Unranked",
        currentPoints: 0,
        highestPoints: 0,
      };
    }
  }

  // TypeScript fallback (unreachable)
  return { currentRank: "Unranked", highestRank: "Unranked", currentPoints: 0, highestPoints: 0 };
}

// Calculate win rate from battle log
// Counts ALL battles including Map Maker, special events, and friendly games
export async function getPlayerWinRate(playerTag: string): Promise<{
  winRate: number | null;
  totalBattles: number;
  wins: number;
}> {
  try {
    const battleLog = await getPlayerBattleLog(playerTag);
    return calculateWinRateFromBattleLog(battleLog);
  } catch (error) {
    console.error(`Error fetching battle log for ${playerTag}:`, error);
    return { winRate: null, totalBattles: 0, wins: 0 };
  }
}

// Calculate win rate from an already-fetched battle log (to avoid duplicate API calls)
export function calculateWinRateFromBattleLog(battleLog: BrawlStarsBattleLog | null): {
  winRate: number | null;
  totalBattles: number;
  wins: number;
} {
  if (!battleLog?.items || battleLog.items.length === 0) {
    return { winRate: null, totalBattles: 0, wins: 0 };
  }
  
  let wins = 0;
  let validBattles = 0;
  
  for (const battle of battleLog.items) {
    const battleData = battle.battle;
    if (!battleData) continue;
    
    // Count any battle with a result (3v3, Ranked, Map Maker, Friendly, etc.)
    if (battleData.result) {
      validBattles++;
      if (battleData.result === "victory") {
        wins++;
      }
      continue;
    }
    
    // Count Showdown modes (have rank instead of result)
    if (battleData.rank != null) {
      validBattles++;
      // Top 4 in Solo (out of 10) or Top 2 in Duo (out of 5) = win
      if (battleData.rank <= 4) {
        wins++;
      }
    }
  }
  
  if (validBattles === 0) {
    return { winRate: null, totalBattles: 0, wins: 0 };
  }
  
  const winRate = Math.round((wins / validBattles) * 100);
  return { winRate, totalBattles: validBattles, wins };
}

// Get last battle time from battle log
export async function getLastBattleTime(playerTag: string): Promise<string | null> {
  try {
    console.log(`[getLastBattleTime] Fetching for ${playerTag}`);
    const battleLog = await getPlayerBattleLog(playerTag);
    console.log(`[getLastBattleTime] Battle log items:`, battleLog?.items?.length || 0);
    
    if (!battleLog?.items || battleLog.items.length === 0) {
      console.log(`[getLastBattleTime] No battles found`);
      return null;
    }
    
    // The first battle in the list is the most recent
    const lastBattle = battleLog.items[0];
    const bt = lastBattle?.battleTime;
    console.log(`[getLastBattleTime] Raw battleTime:`, bt, `(length: ${bt?.length})`);
    
    if (bt) {
      // Battle time format from API: "20260127T203456.000Z" (length 20)
      // We need to convert to ISO: "2026-01-27T20:34:56.000Z"
      // The T is at position 8
      const year = bt.slice(0, 4);
      const month = bt.slice(4, 6);
      const day = bt.slice(6, 8);
      const hour = bt.slice(9, 11);
      const min = bt.slice(11, 13);
      const sec = bt.slice(13, 15);
      
      const isoDate = `${year}-${month}-${day}T${hour}:${min}:${sec}.000Z`;
      console.log(`[getLastBattleTime] Parsed: year=${year}, month=${month}, day=${day}, hour=${hour}, min=${min}, sec=${sec}`);
      console.log(`[getLastBattleTime] Converted ISO date:`, isoDate);
      console.log(`[getLastBattleTime] As Date object:`, new Date(isoDate).toISOString());
      return isoDate;
    }
    
    return null;
  } catch (error) {
    console.error(`Error fetching last battle time for ${playerTag}:`, error);
    return null;
  }
}

// Parse battle time from API format to ISO format
function parseBattleTime(bt: string): string {
  const year = bt.slice(0, 4);
  const month = bt.slice(4, 6);
  const day = bt.slice(6, 8);
  const hour = bt.slice(9, 11);
  const min = bt.slice(11, 13);
  const sec = bt.slice(13, 15);
  return `${year}-${month}-${day}T${hour}:${min}:${sec}.000Z`;
}

// Get detailed battle statistics
export async function getPlayerBattleStats(playerTag: string): Promise<{
  battles: number;
  wins: number;
  losses: number;
  winRate: number;
  starPlayer: number;
  trophyChange: number;
  activeDays: Set<string>;
  battlesByDay: Map<string, number>;
}> {
  try {
    const battleLog = await getPlayerBattleLog(playerTag);
    
    const stats = {
      battles: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      starPlayer: 0,
      trophyChange: 0,
      activeDays: new Set<string>(),
      battlesByDay: new Map<string, number>(),
    };

    if (!battleLog?.items || battleLog.items.length === 0) {
      return stats;
    }

    for (const battle of battleLog.items) {
      const battleData = battle.battle;
      if (!battleData) continue;

      stats.battles++;
      
      // Track active days
      const battleDate = parseBattleTime(battle.battleTime);
      const dateKey = battleDate.slice(0, 10); // YYYY-MM-DD
      stats.activeDays.add(dateKey);
      stats.battlesByDay.set(dateKey, (stats.battlesByDay.get(dateKey) || 0) + 1);

      // Track trophy changes
      if (battleData.trophyChange) {
        stats.trophyChange += battleData.trophyChange;
      }

      // Track star player
      if (battleData.starPlayer?.tag === playerTag || 
          battleData.starPlayer?.tag === playerTag.replace('#', '%23')) {
        stats.starPlayer++;
      }

      // Count wins/losses
      if (battleData.result) {
        if (battleData.result === "victory") {
          stats.wins++;
        } else if (battleData.result === "defeat") {
          stats.losses++;
        }
      } else if (battleData.rank != null) {
        // Showdown: Top 4 = win
        if (battleData.rank <= 4) {
          stats.wins++;
        } else {
          stats.losses++;
        }
      }
    }

    stats.winRate = stats.battles > 0 ? Math.round((stats.wins / stats.battles) * 100) : 0;
    
    return stats;
  } catch (error) {
    console.error(`Error fetching battle stats for ${playerTag}:`, error);
    return {
      battles: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      starPlayer: 0,
      trophyChange: 0,
      activeDays: new Set(),
      battlesByDay: new Map(),
    };
  }
}

// Get brawler power level distribution
export function getBrawlerPowerDistribution(brawlers: BrawlStarsBrawler[]): {
  distribution: number[];
  avgPower: number;
  maxedCount: number;
} {
  const distribution = Array(11).fill(0); // Power levels 1-11
  let totalPower = 0;
  let maxedCount = 0;

  for (const brawler of brawlers) {
    const powerIndex = Math.min(Math.max(brawler.power - 1, 0), 10);
    distribution[powerIndex]++;
    totalPower += brawler.power;
    if (brawler.power === 11) {
      maxedCount++;
    }
  }

  const avgPower = brawlers.length > 0 ? totalPower / brawlers.length : 0;

  return { distribution, avgPower, maxedCount };
}

// Parse battle time from API format to Date
export function parseBattleTimeToDate(bt: string): Date {
  const year = bt.slice(0, 4);
  const month = bt.slice(4, 6);
  const day = bt.slice(6, 8);
  const hour = bt.slice(9, 11);
  const min = bt.slice(11, 13);
  const sec = bt.slice(13, 15);
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}.000Z`);
}

// Process battle log for storage
export interface ProcessedBattle {
  player_tag: string;
  battle_time: string;
  mode: string;
  map: string;
  result: string;
  trophy_change: number;
  is_star_player: boolean;
  brawler_name: string | null;
  brawler_power: number | null;
  brawler_trophies: number | null;
  teams_json: string | null;
}

export function processBattleLog(playerTag: string, battleLog: BrawlStarsBattleLog): ProcessedBattle[] {
  const battles: ProcessedBattle[] = [];
  
  if (!battleLog?.items) return battles;

  for (const battle of battleLog.items) {
    const battleData = battle.battle;
    if (!battleData) continue;

    const battleTime = parseBattleTimeToDate(battle.battleTime);
    
    // Determine result
    let result = "unknown";
    if (battleData.result) {
      result = battleData.result;
    } else if (battleData.rank != null) {
      result = battleData.rank <= 4 ? "victory" : "defeat";
    }

    // Check if star player
    const isStarPlayer = battleData.starPlayer?.tag === playerTag || 
                         battleData.starPlayer?.tag === playerTag.replace('#', '%23');

    // Find player's brawler in teams
    let brawlerName: string | null = null;
    let brawlerPower: number | null = null;
    let brawlerTrophies: number | null = null;

    if (battleData.teams) {
      for (const team of battleData.teams) {
        for (const player of team) {
          if (player.tag === playerTag || player.tag === playerTag.replace('#', '%23')) {
            brawlerName = player.brawler?.name || null;
            brawlerPower = player.brawler?.power || null;
            brawlerTrophies = player.brawler?.trophies || null;
            break;
          }
        }
      }
    } else if (battleData.players) {
      // Showdown / Duels: players is a flat array
      // Duels uses brawlers[] (plural), Showdown uses brawler (singular)
      for (const player of battleData.players) {
        if (player.tag === playerTag || player.tag === playerTag.replace('#', '%23')) {
          const b = player.brawler || player.brawlers?.[0];
          brawlerName = b?.name || null;
          brawlerPower = b?.power || null;
          brawlerTrophies = b?.trophies || null;
          break;
        }
      }
    }

    // Serialize full teams/players data for match context
    let teamsJson: string | null = null;
    if (battleData.teams) {
      try {
        teamsJson = JSON.stringify(battleData.teams.map(team =>
          team.map(p => ({
            tag: p.tag,
            name: p.name,
            brawler: p.brawler?.name || null,
            power: p.brawler?.power || null,
            trophies: p.brawler?.trophies || null,
          }))
        ));
      } catch { /* ignore serialization errors */ }
    } else if (battleData.players) {
      // Showdown: serialize each player as a single-member team
      // Duels: uses brawlers[] (plural), fall back to first brawler
      try {
        teamsJson = JSON.stringify(battleData.players.map(p => [{
          tag: p.tag,
          name: p.name,
          brawler: p.brawler?.name || p.brawlers?.[0]?.name || null,
          power: p.brawler?.power || p.brawlers?.[0]?.power || null,
          trophies: p.brawler?.trophies || p.brawlers?.[0]?.trophies || null,
        }]));
      } catch { /* ignore serialization errors */ }
    }

    battles.push({
      player_tag: playerTag,
      battle_time: battleTime.toISOString(),
      mode: battle.event?.mode || battleData.mode || "unknown",
      map: battle.event?.map || "unknown",
      result,
      trophy_change: battleData.trophyChange || 0,
      is_star_player: isStarPlayer,
      brawler_name: brawlerName,
      brawler_power: brawlerPower,
      brawler_trophies: brawlerTrophies,
      teams_json: teamsJson,
    });
  }

  return battles;
}

// Calculate enhanced tracking stats from battle history
export interface EnhancedTrackingStats {
  // Last 28 days stats
  totalBattles: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  starPlayerCount: number;
  trophiesGained: number;
  trophiesLost: number;
  netTrophies: number;
  // Activity
  activeDays: number;
  totalDays: number;
  currentStreak: number;
  bestStreak: number;
  peakDayBattles: number;
  // Brawler changes
  powerUps: number;
  unlocks: number;
  // Tracking info
  trackedDays: number;
}

export function calculateEnhancedStats(
  dailyStats: { date: string; battles: number; wins: number; losses: number; star_player: number; trophies_gained: number; trophies_lost: number }[],
  tracking: { power_ups: number; unlocks: number; tracking_started: string } | null
): EnhancedTrackingStats {
  const now = new Date();
  const twentyEightDaysAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);
  
  // Filter to last 28 days
  const recentStats = dailyStats.filter(s => new Date(s.date) >= twentyEightDaysAgo);
  
  // Calculate totals
  let totalBattles = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let starPlayerCount = 0;
  let trophiesGained = 0;
  let trophiesLost = 0;
  let peakDayBattles = 0;
  const activeDates = new Set<string>();

  for (const stat of recentStats) {
    totalBattles += stat.battles;
    totalWins += stat.wins;
    totalLosses += stat.losses;
    starPlayerCount += stat.star_player;
    trophiesGained += stat.trophies_gained;
    trophiesLost += stat.trophies_lost;
    
    if (stat.battles > 0) {
      activeDates.add(stat.date);
    }
    if (stat.battles > peakDayBattles) {
      peakDayBattles = stat.battles;
    }
  }

  // Calculate streak
  let currentStreak = 0;
  let bestStreak = 0;
  let tempStreak = 0;
  
  // Sort dates descending
  const sortedDates = Array.from(activeDates).sort((a, b) => b.localeCompare(a));
  
  // Calculate current streak (consecutive days from today)
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  
  if (activeDates.has(today)) {
    currentStreak = 1;
    let checkDate = new Date(now);
    checkDate.setDate(checkDate.getDate() - 1);
    
    while (activeDates.has(checkDate.toISOString().slice(0, 10))) {
      currentStreak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }
  } else if (activeDates.has(yesterday)) {
    // If not played today but played yesterday, count from yesterday
    currentStreak = 1;
    let checkDate = new Date(now);
    checkDate.setDate(checkDate.getDate() - 2);
    
    while (activeDates.has(checkDate.toISOString().slice(0, 10))) {
      currentStreak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }
  }

  // Calculate best streak
  for (let i = 0; i < sortedDates.length; i++) {
    const currentDate = new Date(sortedDates[i]);
    const prevDate = i > 0 ? new Date(sortedDates[i - 1]) : null;
    
    if (prevDate) {
      const diffDays = Math.round((prevDate.getTime() - currentDate.getTime()) / (24 * 60 * 60 * 1000));
      if (diffDays === 1) {
        tempStreak++;
      } else {
        bestStreak = Math.max(bestStreak, tempStreak);
        tempStreak = 1;
      }
    } else {
      tempStreak = 1;
    }
  }
  bestStreak = Math.max(bestStreak, tempStreak, currentStreak);

  const winRate = totalBattles > 0 ? Math.round((totalWins / totalBattles) * 100) : 0;
  
  // Calculate tracked days
  const trackedDays = tracking?.tracking_started 
    ? Math.floor((now.getTime() - new Date(tracking.tracking_started).getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  return {
    totalBattles,
    totalWins,
    totalLosses,
    winRate,
    starPlayerCount,
    trophiesGained,
    trophiesLost,
    netTrophies: trophiesGained - Math.abs(trophiesLost),
    activeDays: activeDates.size,
    totalDays: 28,
    currentStreak,
    bestStreak,
    peakDayBattles,
    powerUps: tracking?.power_ups || 0,
    unlocks: tracking?.unlocks || 0,
    trackedDays: Math.max(trackedDays, 1),
  };
}

export { brawlApi };
