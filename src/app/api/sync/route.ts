import { NextRequest, NextResponse } from "next/server";
import { rejectUnauthorizedAdminMutation } from "@/lib/admin-auth";
import { isAuthorizedSchedulerRequest } from "@/lib/scheduler-auth";
import { executeSync, SyncError } from "@/lib/sync-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

function failed(error: unknown) {
  return NextResponse.json({ error: error instanceof SyncError ? error.message : "Sync failed.", code: error instanceof SyncError ? error.code : "sync_failed" },
    { status: error instanceof SyncError ? error.status : 500,
      ...(error instanceof SyncError && error.retryAfterSeconds ? { headers: { "Retry-After": String(error.retryAfterSeconds) } } : {}) });
}
export async function GET(request: NextRequest) {
  try {
    // GET is retained for authenticated schedulers only. Admin cookies are
    // sent on cross-site top-level navigations, so manual sync must use POST.
    if (!await isAuthorizedSchedulerRequest(request)) return NextResponse.json({ error: "Scheduler authorization required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    const adaptive = request.nextUrl.searchParams.get("mode") === "auto";
    return NextResponse.json(await executeSync({ source: "cron", scope: adaptive ? "auto" : "full", idempotencyKey: request.headers.get("idempotency-key") }));
  } catch (error) { return failed(error); }
}
export async function POST(request: NextRequest) {
  try {
    const denied = rejectUnauthorizedAdminMutation(request); if (denied) return denied;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid sync request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json(await executeSync({ source: "manual", clubTag: body.clubTag, initialSetup: body.initialSetup === true,
      idempotencyKey: request.headers.get("idempotency-key") }));
  } catch (error) { return failed(error); }
}
