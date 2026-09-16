import modes from "./battle-modes.json";

// Brawlify's game-mode catalog, checked 2026-09-16 against Supercell's June/August
// release notes. Keep historical modes: an inactive event can still have battles.
// https://api.brawlapi.com/v1/gamemodes
// The API aliases below were also matched against the club's observed map names.
// The rotation catalog omits historical IDs 57/61; their names and icons come
// from /v1/maps/15001034 and /v1/maps/15001256. Keep 61 separate from Boss Fight 10.
export const battleModeAliases: Readonly<Record<string, string>> = {
  airHockey: "brawlHockey",
  deathmatch: "wipeout",
  tagTeam: "duels",
  airHockey5v5: "brawlHockey5v5",
  deathmatch5v5: "wipeout5v5",
  cooking: "foodFight",
};

const knownModes = new Map(modes.map((mode) => [mode.key.toLowerCase(), mode]));
// The official battle log's event.modeId uses small IDs (0 = Gem Grab,
// 38 = Trio Showdown); Brawlify adds its 48,000,000 namespace prefix.
const knownModeIds = new Map(modes.map((mode) => [mode.id - 48_000_000, mode]));
const aliases = new Map(Object.entries(battleModeAliases).map(([key, value]) => [key.toLowerCase(), value]));
const modeIcons: Record<string, string> = {
  gemGrab: "💎", heist: "🔓", bounty: "⭐", brawlBall: "⚽",
  soloShowdown: "🏜️", duoShowdown: "👥", trioShowdown: "👥",
  hotZone: "🔥", knockout: "💀", wipeout: "💥", duels: "⚔️",
  basketBrawl: "🏀", volleyBrawl: "🏐", brawlHockey: "🏒",
  paintBrawl: "🎨", payload: "📦", foodFight: "🍔", mechaGuard: "🤖",
  combatCooking: "🍳", "hide&Seek": "👀", megaBoss: "👹", duoMegaBoss: "👹",
};

export function normalizeBattleMode(raw: string | null | undefined, modeId?: number | null): string {
  const identifiedMode = modeId != null ? knownModeIds.get(modeId) : undefined;
  if (identifiedMode) return identifiedMode.key;
  const value = raw?.trim();
  if (!value) return "unknown";
  const alias = aliases.get(value.toLowerCase());
  return alias ?? knownModes.get(value.toLowerCase())?.key ?? value;
}

export function getBattleModeInfo(raw: string | null | undefined, modeId?: number | null) {
  const key = normalizeBattleMode(raw, modeId);
  const known = knownModes.get(key.toLowerCase());
  // Future modes stay visible and filterable instead of becoming Friendly/Custom.
  const fallback = key === "unknown" ? "Unknown mode" : key === "loaded SD" ? "Loaded Showdown · Unknown format" : key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/(\d)\s*[vV]\s*(\d)/g, "$1v$2")
    .replace(/^./, (character) => character.toUpperCase());
  return {
    key,
    label: known?.label ?? fallback,
    icon: modeIcons[key] ?? modeIcons[key.replace(/\d+v\d+$/, "")] ?? "⚔️",
    imageUrl: known ? `https://cdn.brawlify.com/game-modes/regular/${known.id}.png` : null,
  };
}

export const battleContextOptions = [
  { key: "ladder", label: "Trophy matches" },
  { key: "ranked", label: "Ranked" },
  { key: "challenge", label: "Challenges" },
  { key: "friendly", label: "Friendly" },
  { key: "mega_pig", label: "Mega Pig" },
  { key: "tournament", label: "Tournaments" },
  { key: "unknown", label: "Unclassified" },
] as const;

export type BattleContextKey = typeof battleContextOptions[number]["key"];

export function describeBattleContext(input: { battle_type?: string | null }) {
  const type = input.battle_type?.trim().toLowerCase();
  let key: BattleContextKey = "unknown";
  switch (type) {
    // Supercell's historical wire name `ranked` means the trophy ladder.
    case "ranked": key = "ladder"; break;
    case "soloranked":
    case "teamranked": key = "ranked"; break;
    case "challenge":
    case "championshipchallenge": key = "challenge"; break;
    case "friendly": key = "friendly"; break;
    // These require an explicit source marker. Public logs do not reliably
    // distinguish Mega Pig or tournaments; never infer either from a map,
    // a zero trophy change, casual/friendly, or the player's club membership.
    case "megapig": key = "mega_pig"; break;
    case "tournament": key = "tournament"; break;
  }
  return battleContextOptions.find((option) => option.key === key)!;
}
