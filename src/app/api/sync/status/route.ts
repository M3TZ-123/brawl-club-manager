import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { verifyAdminSession } from "@/lib/admin-auth";
import { normalizeSyncTag, readSyncSettings } from "@/lib/sync-service";
import { summarizeBattleCoverage } from "@/lib/battle-coverage";
import { readCapacityHealth } from "@/lib/capacity-health";
export const dynamic = "force-dynamic";

const warningCodes = new Set(["battle_logs_incomplete", "ranked_unavailable", "ranked_rate_limited", "battle_logs_rate_limited", "battle_history_gap"]);
const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "Vary": "Cookie" } });
function interval(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 1440 ? parsed : fallback;
}
function marker(value: string | undefined, expectedInterval: number, now: number) {
  const parsed = value ? Date.parse(value) : NaN;
  const valid = Number.isFinite(parsed) && parsed <= now + 60_000;
  const staleAfterMinutes = expectedInterval * 2 + Math.min(5, Math.max(1, expectedInterval / 2));
  const freshness = !value ? "never" : !valid || now - parsed > staleAfterMinutes * 60_000 ? "stale" : "fresh";
  return { lastSuccessAt: valid ? new Date(parsed).toISOString() : null, freshness, staleAfterMinutes };
}
function publicWarnings(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const warnings = (result as Record<string, unknown>).warnings;
  return Array.isArray(warnings) ? [...new Set(warnings.filter((code): code is string => typeof code === "string" && warningCodes.has(code)))] : [];
}
function publicCounts(counts: unknown) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return {};
  return Object.fromEntries(Object.entries(counts).filter(([key, value]) => ["members", "battles", "events"].includes(key) && typeof value === "number" && Number.isFinite(value) && value >= 0));
}
async function readBattleCoverage(clubTag: string, now: number) {
  const members = await supabaseAdmin.from("member_history").select("player_tag").eq("is_current_member", true);
  if (members.error) return summarizeBattleCoverage([], null, now);
  const tags = [...new Set((members.data || []).map(row => row.player_tag).filter((tag): tag is string => typeof tag === "string"))];
  if (!tags.length) return summarizeBattleCoverage(tags, [], now);
  const coverage = await supabaseAdmin.rpc("sync_battle_coverage_summary", { p_club_tag: clubTag, p_player_tags: tags, p_now: new Date(now).toISOString() });
  return summarizeBattleCoverage(tags, coverage.error ? null : coverage.data, now);
}
export async function GET(request: NextRequest) {
  try {
    const settings = await readSyncSettings();
    const rawTag = settings.club_tag || process.env.CLUB_TAG;
    const configured = Boolean(rawTag && (settings.api_key || process.env.BRAWL_API_KEY));
    const now = Date.now();
    const admin = verifyAdminSession(request);
    const capacity = admin ? await readCapacityHealth(now) : undefined;
    const expectedIntervalMinutes = interval(settings.sync_expected_interval_minutes, 10);
    const rosterIntervalMinutes = interval(settings.sync_roster_interval_minutes, 2);
    const rankedIntervalMinutes = interval(settings.sync_ranked_interval_minutes, 30);
    const full = marker(settings.last_full_sync_time ?? settings.last_sync_time, expectedIntervalMinutes, now);
    const roster = marker(settings.last_roster_sync_time, rosterIntervalMinutes, now);
    const battle = marker(settings.last_battle_sync_time, expectedIntervalMinutes, now);
    const ranked = marker(settings.last_ranked_sync_time, rankedIntervalMinutes, now);
    const freshness = {
      configured, lastSuccessAt: full.lastSuccessAt, lastFullSuccessAt: full.lastSuccessAt,
      lastRosterSuccessAt: roster.lastSuccessAt, lastBattleSuccessAt: battle.lastSuccessAt, lastRankedSuccessAt: ranked.lastSuccessAt,
      freshness: full.freshness, fullFreshness: full.freshness, rosterFreshness: roster.freshness, battleFreshness: battle.freshness, rankedFreshness: ranked.freshness,
      expectedIntervalMinutes, rosterIntervalMinutes, rankedIntervalMinutes,
      staleAfterMinutes: full.staleAfterMinutes, rosterStaleAfterMinutes: roster.staleAfterMinutes, battleStaleAfterMinutes: battle.staleAfterMinutes, rankedStaleAfterMinutes: ranked.staleAfterMinutes,
    };
    if (!rawTag) return response({ ...freshness, battleCoverage: summarizeBattleCoverage([], null, now),
      lastAttemptAt: null, lastOutcome: null, running: false, leaseExpiresAt: null, latestRun: null, latestFullRun: null,
      ...(admin ? { capacity } : {}) });
    const clubTag = normalizeSyncTag(rawTag);
    const runFields = "id,source,scope,started_at,finished_at,status,counts,error_code,result";
    const [runs, lease, fullRuns, battleCoverage] = await Promise.all([
      supabaseAdmin.from("sync_runs").select(runFields).eq("club_tag", clubTag).order("started_at", { ascending: false }).limit(admin ? 20 : 1),
      supabaseAdmin.from("sync_leases").select("run_id,expires_at").eq("club_tag", clubTag).maybeSingle(),
      // Frequent roster checks and an in-flight retry must not hide the last
      // completed full attempt's partial result or failure.
      supabaseAdmin.from("sync_runs").select(runFields).eq("club_tag", clubTag).eq("scope", "full").in("status", ["succeeded", "failed", "superseded"]).order("started_at", { ascending: false }).limit(1),
      readBattleCoverage(clubTag, now).catch(() => summarizeBattleCoverage([], null, now)),
    ]);
    if (runs.error || lease.error || fullRuns.error) throw new Error("Status unavailable");
    const mapRun = (run: NonNullable<typeof runs.data>[number]) => ({ id: run.id, source: run.source, scope: run.scope, startedAt: run.started_at, finishedAt: run.finished_at,
      status: run.status === "running" && lease.data?.run_id === run.id && new Date(lease.data?.expires_at || 0).getTime() <= now ? "superseded" : run.status,
      counts: publicCounts(run.counts), errorCode: run.error_code, warnings: publicWarnings(run.result) });
    const mapped = (runs.data || []).map(mapRun);
    const latestRun = mapped[0] || null;
    const latestFullRun = fullRuns.data?.[0] ? mapRun(fullRuns.data[0]) : null;
    let outbox;
    if (admin) {
      const [pending, failed] = await Promise.all([
        supabaseAdmin.from("notification_outbox").select("id", { count: "exact", head: true }).in("status", ["pending", "in_flight"]),
        supabaseAdmin.from("notification_outbox").select("id", { count: "exact", head: true }).eq("status", "failed"),
      ]);
      if (pending.error || failed.error) throw new Error("Outbox status unavailable");
      outbox = { pending: pending.count || 0, failed: failed.count || 0 };
    }
    return response({ ...freshness, battleCoverage, lastAttemptAt: latestRun?.startedAt || null, lastOutcome: latestRun?.status || null,
      running: Boolean(lease.data?.run_id && new Date(lease.data.expires_at).getTime() > now), leaseExpiresAt: lease.data?.run_id ? lease.data.expires_at : null,
      latestRun, latestFullRun, ...(admin ? { recentRuns: mapped, outbox, capacity } : {}) });
  } catch { return response({ error: "Sync health is unavailable." }, 503); }
}
