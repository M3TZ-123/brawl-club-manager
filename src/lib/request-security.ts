import { NextResponse } from "next/server";

function normalizeOrigin(value: string | null | undefined) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function rejectCrossOriginRequest(request: Request) {
  const origin = normalizeOrigin(request.headers.get("origin"));
  if (!origin) return null;

  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!host) {
    return NextResponse.json({ error: "Missing request host" }, { status: 400 });
  }

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const protocol = forwardedProto || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const allowedOrigins = new Set<string>([`${protocol}://${host}`]);

  const appUrl = normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (appUrl) allowedOrigins.add(appUrl);

  if (process.env.VERCEL_URL) {
    allowedOrigins.add(`https://${process.env.VERCEL_URL}`);
  }

  if (allowedOrigins.has(origin)) {
    return null;
  }

  return NextResponse.json({ error: "Cross-origin mutation blocked" }, { status: 403 });
}
