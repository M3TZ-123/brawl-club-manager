import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { appendMemberActivityMetrics } from "@/lib/member-activity-metrics";

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
      .select("*")
      .in("player_tag", currentMemberTags.length > 0 ? currentMemberTags : [""])
      .order("trophies", { ascending: false });

    if (error) throw error;

    const membersWithGains = await appendMemberActivityMetrics(members || []);

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
