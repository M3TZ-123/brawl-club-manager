import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { rejectCrossOriginRequest } from "@/lib/request-security";

const ADMIN_COOKIE_NAME = "brawlstatz_admin";
const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;

type AdminSessionPayload = {
  iat: number;
  exp: number;
  nonce: string;
};

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function getSigningSecret() {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
}

export function isAdminAuthConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD && getSigningSecret());
}

function signPayload(payload: string) {
  return base64UrlEncode(
    createHmac("sha256", getSigningSecret()).update(payload).digest()
  );
}

function safeEqual(left: string, right: string) {
  const leftHash = createHmac("sha256", getSigningSecret()).update(left).digest();
  const rightHash = createHmac("sha256", getSigningSecret()).update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function getCookieValue(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return null;
}

export function verifyAdminPassword(password: unknown) {
  if (!isAdminAuthConfigured() || typeof password !== "string") return false;
  return safeEqual(password, process.env.ADMIN_PASSWORD || "");
}

export function createAdminSessionToken() {
  if (!isAdminAuthConfigured()) {
    throw new Error("Admin auth is not configured");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload: AdminSessionPayload = {
    iat: now,
    exp: now + ADMIN_SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString("hex"),
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

export function verifyAdminSession(request: Request) {
  if (!isAdminAuthConfigured()) return false;

  const token = getCookieValue(request, ADMIN_COOKIE_NAME);
  if (!token) return false;

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return false;

  const expectedSignature = signPayload(encodedPayload);
  if (!safeEqual(signature, expectedSignature)) return false;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<AdminSessionPayload>;
    const now = Math.floor(Date.now() / 1000);
    return typeof payload.exp === "number" && payload.exp > now;
  } catch {
    return false;
  }
}

export function setAdminSessionCookie(response: NextResponse) {
  response.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: createAdminSessionToken(),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_SESSION_TTL_SECONDS,
  });
}

export function clearAdminSessionCookie(response: NextResponse) {
  response.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export function rejectUnauthorizedAdminRequest(request: Request) {
  if (!isAdminAuthConfigured()) {
    return NextResponse.json(
      { error: "Admin auth is not configured" },
      { status: 503 }
    );
  }

  if (!verifyAdminSession(request)) {
    return NextResponse.json(
      { error: "Admin login required" },
      { status: 401 }
    );
  }

  return null;
}

export function rejectUnauthorizedAdminMutation(request: Request) {
  const crossOriginResponse = rejectCrossOriginRequest(request);
  if (crossOriginResponse) return crossOriginResponse;

  return rejectUnauthorizedAdminRequest(request);
}

export function getAdminSessionStatus(request: Request) {
  return {
    configured: isAdminAuthConfigured(),
    isAdmin: verifyAdminSession(request),
  };
}
