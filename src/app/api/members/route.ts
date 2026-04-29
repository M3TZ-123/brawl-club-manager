import { NextResponse } from "next/server";
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

export async function GET() {
  try {
    // Get current member tags from member_history
    const { data: currentMemberHistory, error: currentMemberError } = await supabaseAdmin
      .from("member_history")
      .select("player_tag")
      .eq("is_current_member", true);

    if (currentMemberError) throw currentMemberError;
    
    const currentMemberTags = currentMemberHistory?.map(h => h.player_tag) || [];

    // Only fetch members who are currently in the club
    const { data: members, error } = await supabaseAdmin
      .from("members")
      .select("*")
      .in("player_tag", currentMemberTags.length > 0 ? currentMemberTags : [''])
      .order("trophies", { ascending: false });

    if (error) throw error;

    // Calculate trophy gains for each member using activity_log snapshots
    // activity_log records total trophies at each sync point — this is the most
    // reliable source because it doesn't depend on incomplete battle logs.
    const now = new Date();
    
    // For 24h: look back exactly 24 hours
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    // For 7 days: look back exactly 7 days
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Get activity logs from the last 7 days (plus a small buffer for baseline)
    const [activityLogs24h, activityLogs7d, trackingSnapshots, dailyStatsSnapshots] = await Promise.all([
      fetchActivitySnapshotsWindow(
        currentMemberTags,
        new Date(twentyFourHoursAgo.getTime() - 12 * 60 * 60 * 1000).toISOString(),
        new Date(twentyFourHoursAgo.getTime() + 12 * 60 * 60 * 1000).toISOString()
      ),
      fetchActivitySnapshotsWindow(
        currentMemberTags,
        new Date(sevenDaysAgo.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        new Date(sevenDaysAgo.getTime() + 24 * 60 * 60 * 1000).toISOString()
      ),
      fetchTrackingSnapshots(currentMemberTags),
      fetchDailyStatsSnapshots(
        currentMemberTags,
        new Date(sevenDaysAgo.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      ),
    ]);
    const activityLogs = [...activityLogs24h, ...activityLogs7d];

    // Pre-group logs by player_tag for O(1) lookups instead of O(n) per member
    const logsByPlayer = new Map<string, ActivitySnapshot[]>();
    for (const log of activityLogs) {
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
        dailyDelta24hByPlayer.set(
          row.player_tag,
          (dailyDelta24hByPlayer.get(row.player_tag) || 0) + delta
        );
      }

      if (row.date >= sevenDaysAgoDate) {
        dailyDelta7dByPlayer.set(
          row.player_tag,
          (dailyDelta7dByPlayer.get(row.player_tag) || 0) + delta
        );
      }
    }

    const findNearestBaseline = (
      playerLogs: Array<{ player_tag: string; trophies: number; recorded_at: string }>,
      targetTime: Date,
      maxDistanceMs: number
    ) => {
      let nearest: { player_tag: string; trophies: number; recorded_at: string } | null = null;
      let nearestDistance = Number.POSITIVE_INFINITY;

      for (const log of playerLogs) {
        const distance = Math.abs(new Date(log.recorded_at).getTime() - targetTime.getTime());
        if (distance <= maxDistanceMs && distance < nearestDistance) {
          nearest = log;
          nearestDistance = distance;
        }
      }

      return nearest;
    };

    // Calculate gains and activity for each member
    const membersWithGains = (members || []).map((member) => {
      const playerLogs = logsByPlayer.get(member.player_tag) || [];

      // If no activity logs exist, we still compute activity_status from battles and fallback flags
      if (playerLogs.length === 0) {
        const lastBattleAt = latestBattleByPlayer.get(member.player_tag);
        const fallback24h = dailyDelta24hByPlayer.has(member.player_tag)
          ? dailyDelta24hByPlayer.get(member.player_tag) || 0
          : null;
        const fallback7d = dailyDelta7dByPlayer.has(member.player_tag)
          ? dailyDelta7dByPlayer.get(member.player_tag) || 0
          : null;
        const activityStatus = lastBattleAt
          ? (lastBattleAt >= twentyFourHoursAgo ? "active" : "minimal")
          : (fallback24h != null && fallback24h !== 0)
            ? "active"
            : (fallback7d != null && fallback7d !== 0)
              ? "minimal"
              : "inactive";

        return {
          ...member,
          trophies_24h: fallback24h,
          trophies_7d: fallback7d,
          activity_status: activityStatus,
          last_battle_at: lastBattleAt ? lastBattleAt.toISOString() : null,
        };
      }

      // Use nearest baseline around target window to avoid stale snapshots inflating deltas.
      // 24h baseline must be within ±12h of the 24h target.
      const baseline24h = findNearestBaseline(playerLogs, twentyFourHoursAgo, 12 * 60 * 60 * 1000);
      // 7d baseline must be within ±24h of the 7d target.
      const baseline7d = findNearestBaseline(playerLogs, sevenDaysAgo, 24 * 60 * 60 * 1000);

      // Calculate 24h gain: current trophies minus trophies ~24h ago
      const snapshot24h = baseline24h != null
        ? member.trophies - baseline24h.trophies
        : null;

      // Calculate 7-day gain: current trophies minus trophies ~7d ago
      const snapshot7d = baseline7d != null
        ? member.trophies - baseline7d.trophies
        : null;

      // Fallback to battle deltas when snapshot baseline is unavailable
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

    return NextResponse.json({ members: membersWithGains });
  } catch (error) {
    console.error("Error fetching members:", error);
    return NextResponse.json(
      { error: "Failed to fetch members" },
      { status: 500 }
    );
  }
}
