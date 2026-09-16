import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { rejectUnauthorizedAdminMutation } from "@/lib/admin-auth";

export async function GET() {
  try {
    const { data: events, error } = await supabaseAdmin
      .from("club_events")
      .select("id, event_type, player_tag, player_name, event_time")
      .order("event_time", { ascending: false })
      .limit(50);

    if (error) throw error;

    return NextResponse.json({ events: (events || []).map(({ id, event_type, player_tag, player_name, event_time }) => ({
      id, event_type, player_tag, player_name, event_time,
    })) });
  } catch (error) {
    console.error("Error fetching events:", error);
    return NextResponse.json(
      { error: "Failed to fetch events" },
      { status: 500 }
    );
  }
}

// Historical membership evidence cannot be reset through the application.
export async function DELETE(request: NextRequest) {
  const denied = rejectUnauthorizedAdminMutation(request);
  if (denied) return denied;
  return NextResponse.json({ error: "Historical membership records cannot be reset." },
    { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } });
}