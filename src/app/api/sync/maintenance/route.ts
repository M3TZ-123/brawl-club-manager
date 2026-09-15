import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { rejectUnauthorizedAdminMutation } from "@/lib/admin-auth";
import { isAuthorizedSchedulerRequest } from "@/lib/scheduler-auth";
export const maxDuration = 60;
export async function POST(request: NextRequest) {
  if (!await isAuthorizedSchedulerRequest(request)) { const denied = rejectUnauthorizedAdminMutation(request); if (denied) return denied; }
  const { data, error } = await supabaseAdmin.rpc("run_sync_maintenance");
  if (error) return NextResponse.json({ error: "Maintenance failed." }, { status: 500 });
  return NextResponse.json({ success: true, counts: data });
}
