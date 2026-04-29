import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function normalizeTimestamp(value: string | null | undefined) {
  const timestamp = value?.trim();
  if (!timestamp) return null;

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString();
}

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
        lastSyncTime: normalizeTimestamp(data?.value),
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
