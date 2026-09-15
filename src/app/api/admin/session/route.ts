import { NextRequest, NextResponse } from "next/server";
import {
  clearAdminSessionCookie,
  getAdminSessionStatus,
  isAdminAuthConfigured,
  setAdminSessionCookie,
  verifyAdminPassword,
} from "@/lib/admin-auth";
import { rejectCrossOriginRequest } from "@/lib/request-security";
import { consumeAdminLoginAttempt } from "@/lib/admin-rate-limit";

export async function GET(request: NextRequest) {
  const status = getAdminSessionStatus(request);
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store", Vary: "Cookie" },
  });
}

export async function POST(request: NextRequest) {
  const crossOriginResponse = rejectCrossOriginRequest(request);
  if (crossOriginResponse) return crossOriginResponse;

  if (!isAdminAuthConfigured()) {
    return NextResponse.json(
      { error: "Admin auth is not configured" },
      { status: 503 }
    );
  }

  try {
    const limit = await consumeAdminLoginAttempt(request);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many login attempts. Try again later." },
        { status: 429, headers: { "Retry-After": String(Math.max(1, limit.retryAfter)), "Cache-Control": "no-store" } }
      );
    }
  } catch {
    console.error("Admin login rate-limit storage is unavailable");
    return NextResponse.json(
      { error: "Admin login is temporarily unavailable. Please try again later." },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } }
    );
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || !verifyAdminPassword(body.password)) {
    return NextResponse.json(
      { error: "Invalid admin password" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const response = NextResponse.json({ success: true, isAdmin: true }, { headers: { "Cache-Control": "no-store" } });
  setAdminSessionCookie(response);
  return response;
}

export async function DELETE(request: NextRequest) {
  const crossOriginResponse = rejectCrossOriginRequest(request);
  if (crossOriginResponse) return crossOriginResponse;

  const response = NextResponse.json({ success: true, isAdmin: false });
  clearAdminSessionCookie(response);
  return response;
}
