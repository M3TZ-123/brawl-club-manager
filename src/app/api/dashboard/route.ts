import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { ClubEvent, Member } from "@/types/database";

interface DashboardSummary {
  totalMembers: number;
  totalTrophies: number;
  activeMembers: number;
  avgTrophies: number;
}

export async function GET() {
  try {
    const [currentMembersRes, membersRes, eventsRes] = await Promise.all([
      supabase
        .from("member_history")
        .select("player_tag")
        .eq("is_current_member", true),
      supabase
        .from("members")
        .select("*")
        .order("trophies", { ascending: false }),
      supabase
        .from("club_events")
        .select("*")
        .order("event_time", { ascending: false })
        .limit(5),
    ]);

    if (currentMembersRes.error) throw currentMembersRes.error;
    if (membersRes.error) throw membersRes.error;
    if (eventsRes.error) throw eventsRes.error;

    const currentTags = new Set(
      (currentMembersRes.data || []).map((row) => row.player_tag)
    );

    const members = ((membersRes.data || []) as Member[])
      .filter((member) => currentTags.has(member.player_tag))
      .sort((a, b) => b.trophies - a.trophies);

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
