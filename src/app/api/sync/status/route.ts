import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { verifyAdminSession } from "@/lib/admin-auth";
import { normalizeSyncTag, readSyncSettings } from "@/lib/sync-service";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const settings = await readSyncSettings();
    const rawTag = settings.club_tag || process.env.CLUB_TAG;
    const configured = Boolean(rawTag && (settings.api_key || process.env.BRAWL_API_KEY));
    const interval = Number(settings.sync_expected_interval_minutes);
    const expectedIntervalMinutes = Number.isFinite(interval) && interval >= 5 && interval <= 1440 ? interval : 30;
    const staleAfterMinutes = expectedIntervalMinutes * 2 + 5;
    const lastSuccessAt = settings.last_sync_time || null;
    const successTime = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;
    const freshness = !lastSuccessAt ? "never" : !Number.isFinite(successTime) || Date.now() - successTime > staleAfterMinutes * 60000 ? "stale" : "fresh";
    if (!rawTag) return NextResponse.json({ configured, lastSuccessAt, lastAttemptAt: null, lastOutcome: null, running: false, leaseExpiresAt: null, expectedIntervalMinutes, staleAfterMinutes, freshness, latestRun: null });
    const clubTag = normalizeSyncTag(rawTag);
    const admin = verifyAdminSession(request);
    const [runs, lease] = await Promise.all([
      supabaseAdmin.from("sync_runs").select("id,source,scope,started_at,finished_at,status,counts,error_code").eq("club_tag", clubTag).order("started_at", { ascending: false }).limit(admin ? 20 : 1),
      supabaseAdmin.from("sync_leases").select("run_id,expires_at").eq("club_tag", clubTag).maybeSingle(),
    ]);
    if (runs.error || lease.error) throw new Error("Status unavailable");
    const mapped = (runs.data || []).map((run) => ({ id: run.id, source: run.source, scope: run.scope, startedAt: run.started_at, finishedAt: run.finished_at,
      status: run.status === "running" && lease.data?.run_id === run.id && new Date(lease.data?.expires_at || 0).getTime() <= Date.now() ? "superseded" : run.status, counts: run.counts, errorCode: run.error_code }));
    const latestRun = mapped[0] || null;
    let outbox;
    if (admin) {
      const [pending, failed] = await Promise.all([
        supabaseAdmin.from("notification_outbox").select("id", { count: "exact", head: true }).in("status", ["pending", "in_flight"]),
        supabaseAdmin.from("notification_outbox").select("id", { count: "exact", head: true }).eq("status", "failed"),
      ]);
      if (pending.error || failed.error) throw new Error("Outbox status unavailable");
      outbox = { pending: pending.count || 0, failed: failed.count || 0 };
    }
    return NextResponse.json({ configured, lastSuccessAt, lastAttemptAt: latestRun?.startedAt || null, lastOutcome: latestRun?.status || null,
      running: Boolean(lease.data?.run_id && new Date(lease.data.expires_at).getTime() > Date.now()), leaseExpiresAt: lease.data?.run_id ? lease.data.expires_at : null,
      expectedIntervalMinutes, staleAfterMinutes, freshness, latestRun, ...(admin ? { recentRuns: mapped, outbox } : {}) });
  } catch { return NextResponse.json({ error: "Sync health is unavailable." }, { status: 503 }); }
}
