import { NextRequest, NextResponse } from "next/server";
import { getClub, getPlayer, setApiKey, getPlayerRankedData, getPlayerWinRate } from "@/lib/brawl-api";
import { supabase } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  try {
    // Get settings from request or environment
    const body = await request.json().catch(() => ({}));
    const clubTag = body.clubTag || process.env.CLUB_TAG;
    const apiKey = body.apiKey || process.env.BRAWL_API_KEY;
    const isInitialSetup = body.initialSetup === true; // Flag for first-time setup

    if (!clubTag || !apiKey) {
      return NextResponse.json(
        { error: "Club tag and API key are required" },
        { status: 400 }
      );
    }

    setApiKey(apiKey);

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

            // Determine activity type
            let activityType = "inactive";
            if (Math.abs(trophyChange) >= 20) {
              activityType = "active";
            } else if (Math.abs(trophyChange) > 0) {
              activityType = "minimal";
            }

            return {
              member,
              player,
              rankedData,
              winRateData,
              trophyChange,
              activityType,
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

        const { member, player, rankedData, winRateData, trophyChange, activityType } = result as {
          member: typeof batch[0];
          player: Awaited<ReturnType<typeof getPlayer>>;
          rankedData: Awaited<ReturnType<typeof getPlayerRankedData>>;
          winRateData: Awaited<ReturnType<typeof getPlayerWinRate>>;
          trophyChange: number;
          activityType: string;
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
          is_active: activityType === "active",
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

    return NextResponse.json({
      success: true,
      synced: memberUpdates.length,
      events: events.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Sync error:", error);
    return NextResponse.json(
      { error: "Failed to sync data" },
      { status: 500 }
    );
  }
}
