import axios from "axios";
import { encodeTag } from "./utils";

const BRAWL_API_BASE = "https://api.brawlstars.com/v1";

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

// Helper to get ranked info from player (this is approximated from trophies/brawlers)
export function estimateRankedInfo(player: BrawlStarsPlayer): {
  currentRank: string;
  highestRank: string;
} {
  // This is a simplified estimation - actual ranked data would need club league API
  const totalTrophies = player.trophies;
  const avgBrawlerTrophies = totalTrophies / Math.max(player.brawlers.length, 1);
  
  let currentRank = "Bronze";
  let highestRank = "Bronze";
  
  if (avgBrawlerTrophies >= 900) {
    currentRank = "Masters";
    highestRank = "Masters";
  } else if (avgBrawlerTrophies >= 750) {
    currentRank = "Legendary";
    highestRank = "Legendary";
  } else if (avgBrawlerTrophies >= 600) {
    currentRank = "Mythic";
    highestRank = "Mythic";
  } else if (avgBrawlerTrophies >= 500) {
    currentRank = "Diamond";
    highestRank = "Diamond";
  } else if (avgBrawlerTrophies >= 400) {
    currentRank = "Gold";
    highestRank = "Gold";
  } else if (avgBrawlerTrophies >= 300) {
    currentRank = "Silver";
    highestRank = "Silver";
  }
  
  // Check highest trophies for highest rank
  const avgHighestTrophies = player.highestTrophies / Math.max(player.brawlers.length, 1);
  if (avgHighestTrophies >= 900) {
    highestRank = "Masters";
  } else if (avgHighestTrophies >= 750) {
    highestRank = "Legendary";
  } else if (avgHighestTrophies >= 600) {
    highestRank = "Mythic";
  } else if (avgHighestTrophies >= 500) {
    highestRank = "Diamond";
  } else if (avgHighestTrophies >= 400) {
    highestRank = "Gold";
  } else if (avgHighestTrophies >= 300) {
    highestRank = "Silver";
  }
  
  return { currentRank, highestRank };
}

export { brawlApi };
