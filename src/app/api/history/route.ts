import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    const { data: history, error } = await supabase
      .from("member_history")
      .select("*")
      .order("last_seen", { ascending: false });

    if (error) throw error;

    return NextResponse.json({ history: history || [] });
  } catch (error) {
    console.error("Error fetching history:", error);
    return NextResponse.json(
      { error: "Failed to fetch member history" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { player_tag, notes } = body;

    if (!player_tag) {
      return NextResponse.json(
        { error: "player_tag is required" },
        { status: 400 }
      );
    }

    const { error } = await supabase
      .from("member_history")
      .update({ notes: notes || null })
      .eq("player_tag", player_tag);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating notes:", error);
    return NextResponse.json(
      { error: "Failed to update notes" },
      { status: 500 }
    );
  }
}
