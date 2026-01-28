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

// API Functions
export async function getClub(clubTag: string): Promise<BrawlStarsClub> {
  try {
    const response = await brawlApi.get(`/clubs/${encodeTag(clubTag)}`);
    return response.data;
  } catch (error) {
    handleApiError(error, `getClub(${clubTag})`);
  }
}

export async function getPlayer(playerTag: string): Promise<BrawlStarsPlayer> {
  try {
    const response = await brawlApi.get(`/players/${encodeTag(playerTag)}`);
    return response.data;
  } catch (error) {
    handleApiError(error, `getPlayer(${playerTag})`);
  }
}

export async function getPlayerBattleLog(playerTag: string): Promise<BrawlStarsBattleLog> {
  try {
    const response = await brawlApi.get(`/players/${encodeTag(playerTag)}/battlelog`);
    return response.data;
  } catch (error) {
    handleApiError(error, `getPlayerBattleLog(${playerTag})`);
  }
}

export async function getAllBrawlers(): Promise<{ items: { id: number; name: string }[] }> {
  const response = await brawlApi.get("/brawlers");
  return response.data;
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

// Fetch real ranked data from RNT API
export async function getPlayerRankedData(playerTag: string): Promise<{
  currentRank: string;
  highestRank: string;
  currentPoints: number;
  highestPoints: number;
}> {
  try {
    // Remove # from tag if present
    const cleanTag = playerTag.replace('#', '');
    const response = await axios.get(`${RNT_API_URL}/profile?tag=${cleanTag}`, {
      timeout: 5000,
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
    console.error(`Error fetching ranked data for ${playerTag}:`, error);
    return {
      currentRank: "Unranked",
      highestRank: "Unranked",
      currentPoints: 0,
      highestPoints: 0,
    };
  }
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
  } catch (error) {
    console.error(`Error fetching battle log for ${playerTag}:`, error);
    return { winRate: null, totalBattles: 0, wins: 0 };
  }
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

// Legacy function for backwards compatibility
export function estimateRankedInfo(player: BrawlStarsPlayer): {
  currentRank: string;
  highestRank: string;
} {
  // This is now just a fallback - use getPlayerRankedData for real data
  return { currentRank: "Unranked", highestRank: "Unranked" };
}

export { brawlApi };
