import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { appendMemberActivityMetrics } from "@/lib/member-activity-metrics";
import { PUBLIC_MEMBER_COLUMNS, publicMemberSnapshot } from "@/lib/sync-public-snapshots";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const { data: currentMemberHistory, error: currentMemberError } = await supabaseAdmin
      .from("member_history")
      .select("player_tag")
      .eq("is_current_member", true);

    if (currentMemberError) throw currentMemberError;

    const currentMemberTags = currentMemberHistory?.map((h) => h.player_tag) || [];
    const { data: members, error } = await supabaseAdmin
      .from("members")
      .select(PUBLIC_MEMBER_COLUMNS)
      .in("player_tag", currentMemberTags.length > 0 ? currentMemberTags : [""])
      .order("trophies", { ascending: false });

    if (error) throw error;

    const publicMembers = (members || []).map(member => ({
      ...publicMemberSnapshot(member), player_tag: member.player_tag, trophies: member.trophies,
    }));
    const membersWithGains = await appendMemberActivityMetrics(publicMembers);

    return NextResponse.json(
      { members: membersWithGains },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error fetching members:", error);
    return NextResponse.json(
      { error: "Failed to fetch members" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
