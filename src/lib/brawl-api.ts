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

// API Functions
export async function getClub(clubTag: string): Promise<BrawlStarsClub> {
  const response = await brawlApi.get(`/clubs/${encodeTag(clubTag)}`);
  return response.data;
}

export async function getPlayer(playerTag: string): Promise<BrawlStarsPlayer> {
  const response = await brawlApi.get(`/players/${encodeTag(playerTag)}`);
  return response.data;
}

export async function getPlayerBattleLog(playerTag: string): Promise<BrawlStarsBattleLog> {
  const response = await brawlApi.get(`/players/${encodeTag(playerTag)}/battlelog`);
  return response.data;
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

// Legacy function for backwards compatibility
export function estimateRankedInfo(player: BrawlStarsPlayer): {
  currentRank: string;
  highestRank: string;
} {
  // This is now just a fallback - use getPlayerRankedData for real data
  return { currentRank: "Unranked", highestRank: "Unranked" };
}

export { brawlApi };
