import { NextResponse } from "next/server";
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
