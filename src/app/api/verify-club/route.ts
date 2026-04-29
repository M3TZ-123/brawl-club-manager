import { NextRequest, NextResponse } from "next/server";
import { getClub } from "@/lib/brawl-api";
import { rejectUnauthorizedAdminMutation } from "@/lib/admin-auth";

export async function POST(request: NextRequest) {
  try {
    const authResponse = rejectUnauthorizedAdminMutation(request);
    if (authResponse) return authResponse;

    const { clubTag, apiKey } = await request.json();

    if (!clubTag || !apiKey) {
      return NextResponse.json(
        { error: "Club tag and API key are required" },
        { status: 400 }
      );
    }

    // Try to fetch the club
    const club = await getClub(clubTag, apiKey);

    return NextResponse.json({
      success: true,
      clubName: club.name,
      memberCount: club.members.length,
      requiredTrophies: club.requiredTrophies,
    });
  } catch (error: unknown) {
    console.error("Club verification error:", error);
    
    const axiosError = error as { response?: { status: number } };
    if (axiosError.response?.status === 403) {
      return NextResponse.json(
        { error: "Invalid API key. Please check your key and try again." },
        { status: 403 }
      );
    }
    if (axiosError.response?.status === 404) {
      return NextResponse.json(
        { error: "Club not found. Please check the club tag." },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: "Failed to verify club. Please try again." },
      { status: 500 }
    );
  }
}
