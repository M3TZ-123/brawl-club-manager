import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    // Get current member tags from member_history
    const { data: currentMemberHistory } = await supabase
      .from("member_history")
      .select("player_tag")
      .eq("is_current_member", true);
    
    const currentMemberTags = currentMemberHistory?.map(h => h.player_tag) || [];

    // Only fetch members who are currently in the club
    const { data: members, error } = await supabase
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
    const { data: activityLogs } = await supabase
      .from("activity_log")
      .select("player_tag, trophies, recorded_at")
      .gte("recorded_at", new Date(sevenDaysAgo.getTime() - 24 * 60 * 60 * 1000).toISOString())
      .order("recorded_at", { ascending: true });

    // Pre-group logs by player_tag for O(1) lookups instead of O(n) per member
    const logsByPlayer = new Map<string, typeof activityLogs>();
    for (const log of activityLogs || []) {
      if (!logsByPlayer.has(log.player_tag)) {
        logsByPlayer.set(log.player_tag, []);
      }
      logsByPlayer.get(log.player_tag)!.push(log);
    }

    // Build battle recency map from real battles (captures activity even when trophy change is 0)
    const { data: recentBattles } = await supabase
      .from("battle_history")
      .select("player_tag, battle_time, trophy_change")
      .in("player_tag", currentMemberTags.length > 0 ? currentMemberTags : [''])
      .gte("battle_time", sevenDaysAgo.toISOString())
      .order("battle_time", { ascending: false });

    const latestBattleByPlayer = new Map<string, Date>();
    const battleDelta24hByPlayer = new Map<string, number>();
    const battleDelta7dByPlayer = new Map<string, number>();
    for (const battle of recentBattles || []) {
      if (!latestBattleByPlayer.has(battle.player_tag)) {
        latestBattleByPlayer.set(battle.player_tag, new Date(battle.battle_time));
      }

      const battleTime = new Date(battle.battle_time);
      if (battleTime >= twentyFourHoursAgo) {
        battleDelta24hByPlayer.set(
          battle.player_tag,
          (battleDelta24hByPlayer.get(battle.player_tag) || 0) + (battle.trophy_change || 0)
        );
      }

      if (battleTime >= sevenDaysAgo) {
        battleDelta7dByPlayer.set(
          battle.player_tag,
          (battleDelta7dByPlayer.get(battle.player_tag) || 0) + (battle.trophy_change || 0)
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
        const fallback24h = battleDelta24hByPlayer.has(member.player_tag)
          ? battleDelta24hByPlayer.get(member.player_tag) || 0
          : null;
        const fallback7d = battleDelta7dByPlayer.has(member.player_tag)
          ? battleDelta7dByPlayer.get(member.player_tag) || 0
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
      const fallback24h = battleDelta24hByPlayer.has(member.player_tag)
        ? battleDelta24hByPlayer.get(member.player_tag) || 0
        : null;
      const fallback7d = battleDelta7dByPlayer.has(member.player_tag)
        ? battleDelta7dByPlayer.get(member.player_tag) || 0
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
