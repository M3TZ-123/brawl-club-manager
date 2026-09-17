"use client";
import { T, useI18n, LocalDate } from "@/components/locale-provider";


import dynamic from "next/dynamic";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { BrawlImage } from "@/components/brawl-image";
import { TimeRangePicker } from "@/components/time-range-picker";
import { TIME_RANGES, type TimeRangeKey, type TrophyPeriodMetric } from "@/lib/time-range";
import { DataConfidenceNotice } from "@/components/sync-health";
import { MemberReviewButton } from "@/components/member-review";
import { MembershipTimeline } from "@/components/membership-timeline";
import { PlayerProgress } from "@/components/player-progress";
import { syncErrorMessage } from "@/lib/sync-error-message";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fetchJsonCached, invalidateJsonCache } from "@/lib/client-data-cache";
import { useAdminSession } from "@/hooks/use-admin-session";
import { Member, ActivityLog, MemberHistory } from "@/types/database";
import type { ActivityStatus } from "@/lib/activity-status";
import { getActivityEmoji, getRankColor } from "@/lib/utils";
import { getProfileIconUrl } from "@/lib/brawl-assets";
import { clubRoleLabel } from "@/lib/club-role";
import { describeBattleContext, getBattleModeInfo } from "@/lib/battle-catalog";
import {
  Trophy,
  Star,
  Target,
  Users,
  Calendar,
  RefreshCw,
  ArrowLeft,
  Clock3,
} from "lucide-react";
import Link from "next/link";

function DetailChartSkeleton() {
  return (
    <Card>
      <CardContent className="h-[300px] animate-pulse p-6">
        <div className="h-5 w-36 rounded bg-muted" />
        <div className="mt-6 h-52 rounded bg-muted/60" />
      </CardContent>
    </Card>
  );
}

function MemberDetailSkeleton() {
  return (
    <LayoutWrapper>
      <div className="space-y-6">
        <Card>
          <CardContent className="flex items-center gap-4 p-6">
            <div className="h-16 w-16 animate-pulse rounded-md bg-muted" />
            <div className="space-y-3">
              <div className="h-6 w-44 animate-pulse rounded bg-muted" />
              <div className="h-4 w-28 animate-pulse rounded bg-muted/60" />
            </div>
          </CardContent>
        </Card>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={index}>
              <CardContent className="h-28 animate-pulse p-6">
                <div className="h-4 w-24 rounded bg-muted" />
                <div className="mt-5 h-7 w-20 rounded bg-muted/70" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </LayoutWrapper>
  );
}

const MemberPeriodOverview = dynamic(
  () => import("@/components/member-period-overview").then((mod) => mod.MemberPeriodOverview),
  { ssr: false, loading: () => <DetailChartSkeleton /> }
);

const PowerLevelChart = dynamic(
  () => import("@/components/charts").then((mod) => mod.PowerLevelChart),
  { ssr: false, loading: () => <DetailChartSkeleton /> }
);

interface BattleStats {
  battles: number;
  wins: number;
  losses: number;
  winRate: number;
  starPlayer: number;
  trophyChange: number;
  activeDays: number;
  battlesByDay: Record<string, number>;
}

interface PowerDistribution {
  distribution: number[];
  avgPower: number;
  maxedCount: number;
}

interface EnhancedStats {
  totalBattles: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  starPlayerCount: number;
  trophiesGained: number;
  trophiesLost: number;
  netTrophies: number;
  activeDays: number;
  totalDays: number;
  currentStreak: number;
  bestStreak: number;
  peakDayBattles: number;
  powerUps: number;
  unlocks: number;
  trackedDays: number;
}

interface TopBrawler {
  id: number;
  name: string;
  trophies: number;
  highestTrophies: number | null;
  power: number;
  rank: number;
  icon_url: string;
}

interface RecentMatch {
  battle_time: string;
  mode: string | null;
  map: string | null;
  result: string | null;
  trophy_change: number | null;
  pointData?: { change: number | null; unit: "trophies" | "unknown" };
  battle_type?: string | null;
  event_id?: number | null;
  event_mode_id?: number | null;
  battle_mode?: string | null;
  event_mode?: string | null;
  placement_rank?: number | null;
  context?: { key: string; label: string };
  is_star_player: boolean;
  brawler_name: string | null;
  brawler_power: number | null;
}

interface PageProps {
  params: Promise<{ tag: string }>;
}

type DetailMember = Member & { activity_status: ActivityStatus } & Partial<Record<TrophyPeriodMetric, number | null>>;

interface MemberDetailResponse {
  member: DetailMember;
  activityHistory?: ActivityLog[];
  activityHistoryResolution?: "hourly" | "three_hourly" | "six_hourly" | "daily";
  memberHistory?: MemberHistory | null;
  lastBattleTime?: string | null;
  battleStats?: BattleStats | null;
  powerDistribution?: PowerDistribution | null;
  enhancedStats?: EnhancedStats | null;
  calendarBattlesByDay?: Record<string, number>;
  topBrawlers?: TopBrawler[];
  recentMatches?: RecentMatch[];
  period?: { start: string; end: string };
}

export default function MemberDetailPage({ params }: PageProps) {
  const { t } = useI18n();
  const { number: formatNumber, delta: formatDelta, relative: formatRelativeTime, date: formatDate } = useI18n();
  const resolvedParams = use(params);
  const [member, setMember] = useState<DetailMember | null>(null);
  const [activityHistory, setActivityHistory] = useState<ActivityLog[]>([]);
  const [memberHistory, setMemberHistory] = useState<MemberHistory | null>(null);
  const [lastBattleTime, setLastBattleTime] = useState<string | null>(null);
  const [battleStats, setBattleStats] = useState<BattleStats | null>(null);
  const [powerDistribution, setPowerDistribution] = useState<PowerDistribution | null>(null);
  const [enhancedStats, setEnhancedStats] = useState<EnhancedStats | null>(null);
  const [observationIntervalMs, setObservationIntervalMs] = useState<number>();
  const [period, setPeriod] = useState<MemberDetailResponse["period"]>();
  const [topBrawlers, setTopBrawlers] = useState<TopBrawler[]>([]);
  const [recentMatches, setRecentMatches] = useState<RecentMatch[]>([]);
  const [showAllMatches, setShowAllMatches] = useState(false);
  const [selectedRange, setSelectedRange] = useState<TimeRangeKey>("7d");
  const [loadError, setLoadError] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const [avatarError, setAvatarError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { isAdmin } = useAdminSession();

  const playerTag = useMemo(() => decodeURIComponent(resolvedParams.tag), [resolvedParams.tag]);
  const memberApiUrl = useMemo(() => `/api/members/${encodeURIComponent(playerTag)}`, [playerTag]);
  const activeMemberUrl = useRef(memberApiUrl);
  activeMemberUrl.current = memberApiUrl;

  const loadMemberData = useCallback(async (force = false) => {
    const sequence = ++loadSequence.current;
    setLoadError(false);
    if (!force) setIsLoading(true);
    try {
      const data = await fetchJsonCached<MemberDetailResponse>(`${memberApiUrl}?range=${selectedRange}`, {
        staleMs: 30_000,
        force,
      });
      if (sequence !== loadSequence.current) return;
      setMember(data.member);
      setActivityHistory(data.activityHistory || []);
      const resolutionHours = { hourly: 1, three_hourly: 3, six_hourly: 6, daily: 24 };
      setObservationIntervalMs(data.activityHistoryResolution ? resolutionHours[data.activityHistoryResolution] * 3_600_000 : undefined);
      setMemberHistory(data.memberHistory || null);
      setLastBattleTime(data.lastBattleTime || null);
      setBattleStats(data.battleStats || null);
      setPowerDistribution(data.powerDistribution || null);
      setEnhancedStats(data.enhancedStats || null);
      setPeriod(data.period);
      setTopBrawlers(data.topBrawlers || []);
      setRecentMatches(data.recentMatches || []);
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setLoadError(true);
      if (!force) setMember(null);
      console.error("Error loading member:", error);
    } finally {
      if (sequence === loadSequence.current) setIsLoading(false);
    }
  }, [memberApiUrl, selectedRange]);

  const loadMemberDataRef = useRef(loadMemberData);
  loadMemberDataRef.current = loadMemberData;

  useEffect(() => {
    setShowAllMatches(false);
  }, [memberApiUrl, selectedRange]);

  useEffect(() => {
    setAvatarError(false);
    setRefreshError(null);
    setIsRefreshing(false);
  }, [memberApiUrl]);

  useEffect(() => {
    loadMemberData();
  }, [loadMemberData]);

  useEffect(() => {
    const handleClubDataUpdated = () => {
      loadMemberData(true);
    };
    window.addEventListener("club-data-updated", handleClubDataUpdated);
    return () => window.removeEventListener("club-data-updated", handleClubDataUpdated);
  }, [loadMemberData]);

  const handleRefresh = async () => {
    if (!isAdmin) return;
    const requestedMemberUrl = memberApiUrl;
    setRefreshError(null);
    setIsRefreshing(true);
    let failureMessage = "Could not refresh this member. Please try again.";
    try {
      const response = await fetch(requestedMemberUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        failureMessage = syncErrorMessage(await response.json().catch(() => ({}))) || failureMessage;
        throw new Error(failureMessage);
      }
      invalidateJsonCache(requestedMemberUrl);
      if (activeMemberUrl.current !== requestedMemberUrl) return;
      await loadMemberDataRef.current(true);
    } catch (error) {
      if (activeMemberUrl.current === requestedMemberUrl) setRefreshError(failureMessage);
      console.error("Error refreshing member:", error);
    } finally {
      if (activeMemberUrl.current === requestedMemberUrl) setIsRefreshing(false);
    }
  };

  const getMemberBadge = () => {
    if (!memberHistory) return null;
    if (memberHistory.is_current_member === false) {
      return <Badge variant="destructive"><T text="Former" /></Badge>;
    }
    if (memberHistory.is_current_member !== true) return null;
    if (memberHistory.times_left > 0 || memberHistory.last_left_at) {
      return <Badge variant="warning"><T text="Returned" /></Badge>;
    }
    if (typeof memberHistory.times_joined === "number" && memberHistory.times_joined <= 1 && memberHistory.times_left === 0) {
      return <Badge variant="success"><T text="No recorded departures" /></Badge>;
    }
    return <Badge variant="outline"><T text="Current" /></Badge>;
  };

  const trophyObservations = useMemo(() => activityHistory.map(log => ({ recordedAt: log.recorded_at, trophies: log.trophies })), [activityHistory]);
  const profileIconUrl = member ? getProfileIconUrl(member.icon_id) : null;

  const formatBattleResult = (result: string | null) => {
    if (result === "victory") return { label: "Victory", className: "text-green-500" };
    if (result === "defeat") return { label: "Defeat", className: "text-red-500" };
    if (result === "draw") return { label: "Draw", className: "text-muted-foreground" };
    return { label: "Unknown result", className: "text-muted-foreground" };
  };

  if (isLoading) {
    return <MemberDetailSkeleton />;
  }

  if (!member) {
    return (
      <LayoutWrapper>
        <div className="flex-1 flex items-center justify-center">
          <Card className="w-96">
            <CardContent className="pt-6 text-center">
              <p role={loadError ? "alert" : undefined} className="text-muted-foreground"><T text={loadError ? "Could not load this member." : "Member not found"} /></p>
              {loadError && <Button className="mt-3" variant="outline" onClick={() => loadMemberData(true)}><T text="Retry" /></Button>}
              <Link href="/members">
                <Button className="mt-4">
                  <ArrowLeft className="h-4 w-4 me-2" />
                  <T text=" Back to Members " /></Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </LayoutWrapper>
    );
  }

  return (
    <LayoutWrapper>
      {/* Back Button */}
      <Link href="/members" className="inline-flex items-center text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="h-4 w-4 me-2" />
        <T text=" Back to Members " /></Link>

      <div className="space-y-6">
        {/* Player Header */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-center gap-4">
                {profileIconUrl && !avatarError ? (
                  <Image
                    src={profileIconUrl}
                    alt={`${member.player_name} icon`}
                    width={64}
                    height={64}
                    className="h-16 w-16 rounded-md border border-border/70 bg-muted/30 shadow-sm"
                    onError={() => setAvatarError(true)}
                  />
                ) : (
                  <div className="h-16 w-16 rounded-md bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center text-2xl font-bold text-white shadow-sm">
                    {member.player_name.charAt(0)}
                  </div>
                )}
                <div>
                      <div className="flex items-center gap-2">
                        <h1 className="text-2xl font-bold">{member.player_name}</h1>
                        <span className="text-lg" title={t(member.activity_status === "minimal" ? "Low activity" : member.activity_status)}>
                          {getActivityEmoji(member.activity_status)}
                        </span>
                      </div>
                      <p className="text-muted-foreground"><bdi dir="ltr">{member.player_tag}</bdi></p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge>{<T text={clubRoleLabel(member.role)} />}</Badge>
                        {getMemberBadge()}
                      </div>

                    </div>
                  </div>
                  <MemberReviewButton prominent member={{ ...memberHistory, ...member }} initialRange={selectedRange} />
                  {isAdmin && <Button variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
                    <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
                    <T text="Refresh Stats" />
                  </Button>}
                </div>
              </CardContent>
            </Card>

            {loadError && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm"><T text="Could not load this member." /> <Button variant="ghost" onClick={() => loadMemberData(true)}><T text="Retry" /></Button></div>}
            {refreshError && <p role="alert" className="text-sm text-destructive"><T text={refreshError} /></p>}
            <h2 className="text-lg font-semibold"><T text={memberHistory?.is_current_member === false ? "Stored account snapshot" : "Current account"} /></h2>
            {memberHistory?.is_current_member === false && <p className="text-sm text-muted-foreground"><T text="This former member's account details come from the latest stored profile." /></p>}
            {/* Stats Grid */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium"><T text="Trophies" /></CardTitle>
                  <Trophy className="h-4 w-4 text-yellow-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{formatNumber(member.trophies)}</div>
                  <p className="text-xs text-muted-foreground">
                    <T text=" Highest: " />{formatNumber(member.highest_trophies)}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium"><T text="Rank" /></CardTitle>
                  <Star className="h-4 w-4 text-purple-500" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${getRankColor(member.rank_current || "")}`}>
                    {member.rank_current || <T text="Unknown" />}
                  </div>
                  {member.ranked_points != null && <p className="text-sm"><T text="Ranked points" />: {formatNumber(member.ranked_points)}</p>}
                  <p className="text-xs text-muted-foreground">
                    <T text="All-time best" />: {member.rank_highest || <T text="Unknown" />}
                  </p>
                  {member.ranked_season_best && <p className="text-xs text-muted-foreground"><T text="Season best" />: {member.ranked_season_best}</p>}
                  {member.ranked_checked_at && <p className="mt-2 text-xs text-muted-foreground"><T text="Rank last checked" />: <LocalDate value={member.ranked_checked_at} time /></p>}
                </CardContent>
              </Card>

            </div>

            <DataConfidenceNotice />
            <TimeRangePicker value={selectedRange} onChange={range => { if (range !== selectedRange) { setIsLoading(true); setSelectedRange(range); } }} dayBased />
            <MemberPeriodOverview range={selectedRange} trophyChange={member[TIME_RANGES[selectedRange].metric] ?? null}
              observations={trophyObservations} observationIntervalMs={observationIntervalMs} period={period}
              stats={enhancedStats ? { battles: enhancedStats.totalBattles, wins: enhancedStats.totalWins, losses: enhancedStats.totalLosses, winRate: enhancedStats.winRate, activeDays: enhancedStats.activeDays } : battleStats} />

            <details className="rounded-lg border p-4">
              <summary className="cursor-pointer font-semibold"><T text={memberHistory?.is_current_member === false ? "Lifetime victories and stored brawlers" : "Lifetime victories and current brawlers"} /></summary>
              <div className="mt-4 space-y-4">
                <p className="text-sm text-muted-foreground"><T text="Experience" />: <T text="Level " />{member.exp_level} · {member.brawlers_count} <T text="Brawlers" /></p>
            {/* Victories Breakdown */}
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground"><T text="3v3 Victories" /></p>
                      <p className="text-2xl font-bold">{formatNumber(member.trio_victories)}</p>
                    </div>
                    <Users className="h-6 w-6 text-blue-500" />
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground"><T text="Solo Victories" /></p>
                      <p className="text-2xl font-bold">{formatNumber(member.solo_victories)}</p>
                    </div>
                    <Target className="h-6 w-6 text-orange-500" />
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground"><T text="Duo Victories" /></p>
                      <p className="text-2xl font-bold">{formatNumber(member.duo_victories)}</p>
                    </div>
                    <Users className="h-6 w-6 text-green-500" />
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Top Brawlers */}
            {topBrawlers.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle><T text="Top Brawlers" /></CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                    {topBrawlers.map((brawler) => (
                      <div key={brawler.id} className="rounded-md border border-border/70 bg-card/50 p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <BrawlImage
                            src={brawler.icon_url}
                            alt={brawler.name}
                            width={36}
                            height={36}
                            className="h-9 w-9 rounded-md border border-border/70 bg-muted/30"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-semibold truncate">{brawler.name}</p>
                            <p className="text-xs text-muted-foreground"><T text="Rank " />{brawler.rank}</p>
                          </div>
                        </div>
                        <div className="text-sm space-y-1">
                          <div className="flex justify-between"><span className="text-muted-foreground"><T text="Trophies" /></span><span className="font-medium">{formatNumber(brawler.trophies)}</span></div>
                          <div className="flex justify-between gap-2"><span className="text-muted-foreground"><T text="Highest" /></span><span className="font-medium">{brawler.highestTrophies == null ? t("Unknown") : formatNumber(brawler.highestTrophies)}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground"><T text="Power" /></span><span className="font-medium">{brawler.power}</span></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {powerDistribution && <PowerLevelChart distribution={powerDistribution.distribution} avgPower={powerDistribution.avgPower} maxedCount={powerDistribution.maxedCount} />}
              </div>
            </details>

            {/* Recent Matches */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle><T text="Recent Matches" /></CardTitle>
                <Badge variant="outline"><T text="{shown} of {total}" values={{ shown: formatNumber(showAllMatches ? recentMatches.length : Math.min(5, recentMatches.length)), total: formatNumber(recentMatches.length) }} /></Badge>
              </CardHeader>
              <CardContent>
                {recentMatches.length === 0 ? (
                  <p className="text-sm text-muted-foreground"><T text="No battles recorded in this period." /></p>
                ) : (
                  <div className="space-y-2">
                    {(showAllMatches ? recentMatches : recentMatches.slice(0, 5)).map((match, index) => {
                      const result = formatBattleResult(match.result);
                      const mode = getBattleModeInfo(match.mode, match.event_mode_id);
                      const context = match.context || describeBattleContext(match);
                      const change = match.pointData ? match.pointData.change : match.trophy_change;
                      return (
                        <div key={`${match.battle_time}-${index}`} className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className={`text-sm font-medium ${result.className}`}>{<T text={result.label} />}</span>
                              <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">{mode.imageUrl ? <BrawlImage fallback={mode.icon} src={mode.imageUrl} alt="" width={16} height={16} className="h-4 w-4 object-contain" /> : <span aria-hidden="true">{mode.icon}</span>}{t(mode.label)}</span>
                              <span className="text-xs text-muted-foreground">{t(context.label)}</span>
                            </div>
                            <p className="text-xs text-muted-foreground truncate">
                              {match.map || t("Unknown map")} • {match.brawler_name || t("Unknown Brawler")}
                              {typeof match.brawler_power === "number" ? <T text=" (P{value0})" values={{ value0: String(match.brawler_power) }} /> : ""}
                            </p>
                          </div>
                          <div className="text-end ms-3">
                            <p title={t(match.pointData?.unit === "trophies" ? "Trophy change" : "Reported change")} className={`text-sm font-semibold ${change != null && change > 0 ? "text-green-500" : change != null && change < 0 ? "text-red-500" : "text-muted-foreground"}`}>
                              <bdi>{formatDelta(change)}</bdi>
                            </p>
                            <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
                              <Clock3 className="h-3 w-3" />
                              {formatRelativeTime(match.battle_time)}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {recentMatches.length > 5 && <Button variant="outline" size="sm" className="mt-3" aria-expanded={showAllMatches} onClick={() => setShowAllMatches(value => !value)}>
                  <T text={showAllMatches ? "Show fewer battles" : "Show all recent battles"} />
                </Button>}
              </CardContent>
            </Card>

            <PlayerProgress playerTag={member.player_tag} range={selectedRange} />
            <details className="rounded-lg border p-4">
              <summary className="cursor-pointer font-semibold"><T text="Membership History" /></summary>
              <div className="mt-4 space-y-4">
            <MembershipTimeline playerTag={member.player_tag} />
            {/* Member History */}
            {memberHistory && (
              <Card>
                <CardHeader>
                  <CardTitle><T text="Membership History" /></CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="flex items-center gap-3">
                      <Calendar className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium"><T text="First observed" /></p><p className="text-xs text-muted-foreground"><T text="First observed is when tracking first recorded this player, not necessarily their actual join date." /></p>
                        <p className="text-sm text-muted-foreground">
                          {memberHistory.first_seen && new Date(memberHistory.first_seen).getFullYear() > 1970
                            ? formatDate(memberHistory.first_seen)
                            : <T text="Unknown" />}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Users className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium"><T text="Times Joined" /></p>
                        <p className="text-sm text-muted-foreground">
                          {memberHistory.times_joined == null ? <T text="Unknown" /> : formatNumber(memberHistory.times_joined)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Target className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium"><T text="Times Left" /></p>
                        <p className="text-sm text-muted-foreground">
                          {memberHistory.times_left == null ? <T text="Unknown" /> : formatNumber(memberHistory.times_left)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Calendar className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium"><T text="Last Battle" /></p>
                        <p className="text-sm text-muted-foreground">
                          {lastBattleTime ? formatRelativeTime(lastBattleTime) : <T text="No recent battles" />}
                        </p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
              </div>
            </details>
          </div>
    </LayoutWrapper>
  );
}
