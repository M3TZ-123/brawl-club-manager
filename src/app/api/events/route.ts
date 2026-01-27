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
