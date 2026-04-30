const DAY_MS = 24 * 60 * 60 * 1000;

export type DailyBattleStatsRow = {
  player_tag: string;
  date: string;
  battles: number | null;
  wins: number | null;
  losses: number | null;
  star_player: number | null;
  trophies_gained: number | null;
  trophies_lost: number | null;
};

export type BattleTrackingStats = {
  battles: number;
  wins: number;
  losses: number;
  starPlayer: number;
  trophiesGained: number;
  trophiesLost: number;
  activeDays: number;
  currentStreak: number;
  bestStreak: number;
  peakDayBattles: number;
};

function toNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toUtcDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function offsetUtcDateKey(baseDate: Date, offsetDays: number) {
  const date = new Date(Date.UTC(
    baseDate.getUTCFullYear(),
    baseDate.getUTCMonth(),
    baseDate.getUTCDate() + offsetDays
  ));
  return toUtcDateKey(date);
}

function dateKeyToDayNumber(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return null;
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function calculateStreaks(activeDates: Set<string>, now: Date) {
  let currentStreak = 0;
  let offset: number | null = null;

  if (activeDates.has(offsetUtcDateKey(now, 0))) {
    offset = 0;
  } else if (activeDates.has(offsetUtcDateKey(now, -1))) {
    offset = -1;
  }

  while (offset !== null && activeDates.has(offsetUtcDateKey(now, offset))) {
    currentStreak++;
    offset--;
  }

  const dayNumbers = [...activeDates]
    .map(dateKeyToDayNumber)
    .filter((dayNumber): dayNumber is number => dayNumber !== null)
    .sort((a, b) => a - b);

  let bestStreak = 0;
  let run = 0;
  let previousDay: number | null = null;

  for (const dayNumber of dayNumbers) {
    run = previousDay !== null && dayNumber === previousDay + 1 ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    previousDay = dayNumber;
  }

  return {
    currentStreak,
    bestStreak: Math.max(bestStreak, currentStreak),
  };
}

export function aggregateDailyBattleStats(
  rows: DailyBattleStatsRow[],
  playerTags: string[],
  now = new Date()
) {
  const statsByPlayer = new Map<string, BattleTrackingStats & { activeDateSet: Set<string> }>();

  for (const playerTag of playerTags) {
    statsByPlayer.set(playerTag, {
      battles: 0,
      wins: 0,
      losses: 0,
      starPlayer: 0,
      trophiesGained: 0,
      trophiesLost: 0,
      activeDays: 0,
      currentStreak: 0,
      bestStreak: 0,
      peakDayBattles: 0,
      activeDateSet: new Set<string>(),
    });
  }

  for (const row of rows) {
    const stats = statsByPlayer.get(row.player_tag);
    if (!stats) continue;

    const battles = toNumber(row.battles);
    stats.battles += battles;
    stats.wins += toNumber(row.wins);
    stats.losses += toNumber(row.losses);
    stats.starPlayer += toNumber(row.star_player);
    stats.trophiesGained += toNumber(row.trophies_gained);
    stats.trophiesLost += toNumber(row.trophies_lost);
    stats.peakDayBattles = Math.max(stats.peakDayBattles, battles);

    if (battles > 0) {
      stats.activeDateSet.add(row.date);
    }
  }

  const result = new Map<string, BattleTrackingStats>();
  for (const [playerTag, stats] of statsByPlayer) {
    const { currentStreak, bestStreak } = calculateStreaks(stats.activeDateSet, now);
    result.set(playerTag, {
      battles: stats.battles,
      wins: stats.wins,
      losses: stats.losses,
      starPlayer: stats.starPlayer,
      trophiesGained: stats.trophiesGained,
      trophiesLost: stats.trophiesLost,
      activeDays: stats.activeDateSet.size,
      currentStreak,
      bestStreak,
      peakDayBattles: stats.peakDayBattles,
    });
  }

  return result;
}
