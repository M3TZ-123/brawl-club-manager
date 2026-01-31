import { NextRequest, NextResponse } from "next/server";
import { getClub, getPlayer, setApiKey, getPlayerRankedData, getPlayerBattleLog, processBattleLog, calculateWinRateFromBattleLog, BrawlStarsBrawler } from "@/lib/brawl-api";
import { supabase } from "@/lib/supabase";

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
    if (!clubTag || !apiKey) {
      console.log("Fetching credentials from database...");
      const { data: settings, error: settingsError } = await supabase
        .from("settings")
        .select("key, value")
        .in("key", ["club_tag", "api_key"]);
      
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
    console.log("API key length:", apiKey.length, "starts with:", apiKey.substring(0, 10) + "...");
    
    setApiKey(apiKey);
    console.log("API key set, fetching club data...");

    // Get inactivity threshold from settings (default 48 hours)
    let inactivityThreshold = 48;
    const { data: thresholdSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "inactivity_threshold")
      .single();
    if (thresholdSetting?.value) {
      inactivityThreshold = parseInt(thresholdSetting.value);
    }

    // Fetch club data
    const club = await getClub(clubTag);
    const currentMemberTags = new Set(club.members.map((m) => m.tag));

    // Get existing members from database
    const { data: existingMembers } = await supabase
      .from("members")
      .select("player_tag, trophies");

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

    // Process members in parallel batches of 3 to avoid rate limits
    // Brawl Stars API: ~10 req/sec, RNT API: unknown
    // 3 members × 3 calls = 9 simultaneous requests (safe margin)
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 500; // Delay between batches
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
            const [player, rankedData, battleLog] = await Promise.all([
              getPlayer(member.tag),
              getPlayerRankedData(member.tag),
              getPlayerBattleLog(member.tag),
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
        memberUpdates.push({
          player_tag: member.tag,
          player_name: member.name,
          role: member.role,
          trophies: player.trophies,
          highest_trophies: player.highestTrophies,
          exp_level: player.expLevel,
          rank_current: rankedData.currentRank,
          rank_highest: rankedData.highestRank,
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
        historyUpdates.push({
          player_tag: history.player_tag,
          player_name: history.player_name,
          last_seen: new Date().toISOString(),
          times_left: history.times_left + 1,
          is_current_member: false,
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

    // Upsert members
    if (memberUpdates.length > 0) {
      await supabase.from("members").upsert(memberUpdates, {
        onConflict: "player_tag",
      });
    }

    // Insert activity logs
    if (activityLogs.length > 0) {
      await supabase.from("activity_log").insert(activityLogs);
    }

    // Store battle history (upsert to avoid duplicates)
    if (allBattles.length > 0) {
      // Insert battles, ignore duplicates
      const { error: battleError } = await supabase
        .from("battle_history")
        .upsert(allBattles, {
          onConflict: "player_tag,battle_time",
          ignoreDuplicates: true,
        });
      
      if (battleError) {
        console.error("Error storing battle history:", battleError);
      }

      // Update daily stats from battles
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

      // Upsert daily stats
      const dailyStatsArray = Array.from(dailyStatsMap.values());
      if (dailyStatsArray.length > 0) {
        const { error: dailyStatsError } = await supabase
          .from("daily_stats")
          .upsert(dailyStatsArray, {
            onConflict: "player_tag,date",
          });
        
        if (dailyStatsError) {
          console.error("Error storing daily stats:", dailyStatsError);
        }
      }
    }

    // Store brawler snapshots (for tracking power ups/unlocks)
    if (brawlerSnapshots.length > 0) {
      // Get previous snapshots to detect changes
      const playerTags = [...new Set(brawlerSnapshots.map(s => s.player_tag))];
      
      for (const playerTag of playerTags) {
        const playerBrawlers = brawlerSnapshots.filter(s => s.player_tag === playerTag);
        
        // Get yesterday's snapshot for comparison
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);
        
        const { data: prevSnapshots } = await supabase
          .from("brawler_snapshots")
          .select("brawler_id, power_level")
          .eq("player_tag", playerTag)
          .gte("recorded_at", yesterdayStr);
        
        const prevMap = new Map(prevSnapshots?.map(s => [s.brawler_id, s.power_level]) || []);
        
        // Calculate power ups and unlocks
        let powerUps = 0;
        let unlocks = 0;
        
        for (const brawler of playerBrawlers) {
          const prevPower = prevMap.get(brawler.brawler_id);
          if (prevPower === undefined) {
            // New brawler unlocked
            if (prevSnapshots && prevSnapshots.length > 0) {
              unlocks++;
            }
          } else if (brawler.power_level > prevPower) {
            // Power level increased
            powerUps += brawler.power_level - prevPower;
          }
        }
        
        // Update player tracking
        if (powerUps > 0 || unlocks > 0) {
          await supabase
            .from("player_tracking")
            .upsert({
              player_tag: playerTag,
              power_ups: powerUps,
              unlocks: unlocks,
              last_updated: new Date().toISOString(),
            }, {
              onConflict: "player_tag",
            });
        }
      }
      
      // Store today's brawler snapshot
      const { error: snapshotError } = await supabase
        .from("brawler_snapshots")
        .upsert(brawlerSnapshots, {
          onConflict: "player_tag,brawler_id,recorded_at",
          ignoreDuplicates: true,
        });
      
      if (snapshotError) {
        console.error("Error storing brawler snapshots:", snapshotError);
      }
    }

    // Upsert member history
    if (historyUpdates.length > 0) {
      await supabase.from("member_history").upsert(historyUpdates, {
        onConflict: "player_tag",
      });
    }

    // Insert events
    if (events.length > 0) {
      await supabase.from("club_events").insert(events);
    }

    // Save last sync time to database
    const syncTime = new Date().toISOString();
    await supabase.from("settings").upsert({
      key: "last_sync_time",
      value: syncTime,
    }, { onConflict: "key" });

    return NextResponse.json({
      success: true,
      synced: memberUpdates.length,
      events: events.length,
      timestamp: syncTime,
    });
  } catch (error) {
    console.error("Sync error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const errorStack = error instanceof Error ? error.stack : undefined;
    return NextResponse.json(
      { error: "Failed to sync data", message: errorMessage, stack: errorStack },
      { status: 500 }
    );
  }
}
