import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const daysParam = searchParams.get("days");
    const days = daysParam && daysParam !== "all" ? Number(daysParam) : null;
    const cutoffDate = days && Number.isFinite(days)
      ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      : null;

    const { data: history, error } = await supabase
      .from("member_history")
      .select("*")
      .order("last_seen", { ascending: false });

    if (error) throw error;

    let filteredHistory = history || [];

    if (cutoffDate) {
      filteredHistory = filteredHistory.filter((record) => {
        const joinedAt = parseDate(record.first_seen);
        const leftAt = parseDate(record.last_left_at)
          || (!record.is_current_member ? parseDate(record.last_seen) : null);

        const joinedInRange = !!joinedAt && joinedAt >= cutoffDate;
        const leftInRange = !!leftAt && leftAt >= cutoffDate;

        return joinedInRange || leftInRange;
      });
    }

    return NextResponse.json({ history: filteredHistory });
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
