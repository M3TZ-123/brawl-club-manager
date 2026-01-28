import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// GET - Retrieve all settings
export async function GET() {
  try {
    const { data, error } = await supabase
      .from("settings")
      .select("key, value");

    if (error) {
      throw error;
    }

    // Convert array to object
    const settings: Record<string, string> = {};
    for (const row of data || []) {
      settings[row.key] = row.value;
    }

    return NextResponse.json(settings);
  } catch (error) {
    console.error("Error fetching settings:", error);
    return NextResponse.json(
      { error: "Failed to fetch settings" },
      { status: 500 }
    );
  }
}

// POST - Save settings
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Upsert each setting
    const upserts = Object.entries(body).map(([key, value]) => ({
      key,
      value: String(value),
    }));

    if (upserts.length > 0) {
      const { error } = await supabase
        .from("settings")
        .upsert(upserts, { onConflict: "key" });

      if (error) {
        throw error;
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error saving settings:", error);
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
