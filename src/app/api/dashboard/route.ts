import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { ClubEvent, Member } from "@/types/database";
import {
  appendMemberActivityMetrics,
  MemberActivityMetrics,
} from "@/lib/member-activity-metrics";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface DashboardSummary {
  totalMembers: number;
  totalTrophies: number;
  activeMembers: number;
  avgTrophies: number;
}

type DashboardMember = Member & MemberActivityMetrics;

interface ChangeSummary {
  joins: number;
  leaves: number;
  nameChanges: number;
  roleChanges: number;
  since: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getNumberMetric(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sortByTrophiesDesc(a: Member, b: Member) {
  return getNumberMetric(b.trophies) - getNumberMetric(a.trophies);
}

function sortBySevenDayGainDesc(a: DashboardMember, b: DashboardMember) {
  return getNumberMetric(b.trophies_7d) - getNumberMetric(a.trophies_7d);
}

function sortByRisk(a: DashboardMember, b: DashboardMember) {
  const statusWeight = { inactive: 0, minimal: 1, active: 2 };
  const statusDiff = statusWeight[a.activity_status] - statusWeight[b.activity_status];
  if (statusDiff !== 0) return statusDiff;
  return getNumberMetric(a.trophies_7d) - getNumberMetric(b.trophies_7d);
}

function normalizeTimestamp(value: string | null | undefined) {
  const timestamp = value?.trim();
  if (!timestamp) return null;

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString();
}

export async function GET() {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY).toISOString();

    const [currentMembersRes, eventsRes] = await Promise.all([
      supabaseAdmin
        .from("member_history")
        .select("player_tag")
        .eq("is_current_member", true),
      supabaseAdmin
        .from("club_events")
        .select("*")
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
      recentChangeEventsRes,
      recentChangeNotificationsRes,
      settingsRes,
    ] = await Promise.all([
      currentTagList.length > 0
        ? supabaseAdmin
            .from("members")
            .select("player_tag, player_name, icon_id, role, trophies, highest_trophies, exp_level, rank_current, rank_highest, win_rate, brawlers_count, solo_victories, duo_victories, trio_victories, is_active, last_updated")
            .in("player_tag", currentTagList)
            .order("trophies", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      supabaseAdmin
        .from("club_events")
        .select("event_type")
        .gte("event_time", sevenDaysAgo),
      supabaseAdmin
        .from("notifications")
        .select("type")
        .in("type", ["name_change", "promotion", "demotion", "role_change"])
        .gte("created_at", sevenDaysAgo),
      supabaseAdmin
        .from("settings")
        .select("key, value")
        .in("key", ["last_sync_time"]),
    ]);

    if (membersRes.error) throw membersRes.error;
    if (recentChangeEventsRes.error) throw recentChangeEventsRes.error;
    if (recentChangeNotificationsRes.error) throw recentChangeNotificationsRes.error;
    if (settingsRes.error) throw settingsRes.error;

    const members = ((membersRes.data || []) as Member[]).sort(sortByTrophiesDesc);

    const totalTrophies = members.reduce((sum, member) => sum + (member.trophies || 0), 0);
    const activeMembers = members.filter((member) => member.is_active).length;

    const summary: DashboardSummary = {
      totalMembers: members.length,
      totalTrophies,
      activeMembers,
      avgTrophies: members.length > 0 ? Math.round(totalTrophies / members.length) : 0,
    };

    const membersWithMetrics = await appendMemberActivityMetrics(members, now);
    const topMembers = membersWithMetrics.slice(0, 6);
    const topGainers = membersWithMetrics
      .filter((member) => getNumberMetric(member.trophies_7d) > 0)
      .sort(sortBySevenDayGainDesc)
      .slice(0, 5);
    const trophyLosers = membersWithMetrics
      .filter((member) => getNumberMetric(member.trophies_7d) < 0)
      .sort((a, b) => getNumberMetric(a.trophies_7d) - getNumberMetric(b.trophies_7d))
      .slice(0, 5);
    const attentionMembers = membersWithMetrics
      .filter((member) => {
        const sevenDayChange = getNumberMetric(member.trophies_7d);
        return member.activity_status !== "active" || sevenDayChange < 0;
      })
      .sort(sortByRisk)
      .slice(0, 6);

    const recentChangeEvents = (recentChangeEventsRes.data || []) as Array<{ event_type: string }>;
    const recentChangeNotifications = (recentChangeNotificationsRes.data || []) as Array<{ type: string }>;
    const changeSummary: ChangeSummary = {
      joins: recentChangeEvents.filter((event) => event.event_type === "join").length,
      leaves: recentChangeEvents.filter((event) => event.event_type === "leave").length,
      nameChanges: recentChangeNotifications.filter((notification) => notification.type === "name_change").length,
      roleChanges: recentChangeNotifications.filter((notification) =>
        ["promotion", "demotion", "role_change"].includes(notification.type)
      ).length,
      since: sevenDaysAgo,
    };

    const settings = new Map(
      (settingsRes.data || []).map((setting) => [setting.key, setting.value])
    );

    return NextResponse.json(
      {
        summary,
        topMembers,
        topGainers,
        trophyLosers,
        attentionMembers,
        changeSummary,
        syncStatus: {
          lastSyncTime: normalizeTimestamp(settings.get("last_sync_time")),
          source: "cron-job.org",
          intervalMinutes: 30,
        },
        recentEvents: (eventsRes.data || []) as ClubEvent[],
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
