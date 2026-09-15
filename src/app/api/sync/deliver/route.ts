import { NextRequest, NextResponse } from "next/server";
import { rejectUnauthorizedAdminMutation } from "@/lib/admin-auth";
import { isAuthorizedSchedulerRequest } from "@/lib/scheduler-auth";
import { deliverSyncOutbox } from "@/lib/sync-outbox";
import { SyncError } from "@/lib/sync-service";
export const maxDuration = 60;
export async function POST(request: NextRequest) {
  try {
    if (!await isAuthorizedSchedulerRequest(request)) { const denied = rejectUnauthorizedAdminMutation(request); if (denied) return denied; }
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await deliverSyncOutbox(body.suppressDelivery === true));
  } catch (error) { return NextResponse.json({ error: error instanceof SyncError ? error.message : "Notification delivery failed." }, { status: error instanceof SyncError ? error.status : 500 }); }
}
