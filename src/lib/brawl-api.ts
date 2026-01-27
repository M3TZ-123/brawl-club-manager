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

// Ranked tier mapping based on RNT API
// Rank 1-3: Bronze I, II, III
// Rank 4-6: Silver I, II, III
// Rank 7-9: Gold I, II, III
// Rank 10-12: Diamond I, II, III
// Rank 13-15: Mythic I, II, III
// Rank 16-18: Legendary I, II, III
// Rank 19-21: Masters I, II, III
// Rank 22+: Pro
const LEAGUE_NAMES = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Mythic', 'Legendary', 'Masters', 'Pro'] as const;
const LEAGUE_SUBS = ['I', 'II', 'III'] as const;

export function formatLeagueRank(rankTier: number): string {
  if (rankTier <= 0) return "Unranked";
  if (rankTier >= 22) return "Pro";
  if (rankTier >= 19) {
    // Masters I, II, III (ranks 19, 20, 21)
    const subIndex = rankTier - 19;
    return subIndex === 0 ? "Masters" : `Masters ${LEAGUE_SUBS[subIndex]}`;
  }
  
  const leagueIndex = Math.floor((rankTier - 1) / 3);
  const subIndex = (rankTier - 1) % 3;
  
  return `${LEAGUE_NAMES[leagueIndex]} ${LEAGUE_SUBS[subIndex]}`;
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
    // 23: CurrentRanked (tier)
    // 24: CurrentRankedPoints
    // 22: HighestRanked (tier)
    // 25: HighestRankedPoints
    const currentRankTier = stats.find((s: { id: number }) => s.id === 23)?.value || 0;
    const currentPoints = stats.find((s: { id: number }) => s.id === 24)?.value || 0;
    const highestRankTier = stats.find((s: { id: number }) => s.id === 22)?.value || 0;
    const highestPoints = stats.find((s: { id: number }) => s.id === 25)?.value || 0;
    
    return {
      currentRank: formatLeagueRank(currentRankTier),
      highestRank: formatLeagueRank(highestRankTier),
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

// Legacy function for backwards compatibility
export function estimateRankedInfo(player: BrawlStarsPlayer): {
  currentRank: string;
  highestRank: string;
} {
  // This is now just a fallback - use getPlayerRankedData for real data
  return { currentRank: "Unranked", highestRank: "Unranked" };
}

export { brawlApi };
