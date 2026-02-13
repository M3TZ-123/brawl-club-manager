import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100"), 500);
    const offset = parseInt(searchParams.get("offset") || "0");
    const mode = searchParams.get("mode") || null;
    const result = searchParams.get("result") || null;

    // Get current member tags for name lookup
    const { data: members } = await supabase
      .from("members")
      .select("player_tag, player_name");

    const nameMap = new Map((members || []).map((m) => [m.player_tag, m.player_name]));

    // Build query
    let query = supabase
      .from("battle_history")
      .select("*", { count: "exact" })
      .order("battle_time", { ascending: false })
      .range(offset, offset + limit - 1);

    if (mode) {
      query = query.eq("mode", mode);
    }
    if (result) {
      query = query.eq("result", result);
    }

    const { data: battles, error, count } = await query;

    if (error) throw error;

    // Enrich with player names
    const enriched = (battles || []).map((b) => ({
      ...b,
      player_name: nameMap.get(b.player_tag) || b.player_tag,
    }));

    // Get distinct modes for filter dropdown
    const { data: modes } = await supabase
      .from("battle_history")
      .select("mode")
      .not("mode", "is", null);

    const uniqueModes = [...new Set((modes || []).map((m) => m.mode))].filter(Boolean).sort();

    return NextResponse.json({
      battles: enriched,
      total: count || 0,
      modes: uniqueModes,
    });
  } catch (error) {
    console.error("Error fetching battle feed:", error);
    return NextResponse.json({ error: "Failed to fetch battle feed" }, { status: 500 });
  }
}
