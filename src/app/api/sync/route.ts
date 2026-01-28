import { NextRequest, NextResponse } from "next/server";
import { getClub, getPlayer, setApiKey, getPlayerRankedData, getPlayerWinRate } from "@/lib/brawl-api";
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
    let clubTag = providedClubTag || process.env.CLUB_TAG;
    let apiKey = providedApiKey || process.env.BRAWL_API_KEY;

    // If not provided, try to get from database
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
        for (const setting of settings) {
          if (setting.key === "club_tag" && !clubTag) clubTag = setting.value;
          if (setting.key === "api_key" && !apiKey) apiKey = setting.value;
        }
      }
      console.log("Got clubTag:", clubTag ? "yes" : "no", "apiKey:", apiKey ? "yes" : "no");
    }

    if (!clubTag || !apiKey) {
      return NextResponse.json(
        { error: "Club tag and API key are required. Please configure in Settings." },
        { status: 400 }
      );
    }

    setApiKey(apiKey);

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
            // Run all 3 API calls in parallel for each member
            const [player, rankedData, winRateData] = await Promise.all([
              getPlayer(member.tag),
              getPlayerRankedData(member.tag),
              getPlayerWinRate(member.tag),
            ]);

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

            return {
              member,
              player,
              rankedData,
              winRateData,
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

        const { member, player, rankedData, winRateData, trophyChange, activityType, isActive } = result as {
          member: typeof batch[0];
          player: Awaited<ReturnType<typeof getPlayer>>;
          rankedData: Awaited<ReturnType<typeof getPlayerRankedData>>;
          winRateData: Awaited<ReturnType<typeof getPlayerWinRate>>;
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
