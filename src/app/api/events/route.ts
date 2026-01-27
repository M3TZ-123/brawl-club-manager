import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    const { data: events, error } = await supabase
      .from("club_events")
      .select("*")
      .order("event_time", { ascending: false })
      .limit(50);

    if (error) throw error;

    return NextResponse.json({ events: events || [] });
  } catch (error) {
    console.error("Error fetching events:", error);
    return NextResponse.json(
      { error: "Failed to fetch events" },
      { status: 500 }
    );
  }
}

// DELETE endpoint to clear all events and reset tracking from today
export async function DELETE() {
  try {
    // Clear all club events
    const { error: eventsError } = await supabase
      .from("club_events")
      .delete()
      .neq("id", 0); // Delete all rows

    if (eventsError) throw eventsError;

    // Reset member history - mark all current members as baseline
    // This means joins/leaves will only be tracked from this point forward
    const { error: historyError } = await supabase
      .from("member_history")
      .update({
        first_seen: new Date().toISOString(),
        times_joined: 1,
        times_left: 0,
      })
      .eq("is_current_member", true);

    if (historyError) throw historyError;

    return NextResponse.json({ 
      success: true, 
      message: "Events cleared. Join/leave tracking will start fresh from now.",
      resetTime: new Date().toISOString()
    });
  } catch (error) {
    console.error("Error clearing events:", error);
    return NextResponse.json(
      { error: "Failed to clear events" },
      { status: 500 }
    );
  }
}