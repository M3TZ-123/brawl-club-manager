import { NextRequest, NextResponse } from "next/server";
import { BrawlApiError, getClub } from "@/lib/brawl-api";
import { rejectUnauthorizedAdminMutation } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function POST(request: NextRequest) {
  try {
    const authResponse = rejectUnauthorizedAdminMutation(request);
    if (authResponse) return authResponse;

    const body = await request.json().catch(() => null);
    const clubTag = typeof body?.clubTag === "string" ? body.clubTag.trim().replace(/^%23/i, "#").toUpperCase() : "";
    const suppliedKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!/^#?[A-Z0-9]{1,20}$/.test(clubTag)) {
      return NextResponse.json({ error: "Enter a valid club tag." }, { status: 400 });
    }
    let apiKey = suppliedKey;
    if (!apiKey) {
      const { data, error } = await supabaseAdmin.from("settings").select("value").eq("key", "api_key").maybeSingle();
      if (error) throw error;
      apiKey = data?.value?.trim() || process.env.BRAWL_API_KEY || "";
    }

    if (!apiKey) {
      return NextResponse.json(
        { error: "Club tag and API key are required" },
        { status: 400 }
      );
    }

    // Try to fetch the club
    const club = await getClub(clubTag, apiKey);

    return NextResponse.json({
      success: true,
      clubTag: club.tag,
      clubName: club.name,
      memberCount: club.members.length,
      requiredTrophies: club.requiredTrophies,
    });
  } catch (error: unknown) {
    console.error("Club verification error:", error);
    
    const upstreamStatus = error instanceof BrawlApiError ? error.status : undefined;
    if (upstreamStatus === 403) {
      return NextResponse.json(
        { error: "Invalid API key. Please check your key and try again." },
        { status: 403 }
      );
    }
    if (upstreamStatus === 404) {
      return NextResponse.json(
        { error: "Club not found. Please check the club tag." },
        { status: 404 }
      );
    }
    if (upstreamStatus === 429) {
      return NextResponse.json(
        { error: "Brawl Stars API rate limit reached. Please try again shortly." },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: "Failed to verify club. Please try again." },
      { status: 500 }
    );
  }
}
