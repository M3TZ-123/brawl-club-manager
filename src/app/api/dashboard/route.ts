import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { Member } from "@/types/database";
import {
  appendMemberActivityMetrics,
  MemberActivityMetrics,
} from "@/lib/member-activity-metrics";
import { parseTimeRange, TIME_RANGES, type TrophyPeriodMetric } from "@/lib/time-range";
import { getReportingPeriod, reportingPeriodMetadata } from "@/lib/reporting-period";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface DashboardSummary {
  totalMembers: number;
  totalTrophies: number;
  activeMembers: number;
  avgTrophies: number;
  trophyProgressKnownMembers: number;
}

type DashboardMember = Member & MemberActivityMetrics;

interface ChangeSummary {
  joins: number;
  leaves: number;
  nameChanges: number;
  roleChanges: number;
  since: string;
}

function getNumberMetric(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sortByTrophiesDesc(a: Member, b: Member) {
  return getNumberMetric(b.trophies) - getNumberMetric(a.trophies);
}

function sortByRisk(a: DashboardMember, b: DashboardMember, metric: TrophyPeriodMetric) {
  const statusWeight = { inactive: 0, minimal: 1, active: 2 };
  const statusDiff = statusWeight[a.activity_status] - statusWeight[b.activity_status];
  if (statusDiff !== 0) return statusDiff;
  return getNumberMetric(a[metric]) - getNumberMetric(b[metric]);
}

function normalizeTimestamp(value: string | null | undefined) {
  const timestamp = value?.trim();
  if (!timestamp) return null;

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString();
}

export async function GET(request?: Request) {
  try {
    const now = new Date();
    const range = parseTimeRange(request ? new URL(request.url).searchParams.get("range") : null);
    const period = getReportingPeriod(range, now);
    const metric = TIME_RANGES[range].metric;
    const since = period.start.toISOString();
    const until = now.toISOString();

    const [currentMembersRes, eventsRes] = await Promise.all([
      supabaseAdmin
        .from("member_history")
        .select("player_tag")
        .eq("is_current_member", true),
      supabaseAdmin
        .from("club_events")
        .select("id, event_type, player_tag, player_name, event_time")
        .gte("event_time", since).lte("event_time", until)
        .order("event_time", { ascending: false })
        .limit(5),
    ]);

    if (currentMembersRes.error) throw currentMembersRes.error;
    if (eventsRes.error) throw eventsRes.error;

    const currentTags = new Set(
      (currentMembersRes.data || []).map((row) => row.player_tag)
    );
    const currentTagList = [...currentTags];

    const [
      membersRes,
      joinsRes,
      leavesRes,
      namesRes,
      rolesRes,
      settingsRes,
    ] = await Promise.all([
      currentTagList.length > 0
        ? supabaseAdmin
            .from("members")
            .select("player_tag, player_name, icon_id, role, trophies, highest_trophies, exp_level, rank_current, rank_highest, win_rate, brawlers_count, solo_victories, duo_victories, trio_victories, is_active, last_updated")
            .in("player_tag", currentTagList)
            .order("trophies", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      supabaseAdmin.from("club_events").select("id", { count: "exact", head: true })
        .eq("event_type", "join").gte("event_time", since).lte("event_time", until),
      supabaseAdmin.from("club_events").select("id", { count: "exact", head: true })
        .eq("event_type", "leave").gte("event_time", since).lte("event_time", until),
      supabaseAdmin.from("notifications").select("id", { count: "exact", head: true })
        .eq("type", "name_change").gte("created_at", since).lte("created_at", until),
      supabaseAdmin.from("notifications").select("id", { count: "exact", head: true })
        .in("type", ["promotion", "demotion", "role_change"]).gte("created_at", since).lte("created_at", until),
      supabaseAdmin
        .from("settings")
        .select("key, value")
        .in("key", ["last_sync_time"]),
    ]);

    if (membersRes.error) throw membersRes.error;
    for (const result of [joinsRes, leavesRes, namesRes, rolesRes]) { if (result.error) throw result.error; }
    if (settingsRes.error) throw settingsRes.error;

    const members = ((membersRes.data || []) as Member[]).sort(sortByTrophiesDesc);

    const totalTrophies = members.reduce((sum, member) => sum + (member.trophies || 0), 0);
    const membersWithMetrics = await appendMemberActivityMetrics(members, now);
    const activeMembers = membersWithMetrics.filter((member) => member.activity_status === "active").length;

    const summary: DashboardSummary = {
      totalMembers: members.length,
      totalTrophies,
      activeMembers,
      avgTrophies: members.length > 0 ? Math.round(totalTrophies / members.length) : 0,
      trophyProgressKnownMembers: membersWithMetrics.filter(member => member[metric] != null).length,
    };
    const topMembers = membersWithMetrics.slice(0, 6);
    const topGainers = membersWithMetrics
      .filter(member => member[metric] != null && member[metric]! > 0)
      .sort((a, b) => getNumberMetric(b[metric]) - getNumberMetric(a[metric]))
      .slice(0, 5);
    const noProgressMembers = membersWithMetrics
      .filter(member => member[metric] === 0)
      .sort((a, b) => sortByRisk(a, b, metric))
      .slice(0, 5);
    const attentionMembers = membersWithMetrics
      .filter((member) => member.activity_status !== "active" || member[metric] === 0)
      .sort((a, b) => sortByRisk(a, b, metric))
      .slice(0, 6);

    const changeSummary: ChangeSummary = {
      joins: joinsRes.count ?? 0,
      leaves: leavesRes.count ?? 0,
      nameChanges: namesRes.count ?? 0,
      roleChanges: rolesRes.count ?? 0,
      since,
    };

    const settings = new Map(
      (settingsRes.data || []).map((setting) => [setting.key, setting.value])
    );

    return NextResponse.json(
      {
        period: reportingPeriodMetadata(period),
        summary,
        topMembers,
        topGainers,
        noProgressMembers,
        attentionMembers,
        changeSummary,
        syncStatus: {
          lastSyncTime: normalizeTimestamp(settings.get("last_sync_time")),
        },
        recentEvents: (eventsRes.data || []).map(({ id, event_type, player_tag, player_name, event_time }) => ({
          id, event_type, player_tag, player_name, event_time,
        })),
        generatedAt: now.toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error fetching dashboard:", error);
    return NextResponse.json(
      { error: "Failed to fetch dashboard" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
