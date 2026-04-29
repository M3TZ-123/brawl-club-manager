import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { ClubEvent, Member } from "@/types/database";

interface DashboardSummary {
  totalMembers: number;
  totalTrophies: number;
  activeMembers: number;
  avgTrophies: number;
}

export async function GET() {
  try {
    const [currentMembersRes, eventsRes] = await Promise.all([
      supabaseAdmin
        .from("member_history")
        .select("player_tag")
        .eq("is_current_member", true),
      supabaseAdmin
        .from("club_events")
        .select("*")
        .order("event_time", { ascending: false })
        .limit(5),
    ]);

    if (currentMembersRes.error) throw currentMembersRes.error;
    if (eventsRes.error) throw eventsRes.error;

    const currentTags = new Set(
      (currentMembersRes.data || []).map((row) => row.player_tag)
    );
    const currentTagList = [...currentTags];

    const { data: memberRows, error: membersError } = await supabaseAdmin
      .from("members")
      .select("player_tag, player_name, icon_id, role, trophies, highest_trophies, exp_level, rank_current, rank_highest, win_rate, brawlers_count, solo_victories, duo_victories, trio_victories, is_active, last_updated")
      .in("player_tag", currentTagList.length > 0 ? currentTagList : [""])
      .order("trophies", { ascending: false });

    if (membersError) throw membersError;

    const members = ((memberRows || []) as Member[]).sort((a, b) => b.trophies - a.trophies);

    const totalTrophies = members.reduce((sum, member) => sum + (member.trophies || 0), 0);
    const activeMembers = members.filter((member) => member.is_active).length;

    const summary: DashboardSummary = {
      totalMembers: members.length,
      totalTrophies,
      activeMembers,
      avgTrophies: members.length > 0 ? Math.round(totalTrophies / members.length) : 0,
    };

    return NextResponse.json({
      summary,
      topMembers: members.slice(0, 10),
      recentEvents: (eventsRes.data || []) as ClubEvent[],
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching dashboard:", error);
    return NextResponse.json(
      { error: "Failed to fetch dashboard" },
      { status: 500 }
    );
  }
}
