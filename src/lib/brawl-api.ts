import axios from "axios";
import { encodeTag } from "./utils";
import { normalizeBattleMode } from "./battle-catalog";
import { callWithUpstreamRetry, getUpstreamCooldownMs, UpstreamRateLimitError, type UpstreamProvider } from "./upstream-rate-limit";
import { optionalProgressInteger, type ReportedEquipment, type ReportedBuffies } from "./player-progress";

// Use RoyaleAPI proxy to bypass IP restrictions
// Docs: https://docs.royaleapi.com/proxy.html
// Whitelist IP: 45.79.218.79
const BRAWL_API_BASE = "https://bsproxy.royaleapi.dev/v1";

// Create axios instance with default config
const brawlApi = axios.create({
  baseURL: BRAWL_API_BASE,
  timeout: 10000,
  proxy: false,
  headers: {
    Accept: "application/json",
  },
});

let defaultApiKey = "";

export function setApiKey(apiKey: string) {
  defaultApiKey = apiKey;
}

function getAuthConfig(apiKey?: string) {
  const key = apiKey || defaultApiKey;
  return key
    ? { headers: { Authorization: `Bearer ${key}` } }
    : {};
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
  rankedSeasonId?: number;
  rankedRank?: number;
  rankedRankName?: string;
  rankedElo?: number;
  highestSeasonRankedRank?: number;
  highestSeasonRankedRankName?: string;
  highestSeasonRankedElo?: number;
  highestAllTimeRankedRank?: number;
  highestAllTimeRankedRankName?: string;
  highestAllTimeRankedElo?: number;
  totalPrestigeLevel?: number;
  fame?: number;
  fameTierName?: string;
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
  prestigeLevel?: number;
  currentWinStreak?: number;
  maxWinStreak?: number;
  skin?: ReportedEquipment;
  hyperCharges?: ReportedEquipment[];
  buffies?: ReportedBuffies;
}

export interface BrawlStarsBattleLog {
  items: BrawlStarsBattle[];
}

export interface BrawlStarsBattle {
  battleTime: string;
  event: {
    id: number;
    modeId?: number;
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

function normalizeTagForCompare(tag: string | null | undefined): string {
  if (!tag) return "";
  const decoded = /^%23/i.test(tag) ? `#${tag.slice(3)}` : tag;
  return (decoded.startsWith("#") ? decoded : `#${decoded}`).toUpperCase();
}

function tagsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeTagForCompare(a) === normalizeTagForCompare(b);
}

function getBattleMode(battle: BrawlStarsBattle): string {
  // Some live Trio Showdown logs still use duoShowdown in battle.mode.
  // The event's mode identifies the actual event; retain both raw values below.
  return normalizeBattleMode(battle.event?.mode || battle.battle?.mode, battle.event?.modeId);
}

function isRankBattleVictory(battle: BrawlStarsBattle): boolean | null {
  const mode = getBattleMode(battle);
  const rank = battle.battle?.rank;
  // A placement is not a universal win indicator. Only these formats have a
  // known winning threshold; future/event formats retain an unknown result.
  const placements: Record<string, [number, number]> = {
    soloShowdown: [4, 10], duoShowdown: [2, 5], trioShowdown: [2, 4], duels: [1, 2],
  };
  const format = placements[mode];
  if (!format || !Number.isInteger(rank) || rank! < 1 || rank! > format[1]) return null;
  return rank! <= format[0];
}

export class BrawlApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly reason?: string,
    public readonly retryAfterMs?: number,
    public readonly provider: UpstreamProvider = "brawl",
  ) {
    super(message);
    this.name = "BrawlApiError";
  }
}

// Keep status/cooldown actionable without exposing upstream bodies or Axios
// request objects (which contain the API key) to logs or public errors.
function handleApiError(error: unknown): never {
  if (error instanceof UpstreamRateLimitError) {
    throw new BrawlApiError("API 429 Rate Limited: Please wait before trying again.", 429, "rateLimited", error.retryAfterMs, error.provider);
  }
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 403) {
      throw new BrawlApiError("API 403 Forbidden: The API key may be invalid or not authorized for the RoyaleAPI proxy IP (45.79.218.79). Generate a key at https://developer.brawlstars.com with IP: 45.79.218.79", status, "accessDenied");
    }
    if (status === 404) {
      throw new BrawlApiError("API 404 Not Found: The requested resource was not found. Check if the tag is correct.", status, "notFound");
    }
    if (status === 429) {
      throw new BrawlApiError("API 429 Rate Limited: Please wait before trying again.", status, "rateLimited", getUpstreamCooldownMs("brawl"));
    }
    throw new BrawlApiError("Brawl Stars API request failed. Please try again later.", status, status ? "upstreamUnavailable" : "networkError");
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    throw error;
  }
  throw new BrawlApiError("Brawl Stars API request failed. Please try again later.", undefined, "upstreamUnavailable");
}

// API Functions
export async function getClub(clubTag: string, apiKey?: string, signal?: AbortSignal, deadlineAt?: number): Promise<BrawlStarsClub> {
  try {
    return await callWithUpstreamRetry(
      (timeout) => brawlApi.get(`/clubs/${encodeTag(clubTag)}`, { ...getAuthConfig(apiKey), signal, timeout }).then(r => r.data),
      { provider: "brawl", signal, deadlineAt },
    );
  } catch (error) {
    handleApiError(error);
  }
}

export async function getPlayer(playerTag: string, apiKey?: string, signal?: AbortSignal, deadlineAt?: number): Promise<BrawlStarsPlayer> {
  try {
    return await callWithUpstreamRetry(
      (timeout) => brawlApi.get(`/players/${encodeTag(playerTag)}`, { ...getAuthConfig(apiKey), signal, timeout }).then(r => r.data),
      { provider: "brawl", signal, deadlineAt },
    );
  } catch (error) {
    handleApiError(error);
  }
}

export async function getPlayerBattleLog(playerTag: string, apiKey?: string, signal?: AbortSignal, deadlineAt?: number): Promise<BrawlStarsBattleLog> {
  try {
    return await callWithUpstreamRetry(
      (timeout) => brawlApi.get(`/players/${encodeTag(playerTag)}/battlelog`, { ...getAuthConfig(apiKey), signal, timeout }).then(r => r.data),
      { provider: "brawl", signal, deadlineAt },
    );
  } catch (error) {
    handleApiError(error);
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
export async function getPlayerRankedData(playerTag: string, options: { signal?: AbortSignal; deadlineAt?: number } = {}): Promise<{
  currentRank: string;
  highestRank: string;
  currentPoints: number;
  highestPoints: number;
  available?: boolean;
  retryAfterMs?: number;
}> {
  const cleanTag = playerTag.replace('#', '');
  const unavailable = { currentRank: "Unranked", highestRank: "Unranked", currentPoints: 0, highestPoints: 0, available: false };
  try {
    const response = await callWithUpstreamRetry(
      (timeout) => axios.get<RntPlayerResponse>(`${RNT_API_URL}/profile?tag=${encodeURIComponent(cleanTag)}`, {
        timeout,
        proxy: false,
        signal: options.signal,
      }),
      { provider: "rnt", ...options, maxDurationMs: 8000, requestTimeoutMs: 4000, maxAttempts: 2, retryTransient: true },
    );
    const stats = response.data?.result?.stats;
    if (!response.data?.ok || !Array.isArray(stats)) return unavailable;

    // Missing/invalid fields are unavailable, not evidence that a rank reset.
    // Explicit zero points is a successful Bronze I response.
    const currentPoints = stats.find((stat) => stat?.id === 24)?.value;
    const highestPoints = stats.find((stat) => stat?.id === 25)?.value;
    if (typeof currentPoints !== "number" || !Number.isFinite(currentPoints) || currentPoints < 0 ||
      typeof highestPoints !== "number" || !Number.isFinite(highestPoints) || highestPoints < 0) return unavailable;
    return {
      currentRank: formatLeagueRankFromPoints(currentPoints),
      highestRank: formatLeagueRankFromPoints(highestPoints),
      currentPoints,
      highestPoints,
      available: true,
    };
  } catch {
    const retryAfterMs = getUpstreamCooldownMs("rnt");
    return retryAfterMs > 0 ? { ...unavailable, retryAfterMs } : unavailable;
  }
}

// Calculate win rate from battle log
// Counts ALL battles including Map Maker, special events, and friendly games
export async function getPlayerWinRate(playerTag: string, apiKey?: string): Promise<{
  winRate: number | null;
  totalBattles: number;
  wins: number;
}> {
  try {
    const battleLog = await getPlayerBattleLog(playerTag, apiKey);
    return calculateWinRateFromBattleLog(battleLog);
  } catch {
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
    
    const placementVictory = isRankBattleVictory(battle);
    if (placementVictory != null) {
      validBattles++;
      if (placementVictory) {
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
export async function getLastBattleTime(playerTag: string, apiKey?: string): Promise<string | null> {
  try {
    const battleLog = await getPlayerBattleLog(playerTag, apiKey);
    
    if (!battleLog?.items || battleLog.items.length === 0) {
      return null;
    }
    
    // The first battle in the list is the most recent
    const lastBattle = battleLog.items[0];
    const bt = lastBattle?.battleTime;
    
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
      return isoDate;
    }
    
    return null;
  } catch {
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
export async function getPlayerBattleStats(playerTag: string, apiKey?: string): Promise<{
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
    const battleLog = await getPlayerBattleLog(playerTag, apiKey);
    
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
      if (tagsMatch(battleData.starPlayer?.tag, playerTag)) {
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
        const placementVictory = isRankBattleVictory(battle);
        if (placementVictory === true) {
          stats.wins++;
        } else if (placementVictory === false) {
          stats.losses++;
        }
      }
    }

    stats.winRate = stats.battles > 0 ? Math.round((stats.wins / stats.battles) * 100) : 0;
    
    return stats;
  } catch {
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
  duration_seconds: number | null;
  player_tag: string;
  battle_time: string;
  mode: string;
  map: string;
  result: string;
  trophy_change: number | null;
  trophy_change_reported: boolean;
  battle_type: string | null;
  event_id: number | null;
  event_mode_id: number | null;
  battle_mode: string | null;
  event_mode: string | null;
  placement_rank: number | null;
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
      const placementVictory = isRankBattleVictory(battle);
      if (placementVictory != null) result = placementVictory ? "victory" : "defeat";
    }

    // Check if star player
    const isStarPlayer = tagsMatch(battleData.starPlayer?.tag, playerTag);

    // Find player's brawler in teams
    let brawlerName: string | null = null;
    let brawlerPower: number | null = null;
    let brawlerTrophies: number | null = null;

    if (battleData.teams) {
      teamsLoop:
      for (const team of battleData.teams) {
        for (const player of team) {
          if (tagsMatch(player.tag, playerTag)) {
            brawlerName = player.brawler?.name || null;
            brawlerPower = player.brawler?.power || null;
            brawlerTrophies = player.brawler?.trophies ?? null;
            break teamsLoop;
          }
        }
      }
    } else if (battleData.players) {
      // Showdown / Duels: players is a flat array
      // Duels uses brawlers[] (plural), Showdown uses brawler (singular)
      for (const player of battleData.players) {
        if (tagsMatch(player.tag, playerTag)) {
          const b = player.brawler || player.brawlers?.[0];
          brawlerName = b?.name || null;
          brawlerPower = b?.power || null;
          brawlerTrophies = b?.trophies ?? null;
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
            tag: p.tag.startsWith("%23") ? "#" + p.tag.slice(3) : p.tag,
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
          tag: p.tag.startsWith("%23") ? "#" + p.tag.slice(3) : p.tag,
          name: p.name,
          brawler: p.brawler?.name || p.brawlers?.[0]?.name || null,
          power: p.brawler?.power || p.brawlers?.[0]?.power || null,
          trophies: p.brawler?.trophies || p.brawlers?.[0]?.trophies || null,
        }]));
      } catch { /* ignore serialization errors */ }
    }

    battles.push({
      duration_seconds: optionalProgressInteger(battleData.duration) ?? null,
      player_tag: playerTag,
      battle_time: battleTime.toISOString(),
      mode: getBattleMode(battle),
      map: battle.event?.map || "unknown",
      result,
      trophy_change: Number.isFinite(battleData.trophyChange) ? battleData.trophyChange! : null,
      trophy_change_reported: Number.isFinite(battleData.trophyChange),
      battle_type: battleData.type || null,
      event_mode_id: Number.isSafeInteger(battle.event?.modeId) ? battle.event.modeId! : null,
      event_id: Number.isSafeInteger(battle.event?.id) ? battle.event.id : null,
      battle_mode: battleData.mode || null,
      event_mode: battle.event?.mode || null,
      placement_rank: Number.isInteger(battleData.rank) && battleData.rank! > 0 ? battleData.rank! : null,
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
  const cutoffDate = twentyEightDaysAgo.toISOString().slice(0, 10);
  
  // Filter to last 28 days
  const recentStats = dailyStats.filter(s => s.date >= cutoffDate);
  
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
    const checkDate = new Date(now);
    checkDate.setDate(checkDate.getDate() - 1);
    
    while (activeDates.has(checkDate.toISOString().slice(0, 10))) {
      currentStreak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }
  } else if (activeDates.has(yesterday)) {
    // If not played today but played yesterday, count from yesterday
    currentStreak = 1;
    const checkDate = new Date(now);
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
