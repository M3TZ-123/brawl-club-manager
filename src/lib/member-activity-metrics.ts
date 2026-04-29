import { supabaseAdmin } from "@/lib/supabase-admin";

type ActivitySnapshot = {
  player_tag: string;
  trophies: number;
  recorded_at: string;
};

type BattleSnapshot = {
  player_tag: string;
  last_battle_date: string | null;
};

type DailyStatsSnapshot = {
  player_tag: string;
  date: string;
  trophies_gained: number | null;
  trophies_lost: number | null;
};

export type MemberActivityMetrics = {
  trophies_24h: number | null;
  trophies_7d: number | null;
  activity_status: "active" | "minimal" | "inactive";
  last_battle_at: string | null;
};

async function fetchActivitySnapshotsWindow(
  playerTags: string[],
  fromISO: string,
  toISO: string
): Promise<ActivitySnapshot[]> {
  if (playerTags.length === 0) return [];

  const pageSize = 1000;
  const rows: ActivitySnapshot[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("activity_log")
      .select("player_tag, trophies, recorded_at")
      .in("player_tag", playerTags)
      .gte("recorded_at", fromISO)
      .lte("recorded_at", toISO)
      .order("recorded_at", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows.push(...((data || []) as ActivitySnapshot[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function fetchTrackingSnapshots(playerTags: string[]): Promise<BattleSnapshot[]> {
  if (playerTags.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("player_tracking")
    .select("player_tag, last_battle_date")
    .in("player_tag", playerTags);

  if (error) throw error;
  return (data || []) as BattleSnapshot[];
}

async function fetchDailyStatsSnapshots(playerTags: string[], sinceDate: string): Promise<DailyStatsSnapshot[]> {
  if (playerTags.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("daily_stats")
    .select("player_tag, date, trophies_gained, trophies_lost")
    .in("player_tag", playerTags)
    .gte("date", sinceDate);

  if (error) throw error;
  return (data || []) as DailyStatsSnapshot[];
}

function findNearestBaseline(
  playerLogs: ActivitySnapshot[],
  targetTime: Date,
  maxDistanceMs: number
) {
  let nearest: ActivitySnapshot | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const log of playerLogs) {
    const distance = Math.abs(new Date(log.recorded_at).getTime() - targetTime.getTime());
    if (distance <= maxDistanceMs && distance < nearestDistance) {
      nearest = log;
      nearestDistance = distance;
    }
  }

  return nearest;
}

export async function appendMemberActivityMetrics<T extends { player_tag: string; trophies: number }>(
  members: T[],
  now = new Date()
): Promise<Array<T & MemberActivityMetrics>> {
  const playerTags = members.map((member) => member.player_tag);
  if (playerTags.length === 0) return [];

  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [activityLogs24h, activityLogs7d, trackingSnapshots, dailyStatsSnapshots] = await Promise.all([
    fetchActivitySnapshotsWindow(
      playerTags,
      new Date(twentyFourHoursAgo.getTime() - 12 * 60 * 60 * 1000).toISOString(),
      new Date(twentyFourHoursAgo.getTime() + 12 * 60 * 60 * 1000).toISOString()
    ),
    fetchActivitySnapshotsWindow(
      playerTags,
      new Date(sevenDaysAgo.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      new Date(sevenDaysAgo.getTime() + 24 * 60 * 60 * 1000).toISOString()
    ),
    fetchTrackingSnapshots(playerTags),
    fetchDailyStatsSnapshots(
      playerTags,
      new Date(sevenDaysAgo.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    ),
  ]);

  const logsByPlayer = new Map<string, ActivitySnapshot[]>();
  for (const log of [...activityLogs24h, ...activityLogs7d]) {
    if (!logsByPlayer.has(log.player_tag)) {
      logsByPlayer.set(log.player_tag, []);
    }
    logsByPlayer.get(log.player_tag)!.push(log);
  }

  const latestBattleByPlayer = new Map<string, Date>();
  for (const snapshot of trackingSnapshots) {
    if (snapshot.last_battle_date) {
      latestBattleByPlayer.set(snapshot.player_tag, new Date(`${snapshot.last_battle_date}T00:00:00.000Z`));
    }
  }

  const dailyDelta24hByPlayer = new Map<string, number>();
  const dailyDelta7dByPlayer = new Map<string, number>();
  const twentyFourHoursAgoDate = twentyFourHoursAgo.toISOString().slice(0, 10);
  const sevenDaysAgoDate = sevenDaysAgo.toISOString().slice(0, 10);

  for (const row of dailyStatsSnapshots) {
    const delta = (row.trophies_gained || 0) - (row.trophies_lost || 0);
    if (row.date >= twentyFourHoursAgoDate) {
      dailyDelta24hByPlayer.set(row.player_tag, (dailyDelta24hByPlayer.get(row.player_tag) || 0) + delta);
    }

    if (row.date >= sevenDaysAgoDate) {
      dailyDelta7dByPlayer.set(row.player_tag, (dailyDelta7dByPlayer.get(row.player_tag) || 0) + delta);
    }
  }

  return members.map((member) => {
    const playerLogs = logsByPlayer.get(member.player_tag) || [];
    const baseline24h = findNearestBaseline(playerLogs, twentyFourHoursAgo, 12 * 60 * 60 * 1000);
    const baseline7d = findNearestBaseline(playerLogs, sevenDaysAgo, 24 * 60 * 60 * 1000);
    const snapshot24h = baseline24h != null ? member.trophies - baseline24h.trophies : null;
    const snapshot7d = baseline7d != null ? member.trophies - baseline7d.trophies : null;
    const fallback24h = dailyDelta24hByPlayer.has(member.player_tag)
      ? dailyDelta24hByPlayer.get(member.player_tag) || 0
      : null;
    const fallback7d = dailyDelta7dByPlayer.has(member.player_tag)
      ? dailyDelta7dByPlayer.get(member.player_tag) || 0
      : null;
    const trophies24h = snapshot24h != null ? snapshot24h : fallback24h;
    const trophies7d = snapshot7d != null ? snapshot7d : fallback7d;
    const lastBattleAt = latestBattleByPlayer.get(member.player_tag);
    const activityStatus = lastBattleAt
      ? (lastBattleAt >= twentyFourHoursAgo ? "active" : "minimal")
      : (trophies24h != null && trophies24h !== 0)
        ? "active"
        : (trophies7d != null && trophies7d !== 0)
          ? "minimal"
          : "inactive";

    return {
      ...member,
      trophies_24h: trophies24h,
      trophies_7d: trophies7d,
      activity_status: activityStatus,
      last_battle_at: lastBattleAt ? lastBattleAt.toISOString() : null,
    };
  });
}
