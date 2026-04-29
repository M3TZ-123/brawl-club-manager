import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from("settings")
      .select("value")
      .eq("key", "last_sync_time")
      .single();

    if (error && error.code !== "PGRST116") {
      throw error;
    }

    return NextResponse.json(
      {
        lastSyncTime: data?.value || null,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error fetching sync status:", error);
    return NextResponse.json(
      { error: "Failed to fetch sync status" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
