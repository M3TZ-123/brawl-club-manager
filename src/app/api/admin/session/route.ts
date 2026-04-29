import { NextRequest, NextResponse } from "next/server";
import {
  clearAdminSessionCookie,
  getAdminSessionStatus,
  isAdminAuthConfigured,
  setAdminSessionCookie,
  verifyAdminPassword,
} from "@/lib/admin-auth";
import { rejectCrossOriginRequest } from "@/lib/request-security";

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;

function getClientKey(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function isRateLimited(request: NextRequest) {
  const key = getClientKey(request);
  const now = Date.now();
  const current = loginAttempts.get(key);

  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }

  current.count += 1;
  return current.count > MAX_LOGIN_ATTEMPTS;
}

function clearRateLimit(request: NextRequest) {
  loginAttempts.delete(getClientKey(request));
}

export async function GET(request: NextRequest) {
  const status = getAdminSessionStatus(request);
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store" },
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

  if (isRateLimited(request)) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429 }
    );
  }

  const body = await request.json().catch(() => ({}));
  if (!verifyAdminPassword(body.password)) {
    return NextResponse.json(
      { error: "Invalid admin password" },
      { status: 401 }
    );
  }

  clearRateLimit(request);
  const response = NextResponse.json({ success: true, isAdmin: true });
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
