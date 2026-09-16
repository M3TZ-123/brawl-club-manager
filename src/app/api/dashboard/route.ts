import { NextResponse } from "next/server";
import { readDashboard } from "@/lib/reporting-reads";
import { Member } from "@/types/database";
import {
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

export async function GET(request?: Request) {
  try {
    const now = new Date();
    const range = parseTimeRange(request ? new URL(request.url).searchParams.get("range") : null);
    const period = getReportingPeriod(range, now);
    const metric = TIME_RANGES[range].metric;
    const since = period.start.toISOString();
    const snapshot = await readDashboard(period.days, now);
    const membersWithMetrics = snapshot.members.sort(sortByTrophiesDesc);
    const members = membersWithMetrics;

    const totalTrophies = members.reduce((sum, member) => sum + (member.trophies || 0), 0);
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
      joins: snapshot.changeCounts.joins,
      leaves: snapshot.changeCounts.leaves,
      nameChanges: snapshot.changeCounts.nameChanges,
      roleChanges: snapshot.changeCounts.roleChanges,
      since,
    };

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
          lastSyncTime: snapshot.lastSyncTime,
        },
        recentEvents: snapshot.recentEvents,
        generatedAt: now.toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error fetching dashboard:", error instanceof Error ? error.name : "database_error");
    return NextResponse.json(
      { error: "Failed to fetch dashboard" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
