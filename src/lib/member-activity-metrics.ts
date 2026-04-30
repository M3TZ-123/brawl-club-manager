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

type BattleHistorySnapshot = {
  player_tag: string;
  battle_time: string;
};

type BattleDeltaSnapshot = {
  player_tag: string;
  battle_time: string;
  trophy_change: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_BATTLE_WINDOW_MS = DAY_MS;
const LOW_ACTIVITY_BATTLE_WINDOW_MS = 2 * DAY_MS;

export type MemberActivityMetrics = {
  trophies_24h: number | null;
  trophies_3d: number | null;
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

async function fetchLatestBattleHistorySnapshots(playerTags: string[]): Promise<BattleHistorySnapshot[]> {
  if (playerTags.length === 0) return [];

  const pageSize = 1000;
  const latestByPlayer = new Map<string, BattleHistorySnapshot>();

  for (let from = 0; latestByPlayer.size < playerTags.length; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("battle_history")
      .select("player_tag, battle_time")
      .in("player_tag", playerTags)
      .order("battle_time", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw error;

    for (const row of (data || []) as BattleHistorySnapshot[]) {
      if (!latestByPlayer.has(row.player_tag)) {
        latestByPlayer.set(row.player_tag, row);
      }
    }

    if (!data || data.length < pageSize) break;
  }

  return [...latestByPlayer.values()];
}

async function fetchBattleDeltaSnapshots(playerTags: string[], sinceISO: string): Promise<BattleDeltaSnapshot[]> {
  if (playerTags.length === 0) return [];

  const pageSize = 1000;
  const rows: BattleDeltaSnapshot[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("battle_history")
      .select("player_tag, battle_time, trophy_change")
      .in("player_tag", playerTags)
      .gte("battle_time", sinceISO)
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows.push(...((data || []) as BattleDeltaSnapshot[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
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

  const twentyFourHoursAgo = new Date(now.getTime() - ACTIVE_BATTLE_WINDOW_MS);
  const lowActivityCutoff = new Date(now.getTime() - LOW_ACTIVITY_BATTLE_WINDOW_MS);
  const threeDaysAgo = new Date(now.getTime() - 3 * DAY_MS);
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);

  const [activityLogs24h, activityLogs3d, activityLogs7d, trackingSnapshots, latestBattleSnapshots, battleDeltaSnapshots] = await Promise.all([
    fetchActivitySnapshotsWindow(
      playerTags,
      new Date(twentyFourHoursAgo.getTime() - 12 * 60 * 60 * 1000).toISOString(),
      new Date(twentyFourHoursAgo.getTime() + 12 * 60 * 60 * 1000).toISOString()
    ),
    fetchActivitySnapshotsWindow(
      playerTags,
      new Date(threeDaysAgo.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      new Date(threeDaysAgo.getTime() + 24 * 60 * 60 * 1000).toISOString()
    ),
    fetchActivitySnapshotsWindow(
      playerTags,
      new Date(sevenDaysAgo.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      new Date(sevenDaysAgo.getTime() + 24 * 60 * 60 * 1000).toISOString()
    ),
    fetchTrackingSnapshots(playerTags),
    fetchLatestBattleHistorySnapshots(playerTags),
    fetchBattleDeltaSnapshots(playerTags, sevenDaysAgo.toISOString()),
  ]);

  const logsByPlayer = new Map<string, ActivitySnapshot[]>();
  for (const log of [...activityLogs24h, ...activityLogs3d, ...activityLogs7d]) {
    if (!logsByPlayer.has(log.player_tag)) {
      logsByPlayer.set(log.player_tag, []);
    }
    logsByPlayer.get(log.player_tag)!.push(log);
  }

  const latestBattleByPlayer = new Map<string, Date>();
  for (const snapshot of latestBattleSnapshots) {
    latestBattleByPlayer.set(snapshot.player_tag, new Date(snapshot.battle_time));
  }

  for (const snapshot of trackingSnapshots) {
    if (snapshot.last_battle_date) {
      const trackingBattleDate = new Date(`${snapshot.last_battle_date}T00:00:00.000Z`);
      const currentLatest = latestBattleByPlayer.get(snapshot.player_tag);
      if (!currentLatest || trackingBattleDate > currentLatest) {
        latestBattleByPlayer.set(snapshot.player_tag, trackingBattleDate);
      }
    }
  }

  const battleDelta24hByPlayer = new Map<string, number>();
  const battleDelta3dByPlayer = new Map<string, number>();
  const battleDelta7dByPlayer = new Map<string, number>();

  for (const row of battleDeltaSnapshots) {
    const battleTime = new Date(row.battle_time).getTime();
    const delta = row.trophy_change || 0;

    if (battleTime >= twentyFourHoursAgo.getTime()) {
      battleDelta24hByPlayer.set(row.player_tag, (battleDelta24hByPlayer.get(row.player_tag) || 0) + delta);
    }

    if (battleTime >= threeDaysAgo.getTime()) {
      battleDelta3dByPlayer.set(row.player_tag, (battleDelta3dByPlayer.get(row.player_tag) || 0) + delta);
    }

    if (battleTime >= sevenDaysAgo.getTime()) {
      battleDelta7dByPlayer.set(row.player_tag, (battleDelta7dByPlayer.get(row.player_tag) || 0) + delta);
    }
  }

  return members.map((member) => {
    const playerLogs = logsByPlayer.get(member.player_tag) || [];
    const baseline24h = findNearestBaseline(playerLogs, twentyFourHoursAgo, 12 * 60 * 60 * 1000);
    const baseline3d = findNearestBaseline(playerLogs, threeDaysAgo, 24 * 60 * 60 * 1000);
    const baseline7d = findNearestBaseline(playerLogs, sevenDaysAgo, 24 * 60 * 60 * 1000);
    const snapshot24h = baseline24h != null ? member.trophies - baseline24h.trophies : null;
    const snapshot3d = baseline3d != null ? member.trophies - baseline3d.trophies : null;
    const snapshot7d = baseline7d != null ? member.trophies - baseline7d.trophies : null;
    const fallback24h = battleDelta24hByPlayer.has(member.player_tag)
      ? battleDelta24hByPlayer.get(member.player_tag) || 0
      : null;
    const fallback3d = battleDelta3dByPlayer.has(member.player_tag)
      ? battleDelta3dByPlayer.get(member.player_tag) || 0
      : null;
    const fallback7d = battleDelta7dByPlayer.has(member.player_tag)
      ? battleDelta7dByPlayer.get(member.player_tag) || 0
      : null;
    const trophies24h = snapshot24h != null ? snapshot24h : fallback24h;
    const trophies3d = snapshot3d != null ? snapshot3d : fallback3d;
    const trophies7d = snapshot7d != null ? snapshot7d : fallback7d;
    const lastBattleAt = latestBattleByPlayer.get(member.player_tag);
    let activityStatus: MemberActivityMetrics["activity_status"];

    if (lastBattleAt) {
      if (lastBattleAt >= twentyFourHoursAgo) {
        activityStatus = "active";
      } else if (lastBattleAt >= lowActivityCutoff) {
        activityStatus = "minimal";
      } else {
        activityStatus = "inactive";
      }
    } else if (trophies24h != null && trophies24h !== 0) {
      activityStatus = "active";
    } else if (trophies7d != null && trophies7d !== 0) {
      activityStatus = "minimal";
    } else {
      activityStatus = "inactive";
    }

    return {
      ...member,
      trophies_24h: trophies24h,
      trophies_3d: trophies3d,
      trophies_7d: trophies7d,
      activity_status: activityStatus,
      last_battle_at: lastBattleAt ? lastBattleAt.toISOString() : null,
    };
  });
}
