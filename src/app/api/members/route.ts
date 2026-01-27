import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    const { data: members, error } = await supabase
      .from("members")
      .select("*")
      .order("trophies", { ascending: false });

    if (error) throw error;

    return NextResponse.json({ members: members || [] });
  } catch (error) {
    console.error("Error fetching members:", error);
    return NextResponse.json(
      { error: "Failed to fetch members" },
      { status: 500 }
    );
  }
}
