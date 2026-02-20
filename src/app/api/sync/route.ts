import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getClub, getPlayer, setApiKey, getPlayerRankedData, getPlayerBattleLog, processBattleLog, calculateWinRateFromBattleLog, BrawlStarsBattleLog } from "@/lib/brawl-api";
import { supabase } from "@/lib/supabase";

function buildNotificationDedupeKey(
  type: string,
  title: string,
  message: string,
  playerTag: string | null,
  createdAtISO: string
) {
  const secondEpoch = Math.floor(new Date(createdAtISO).getTime() / 1000) * 1000;
  const secondIso = new Date(secondEpoch).toISOString();
  return createHash("sha256")
    .update(`${type}|${playerTag || ""}|${title}|${message}|${secondIso}`)
    .digest("hex");
}

// GET handler for Vercel Cron Jobs and GitHub Actions
export async function GET(request: NextRequest) {
  try {
    // Optional: Verify cron secret if configured
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;
    
    // Only check auth if CRON_SECRET is actually set on the server
    if (cronSecret && cronSecret.length > 0) {
      if (authHeader !== `Bearer ${cronSecret}`) {
        console.log("Unauthorized cron request - invalid secret");
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    console.log("Cron sync triggered via GET");
    // Call the main sync logic
    return await syncClubData();
  } catch (error) {
    console.error("GET sync error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to sync data", message: errorMessage },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Get settings from request body
    const body = await request.json().catch(() => ({}));
    return await syncClubData(body.clubTag, body.apiKey, body.initialSetup === true);
  } catch (error) {
    console.error("POST sync error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to sync data", message: errorMessage },
      { status: 500 }
    );
  }
}

async function syncClubData(providedClubTag?: string, providedApiKey?: string, isInitialSetup = false) {
  try {
    console.log("Starting sync...");
    let clubTag = providedClubTag;
    let apiKey = providedApiKey;

    // Always try to get from database first (most up-to-date)
    let discordWebhook = "";
    let notificationsEnabled = false;
    let inactivityThreshold = 48;

    // Always fetch all settings from database
    {
      console.log("Fetching settings from database...");
      const { data: settings, error: settingsError } = await supabase
        .from("settings")
        .select("key, value")
        .in("key", ["club_tag", "api_key", "discord_webhook", "notifications_enabled", "inactivity_threshold"]);
      
      if (settingsError) {
        console.error("Error fetching settings:", settingsError);
        return NextResponse.json(
          { error: "Failed to fetch settings from database", details: settingsError.message },
          { status: 500 }
        );
      }
      
      if (settings) {
        console.log("Settings found:", settings.length, "items");
        for (const setting of settings) {
          if (setting.key === "club_tag" && !clubTag) clubTag = setting.value;
          if (setting.key === "api_key" && !apiKey) apiKey = setting.value;
          if (setting.key === "discord_webhook") discordWebhook = setting.value;
          if (setting.key === "notifications_enabled") notificationsEnabled = setting.value === "true";
          if (setting.key === "inactivity_threshold") inactivityThreshold = parseInt(setting.value) || 48;
        }
      } else {
        console.log("No settings found in database");
      }
      console.log("From DB - clubTag:", clubTag ? "yes" : "no", "apiKey:", apiKey ? "yes" : "no");
    }

    // Fallback to env vars only if database doesn't have them
    if (!clubTag) {
      clubTag = process.env.CLUB_TAG;
      if (clubTag) console.log("Using CLUB_TAG from environment variable");
    }
    if (!apiKey) {
      apiKey = process.env.BRAWL_API_KEY;
      if (apiKey) console.log("Using BRAWL_API_KEY from environment variable");
    }

    if (!clubTag || !apiKey) {
      console.error("Missing credentials - clubTag:", !!clubTag, "apiKey:", !!apiKey);
      return NextResponse.json(
        { error: "Club tag and API key are required. Please configure in Settings." },
        { status: 400 }
      );
    }

    // Debug: Log what we're using (mask API key for security)
    console.log("Using clubTag:", clubTag);
    console.log("API key configured: yes, length:", apiKey.length);
    
    setApiKey(apiKey);
    console.log("API key set, fetching club data...");

    // inactivityThreshold already loaded from settings above (default 48 hours)

    // Fetch club data
    const club = await getClub(clubTag);
    const currentMemberTags = new Set(club.members.map((m) => m.tag));

    // Get existing members from database
    const { data: existingMembers } = await supabase
      .from("members")
      .select("player_tag, player_name, icon_id, role, trophies, rank_current, rank_highest");

    const existingMemberMap = new Map(
      existingMembers?.map((m) => [m.player_tag, m]) || []
    );

    // Get last activity for each member (to check inactivity threshold)
    const thresholdTime = new Date(Date.now() - inactivityThreshold * 60 * 60 * 1000).toISOString();
    const { data: recentActivity } = await supabase
      .from("activity_log")
      .select("player_tag, trophy_change, recorded_at")
      .gte("recorded_at", thresholdTime)
      .neq("trophy_change", 0);
    
    // Map of players who had activity in the threshold period
    const activePlayersSet = new Set(recentActivity?.map((a) => a.player_tag) || []);

    // Get member history
    const { data: memberHistory } = await supabase
      .from("member_history")
      .select("*");

    const historyMap = new Map(
      memberHistory?.map((h) => [h.player_tag, h]) || []
    );

    // Process each club member
    const memberUpdates = [];
    const activityLogs = [];
    const events = [];
    const memberChangeNotifs: Array<{ type: string; title: string; message: string; player_tag: string; player_name: string }> = [];
    const historyUpdates = [];
    const allBattles: ReturnType<typeof processBattleLog> = [];
    const brawlerSnapshots: {
      player_tag: string;
      brawler_id: number;
      brawler_name: string;
      power_level: number;
      trophies: number;
      rank: number;
      gadgets_count: number;
      star_powers_count: number;
      gears_count: number;
    }[] = [];

    const normalizeRole = (role: string | null | undefined) =>
      (role || "").toLowerCase().replace(/[\s_-]/g, "");
    const roleRank: Record<string, number> = {
      member: 0,
      senior: 1,
      vicepresident: 2,
      president: 3,
    };

    // Process members in parallel batches of 4
    // Brawl Stars API rate limit: ~10 req/sec per key
    // 4 members × 2 BS API calls = 8 concurrent BS requests (safe under 10/sec)
    // 4 members × 1 RNT API call = 4 concurrent RNT requests (separate limit)
    const BATCH_SIZE = 4;
    const BATCH_DELAY_MS = 300; // Delay between batches to stay under rate limit
    const memberBatches = [];
    for (let i = 0; i < club.members.length; i += BATCH_SIZE) {
      memberBatches.push(club.members.slice(i, i + BATCH_SIZE));
    }

    for (let batchIndex = 0; batchIndex < memberBatches.length; batchIndex++) {
      const batch = memberBatches[batchIndex];
      
      // Add delay between batches (not before first batch)
      if (batchIndex > 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
      
      const batchResults = await Promise.all(
        batch.map(async (member) => {
          try {
            // Run 3 API calls in parallel (battleLog is used for both win rate and history)
            // Brawl Stars API: getPlayer, getPlayerBattleLog
            // RNT API: getPlayerRankedData
            // battleLog can 404 for new/private accounts — catch gracefully
            const [player, rankedData, battleLog] = await Promise.all([
              getPlayer(member.tag),
              getPlayerRankedData(member.tag),
              getPlayerBattleLog(member.tag).catch((err) => {
                console.warn(`Battle log unavailable for ${member.tag}: ${err.message}`);
                return { items: [] } as BrawlStarsBattleLog;
              }),
            ]);

            // Calculate win rate from the already-fetched battle log (no extra API call)
            const winRateData = calculateWinRateFromBattleLog(battleLog);

            const existingMember = existingMemberMap.get(member.tag);
            const trophyChange = existingMember
              ? player.trophies - existingMember.trophies
              : 0;

            // Determine activity type based on current trophy change
            let activityType = "inactive";
            if (Math.abs(trophyChange) >= 20) {
              activityType = "active";
            } else if (Math.abs(trophyChange) > 0) {
              activityType = "minimal";
            }
            
            // Check if player had any activity in the threshold period
            // If they had activity before (in activePlayersSet) OR have activity now, they're active
            const hadRecentActivity = activePlayersSet.has(member.tag);
            const isActive = hadRecentActivity || Math.abs(trophyChange) > 0;

            // Process battle log for storage
            const processedBattles = processBattleLog(member.tag, battleLog);

            return {
              member,
              player,
              rankedData,
              winRateData,
              processedBattles,
              trophyChange,
              activityType,
              isActive,
              success: true as const,
            };
          } catch (error) {
            console.error(`Error processing member ${member.tag}:`, error);
            return { member, success: false as const };
          }
        })
      );

      // Process successful results
      for (const result of batchResults) {
        if (!result.success) continue;

        const { member, player, rankedData, winRateData, processedBattles, trophyChange, activityType, isActive } = result as {
          member: typeof batch[0];
          player: Awaited<ReturnType<typeof getPlayer>>;
          rankedData: Awaited<ReturnType<typeof getPlayerRankedData>>;
          winRateData: ReturnType<typeof calculateWinRateFromBattleLog>;
          processedBattles: ReturnType<typeof processBattleLog>;
          trophyChange: number;
          activityType: string;
          isActive: boolean;
          success: true;
        };

        // Prepare member update
        // If RNT API failed (returned Unranked), preserve existing rank data
        const existingMemberData = existingMemberMap.get(member.tag);
        const resolvedCurrentRank = rankedData.currentRank !== "Unranked" 
          ? rankedData.currentRank 
          : (existingMemberData?.rank_current || "Unranked");
        const resolvedHighestRank = rankedData.highestRank !== "Unranked" 
          ? rankedData.highestRank 
          : (existingMemberData?.rank_highest || "Unranked");

        if (existingMemberData?.player_name && existingMemberData.player_name !== member.name) {
          memberChangeNotifs.push({
            type: "name_change",
            title: "Name Changed",
            message: `${existingMemberData.player_name} is now ${member.name} (${member.tag}).`,
            player_tag: member.tag,
            player_name: member.name,
          });
        }

        const prevRoleNorm = normalizeRole(existingMemberData?.role);
        const currentRoleNorm = normalizeRole(member.role);
        if (prevRoleNorm && currentRoleNorm && prevRoleNorm !== currentRoleNorm) {
          const prevRank = roleRank[prevRoleNorm] ?? -1;
          const nextRank = roleRank[currentRoleNorm] ?? -1;
          const roleType = nextRank > prevRank ? "promotion" : nextRank < prevRank ? "demotion" : "role_change";
          const roleTitle = roleType === "promotion"
            ? "Member Promoted"
            : roleType === "demotion"
              ? "Member Demoted"
              : "Role Changed";
          memberChangeNotifs.push({
            type: roleType,
            title: roleTitle,
            message: `${member.name} (${member.tag}) role changed: ${existingMemberData?.role || "unknown"} → ${member.role}.`,
            player_tag: member.tag,
            player_name: member.name,
          });
        }

        memberUpdates.push({
          player_tag: member.tag,
          player_name: member.name,
          icon_id: player.icon?.id || existingMemberData?.icon_id || null,
          role: member.role,
          trophies: player.trophies,
          highest_trophies: player.highestTrophies,
          exp_level: player.expLevel,
          rank_current: resolvedCurrentRank,
          rank_highest: resolvedHighestRank,
          win_rate: winRateData.winRate,
          brawlers_count: player.brawlers.length,
          solo_victories: player.soloVictories,
          duo_victories: player.duoVictories,
          trio_victories: player["3vs3Victories"],
          is_active: isActive,
          last_updated: new Date().toISOString(),
        });

        // Log activity
        activityLogs.push({
          player_tag: member.tag,
          trophies: player.trophies,
          trophy_change: trophyChange,
          activity_type: activityType,
        });

        // Collect battles for storage
        if (processedBattles && processedBattles.length > 0) {
          allBattles.push(...processedBattles);
        }


        // Collect brawler snapshots
        for (const brawler of player.brawlers) {
          brawlerSnapshots.push({
            player_tag: member.tag,
            brawler_id: brawler.id,
            brawler_name: brawler.name,
            power_level: brawler.power,
            trophies: brawler.trophies,
            rank: brawler.rank,
            gadgets_count: brawler.gadgets?.length || 0,
            star_powers_count: brawler.starPowers?.length || 0,
            gears_count: brawler.gears?.length || 0,
          });
        }

        // Update member history
        const history = historyMap.get(member.tag);
        if (history) {
          if (!history.is_current_member) {
            // Returning member!
            historyUpdates.push({
              player_tag: member.tag,
              player_name: member.name,
              last_seen: new Date().toISOString(),
              times_joined: history.times_joined + 1,
              is_current_member: true,
            });
            // Only create join event if not initial setup
            events.push({
              event_type: "join",
              player_tag: member.tag,
              player_name: member.name,
            });
          } else {
            historyUpdates.push({
              player_tag: member.tag,
              player_name: member.name,
              last_seen: new Date().toISOString(),
              is_current_member: true,
            });
          }
        } else {
          // New member - check if this is initial setup or a real new join
          const isFirstSync = memberHistory?.length === 0 || isInitialSetup;
          
          historyUpdates.push({
            player_tag: member.tag,
            player_name: member.name,
            first_seen: new Date().toISOString(),
            last_seen: new Date().toISOString(),
            times_joined: 1,
            times_left: 0,
            is_current_member: true,
          });
          
          // Only create join event if this is NOT the initial setup
          // This way existing members don't get a "join" event on first sync
          if (!isFirstSync) {
            events.push({
              event_type: "join",
              player_tag: member.tag,
              player_name: member.name,
            });
          }
        }
      }
    }

    // Check for members who left
    for (const history of memberHistory || []) {
      if (history.is_current_member && !currentMemberTags.has(history.player_tag)) {
        const leavingMemberSnapshot = existingMemberMap.get(history.player_tag);
        historyUpdates.push({
          player_tag: history.player_tag,
          player_name: history.player_name,
          last_seen: new Date().toISOString(),
          last_left_at: new Date().toISOString(),
          times_left: history.times_left + 1,
          is_current_member: false,
          role_at_leave: leavingMemberSnapshot?.role || null,
          trophies_at_leave: typeof leavingMemberSnapshot?.trophies === "number"
            ? leavingMemberSnapshot.trophies
            : null,
        });
        events.push({
          event_type: "leave",
          player_tag: history.player_tag,
          player_name: history.player_name,
        });

        // Mark member as inactive
        await supabase
          .from("members")
          .update({ is_active: false })
          .eq("player_tag", history.player_tag);
      }
    }

    // Deduplicate join/leave events (batch + recent DB window) to avoid duplicates
    let eventsToInsert = events;
    if (events.length > 0) {
      const uniqueBatchEventKeys = new Set<string>();
      eventsToInsert = events.filter((evt) => {
        const key = `${evt.event_type}|${evt.player_tag}|${evt.player_name}`;
        if (uniqueBatchEventKeys.has(key)) return false;
        uniqueBatchEventKeys.add(key);
        return true;
      });

      const recentEventWindowISO = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const eventTypes = [...new Set(eventsToInsert.map((evt) => evt.event_type))];
      const eventTags = [...new Set(eventsToInsert.map((evt) => evt.player_tag))];

      if (eventTypes.length > 0 && eventTags.length > 0) {
        const { data: recentEvents } = await supabase
          .from("club_events")
          .select("event_type, player_tag, player_name, event_time")
          .in("event_type", eventTypes)
          .in("player_tag", eventTags)
          .gte("event_time", recentEventWindowISO);

        const existingRecentEventKeys = new Set(
          (recentEvents || []).map((evt) => `${evt.event_type}|${evt.player_tag}|${evt.player_name}`)
        );

        eventsToInsert = eventsToInsert.filter(
          (evt) => !existingRecentEventKeys.has(`${evt.event_type}|${evt.player_tag}|${evt.player_name}`)
        );
      }
    }

    // Run independent DB writes in parallel for speed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbWrites: any[] = [];

    // Upsert members
    if (memberUpdates.length > 0) {
      dbWrites.push(supabase.from("members").upsert(memberUpdates, {
        onConflict: "player_tag",
      }));
    }

    // Insert activity logs
    if (activityLogs.length > 0) {
      dbWrites.push(supabase.from("activity_log").insert(activityLogs));
    }

    // Upsert member history
    if (historyUpdates.length > 0) {
      dbWrites.push(supabase.from("member_history").upsert(historyUpdates, {
        onConflict: "player_tag",
      }));
    }

    // Insert events
    if (eventsToInsert.length > 0) {
      dbWrites.push(supabase.from("club_events").insert(eventsToInsert));
    }

    // Wait for core DB writes to finish
    await Promise.all(dbWrites);

    // Store battle history and daily stats (can run in parallel with snapshots)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondaryDbWrites: any[] = [];

    // Fix timezone offset: Brawl Stars API battleTime may not be UTC despite Z suffix.
    // If the most recent battle appears to be in the future, detect and correct the offset.
    if (allBattles.length > 0) {
      const serverNow = Date.now();
      const battleTimestamps = allBattles.map(b => new Date(b.battle_time).getTime());
      const maxBattleTime = battleTimestamps.reduce((max, t) => t > max ? t : max, 0);
      
      if (maxBattleTime > serverNow + 60000) { // More than 1 minute in the future
        const rawOffsetMs = maxBattleTime - serverNow;
        const offsetHours = Math.ceil(rawOffsetMs / 3600000);
        const offsetMs = offsetHours * 3600000;
        console.log(`Detected battle time timezone offset: +${offsetHours}h, adjusting ${allBattles.length} battles`);
        for (const battle of allBattles) {
          battle.battle_time = new Date(new Date(battle.battle_time).getTime() - offsetMs).toISOString();
        }
      }
    }

    if (allBattles.length > 0) {
      // Insert battles, ignore duplicates
      secondaryDbWrites.push(
        supabase
          .from("battle_history")
          .upsert(allBattles, {
            onConflict: "player_tag,battle_time",
            ignoreDuplicates: false,
          })
          .then(({ error }) => {
            if (error) console.error("Error storing battle history:", error);
          })
      );

      // Build daily stats from battles
      const dailyStatsMap = new Map<string, {
        player_tag: string;
        date: string;
        battles: number;
        wins: number;
        losses: number;
        star_player: number;
        trophies_gained: number;
        trophies_lost: number;
      }>();

      for (const battle of allBattles) {
        const date = battle.battle_time.slice(0, 10); // YYYY-MM-DD
        const key = `${battle.player_tag}_${date}`;
        
        if (!dailyStatsMap.has(key)) {
          dailyStatsMap.set(key, {
            player_tag: battle.player_tag,
            date,
            battles: 0,
            wins: 0,
            losses: 0,
            star_player: 0,
            trophies_gained: 0,
            trophies_lost: 0,
          });
        }
        
        const stats = dailyStatsMap.get(key)!;
        stats.battles++;
        if (battle.result === "victory") stats.wins++;
        if (battle.result === "defeat") stats.losses++;
        if (battle.is_star_player) stats.star_player++;
        if (battle.trophy_change > 0) stats.trophies_gained += battle.trophy_change;
        if (battle.trophy_change < 0) stats.trophies_lost += Math.abs(battle.trophy_change);
      }

      const dailyStatsArray = Array.from(dailyStatsMap.values());
      if (dailyStatsArray.length > 0) {
        secondaryDbWrites.push(
          supabase
            .from("daily_stats")
            .upsert(dailyStatsArray, { onConflict: "player_tag,date" })
            .then(({ error }) => {
              if (error) console.error("Error storing daily stats:", error);
            })
        );
      }
    }

    // Store brawler snapshots (for tracking power ups/unlocks)
    if (brawlerSnapshots.length > 0) {
      const playerTags = [...new Set(brawlerSnapshots.map(s => s.player_tag))];
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      const { data: allPrevSnapshots } = await supabase
        .from("brawler_snapshots")
        .select("player_tag, brawler_id, power_level")
        .in("player_tag", playerTags)
        .gte("recorded_at", yesterdayStr);

      const prevByPlayer = new Map<string, Map<number, number>>();
      const playersWithPrevData = new Set<string>();
      for (const snap of allPrevSnapshots || []) {
        playersWithPrevData.add(snap.player_tag);
        if (!prevByPlayer.has(snap.player_tag)) {
          prevByPlayer.set(snap.player_tag, new Map());
        }
        prevByPlayer.get(snap.player_tag)!.set(snap.brawler_id, snap.power_level);
      }

      const trackingUpdates: Array<{ player_tag: string; power_ups: number; unlocks: number; last_updated: string }> = [];

      for (const playerTag of playerTags) {
        const playerBrawlers = brawlerSnapshots.filter(s => s.player_tag === playerTag);
        const prevMap = prevByPlayer.get(playerTag) || new Map();
        const hadPrevData = playersWithPrevData.has(playerTag);
        
        let powerUps = 0;
        let unlocks = 0;
        
        for (const brawler of playerBrawlers) {
          const prevPower = prevMap.get(brawler.brawler_id);
          if (prevPower === undefined) {
            if (hadPrevData) unlocks++;
          } else if (brawler.power_level > prevPower) {
            powerUps += brawler.power_level - prevPower;
          }
        }
        
        if (powerUps > 0 || unlocks > 0) {
          trackingUpdates.push({
            player_tag: playerTag,
            power_ups: powerUps,
            unlocks: unlocks,
            last_updated: new Date().toISOString(),
          });
        }
      }

      if (trackingUpdates.length > 0) {
        secondaryDbWrites.push(
          supabase.from("player_tracking").upsert(trackingUpdates, { onConflict: "player_tag" })
        );
      }
      
      // Delete today's existing snapshots for these players, then insert fresh ones
      // (avoids the functional unique constraint issue with recorded_at::date)
      const snapshotPlayerTags = [...new Set(brawlerSnapshots.map(s => s.player_tag))];
      const todayStr = new Date().toISOString().slice(0, 10);
      secondaryDbWrites.push(
        supabase
          .from("brawler_snapshots")
          .delete()
          .in("player_tag", snapshotPlayerTags)
          .gte("recorded_at", todayStr)
          .lt("recorded_at", todayStr + "T23:59:59.999Z")
          .then(() => 
            supabase
              .from("brawler_snapshots")
              .insert(brawlerSnapshots)
          )
          .then(({ error }) => {
            if (error) console.error("Error storing brawler snapshots:", error);
          })
      );
    }

    // Wait for all secondary DB writes
    await Promise.all(secondaryDbWrites);

    // Auto-purge old data to prevent DB from filling up (keep last 30 days)
    const retentionDays = 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    const cutoffISO = cutoffDate.toISOString();
    const cutoffDateStr = cutoffISO.slice(0, 10);

    await Promise.all([
      supabase.from("battle_history").delete().lt("battle_time", cutoffISO)
        .then(({ error, count }) => {
          if (error) console.error("Error purging old battles:", error);
          else if (count && count > 0) console.log(`Purged ${count} battles older than ${retentionDays} days`);
        }),
      supabase.from("daily_stats").delete().lt("date", cutoffDateStr)
        .then(({ error, count }) => {
          if (error) console.error("Error purging old daily stats:", error);
          else if (count && count > 0) console.log(`Purged ${count} daily stats older than ${retentionDays} days`);
        }),
      supabase.from("brawler_snapshots").delete().lt("recorded_at", cutoffDateStr)
        .then(({ error, count }) => {
          if (error) console.error("Error purging old brawler snapshots:", error);
          else if (count && count > 0) console.log(`Purged ${count} snapshots older than ${retentionDays} days`);
        }),
    ]);

    // Insert DB notifications for the notification panel
      const notifRows: Array<{
        type: string;
        title: string;
        message: string;
        player_tag: string | null;
        player_name: string | null;
        dedupe_key: string;
      }> = [];
      const notifCreatedAt = new Date().toISOString();

      for (const evt of eventsToInsert) {
        if (evt.event_type === "join") {
          notifRows.push({
            type: "join",
            title: "Member Joined",
            message: `${evt.player_name} (${evt.player_tag}) joined the club.`,
            player_tag: evt.player_tag,
            player_name: evt.player_name,
            dedupe_key: buildNotificationDedupeKey(
              "join",
              "Member Joined",
              `${evt.player_name} (${evt.player_tag}) joined the club.`,
              evt.player_tag,
              notifCreatedAt
            ),
          });
        } else if (evt.event_type === "leave") {
          notifRows.push({
            type: "leave",
            title: "Member Left",
            message: `${evt.player_name} (${evt.player_tag}) left the club.`,
            player_tag: evt.player_tag,
            player_name: evt.player_name,
            dedupe_key: buildNotificationDedupeKey(
              "leave",
              "Member Left",
              `${evt.player_name} (${evt.player_tag}) left the club.`,
              evt.player_tag,
              notifCreatedAt
            ),
          });
        }
      }

      for (const notif of memberChangeNotifs) {
        notifRows.push({
          type: notif.type,
          title: notif.title,
          message: notif.message,
          player_tag: notif.player_tag,
          player_name: notif.player_name,
          dedupe_key: buildNotificationDedupeKey(
            notif.type,
            notif.title,
            notif.message,
            notif.player_tag,
            notifCreatedAt
          ),
        });
      }

      // Inactive members notification — reuse the same 24h throttle logic
      const inactiveMembersForNotif = memberUpdates.filter(m => !m.is_active);
      if (inactiveMembersForNotif.length > 0) {
        const { data: lastAlert } = await supabase
          .from("settings")
          .select("value")
          .eq("key", "last_inactive_notif")
          .single();
        const lastTime = lastAlert?.value ? new Date(lastAlert.value).getTime() : 0;
        if ((Date.now() - lastTime) / (1000 * 60 * 60) >= 24) {
          const names = inactiveMembersForNotif
            .slice(0, 10)
            .map((m) => `${m.player_name} (${m.player_tag})`)
            .join(", ");
          const extra = inactiveMembersForNotif.length > 10 ? ` and ${inactiveMembersForNotif.length - 10} more` : "";
          const inactiveTitle = `${inactiveMembersForNotif.length} Inactive Member(s)`;
          const inactiveMessage = `${names}${extra} — inactive for ${inactivityThreshold}+ hours.`;
          notifRows.push({
            type: "inactive",
            title: inactiveTitle,
            message: inactiveMessage,
            player_tag: null,
            player_name: null,
            dedupe_key: buildNotificationDedupeKey(
              "inactive",
              inactiveTitle,
              inactiveMessage,
              null,
              notifCreatedAt
            ),
          });
          await supabase.from("settings").upsert({ key: "last_inactive_notif", value: new Date().toISOString() }, { onConflict: "key" });
        }
      }

      if (notifRows.length > 0) {
        const uniqueBatchNotifKeys = new Set<string>();
        let notifRowsToInsert = notifRows.filter((notif) => {
          const key = `${notif.type}|${notif.player_tag || ""}|${notif.title}|${notif.message}`;
          if (uniqueBatchNotifKeys.has(key)) return false;
          uniqueBatchNotifKeys.add(key);
          return true;
        });

        const notifTypes = [...new Set(notifRowsToInsert.map((n) => n.type))];
        const recentNotifWindowISO = new Date(Date.now() - 10 * 60 * 1000).toISOString();

        if (notifTypes.length > 0) {
          const { data: recentNotifs } = await supabase
            .from("notifications")
            .select("type, title, message, player_tag, created_at")
            .in("type", notifTypes)
            .gte("created_at", recentNotifWindowISO);

          const existingRecentNotifKeys = new Set(
            (recentNotifs || []).map((notif) => `${notif.type}|${notif.player_tag || ""}|${notif.title}|${notif.message}`)
          );

          notifRowsToInsert = notifRowsToInsert.filter(
            (notif) => !existingRecentNotifKeys.has(`${notif.type}|${notif.player_tag || ""}|${notif.title}|${notif.message}`)
          );
        }

        if (notifRowsToInsert.length > 0) {
          const { error: notifError } = await supabase
            .from("notifications")
            .upsert(notifRowsToInsert, { onConflict: "dedupe_key", ignoreDuplicates: true });
          if (notifError) console.error("Error inserting notifications:", notifError);
          else console.log(`Inserted ${notifRowsToInsert.length} notification(s) into DB`);
        }
      }

    // Send Discord webhook notifications for joins/leaves/inactivity
    if (notificationsEnabled && discordWebhook && discordWebhook.startsWith("https://discord.com/api/webhooks/")) {
      try {
        const embeds: Array<{ title: string; description: string; color: number; timestamp: string }> = [];

        // Join events
        for (const evt of eventsToInsert.filter(e => e.event_type === "join")) {
          embeds.push({
            title: "\u2705 Member Joined",
            description: `**${evt.player_name}** (${evt.player_tag}) joined the club.`,
            color: 0x22c55e, // green
            timestamp: new Date().toISOString(),
          });
        }

        // Leave events
        for (const evt of eventsToInsert.filter(e => e.event_type === "leave")) {
          embeds.push({
            title: "\u274c Member Left",
            description: `**${evt.player_name}** (${evt.player_tag}) left the club.`,
            color: 0xef4444, // red
            timestamp: new Date().toISOString(),
          });
        }

        // Inactive members alert — only send once per day to avoid spam
        const inactiveMembers = memberUpdates.filter(m => !m.is_active);
        if (inactiveMembers.length > 0) {
          // Check when we last sent an inactive alert
          const { data: lastInactiveAlert } = await supabase
            .from("settings")
            .select("value")
            .eq("key", "last_inactive_alert")
            .single();
          
          const lastAlertTime = lastInactiveAlert?.value ? new Date(lastInactiveAlert.value).getTime() : 0;
          const hoursSinceLastAlert = (Date.now() - lastAlertTime) / (1000 * 60 * 60);
          
          // Only send once every 24 hours
          if (hoursSinceLastAlert >= 24) {
            const inactiveList = inactiveMembers
              .slice(0, 15)
              .map(m => `\u2022 **${m.player_name}** (${m.player_tag})`)
              .join("\n");
            const extra = inactiveMembers.length > 15 ? `\n... and ${inactiveMembers.length - 15} more` : "";
            embeds.push({
              title: `\u23f0 ${inactiveMembers.length} Inactive Member(s)`,
              description: `These members have been inactive for ${inactivityThreshold}+ hours:\n${inactiveList}${extra}`,
              color: 0xf59e0b, // amber
              timestamp: new Date().toISOString(),
            });
            
            // Save the timestamp so we don't spam
            await supabase.from("settings").upsert({
              key: "last_inactive_alert",
              value: new Date().toISOString(),
            }, { onConflict: "key" });
          }
        }

        // Send embeds in batches of 10 (Discord limit)
        for (let i = 0; i < embeds.length; i += 10) {
          const batch = embeds.slice(i, i + 10);
          const res = await fetch(discordWebhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: "Brawl Club Manager",
              embeds: batch,
            }),
          });
          if (!res.ok) {
            console.error("Discord webhook error:", res.status, await res.text());
          }
        }

        if (embeds.length > 0) {
          console.log(`Sent ${embeds.length} Discord notification(s)`);
        }
      } catch (webhookError) {
        console.error("Failed to send Discord notification:", webhookError);
      }
    }

    // Save last sync time to database
    const syncTime = new Date().toISOString();
    await Promise.all([
      supabase.from("settings").upsert({
        key: "last_sync_time",
        value: syncTime,
      }, { onConflict: "key" }),
      supabase.from("settings").upsert({
        key: "required_trophies",
        value: String(club.requiredTrophies ?? ""),
      }, { onConflict: "key" }),
    ]);

    // Separate joins and leaves for the response
    const joins = events.filter(e => e.event_type === "join");
    const leaves = events.filter(e => e.event_type === "leave");

    return NextResponse.json({
      success: true,
      synced: memberUpdates.length,
      events: events.length,
      timestamp: syncTime,
      changes: {
        joins: joins.map(e => ({ playerTag: e.player_tag, playerName: e.player_name })),
        leaves: leaves.map(e => ({ playerTag: e.player_tag, playerName: e.player_name })),
      },
    });
  } catch (error) {
    console.error("Sync error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (error instanceof Error && error.stack) {
      console.error("Stack trace:", error.stack);
    }
    return NextResponse.json(
      { error: "Failed to sync data", message: errorMessage },
      { status: 500 }
    );
  }
}
