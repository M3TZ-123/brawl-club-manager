"use client";

import { useEffect, useState, use } from "react";
import { useAppStore } from "@/lib/store";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TrophyStatistics, ActivityCalendar, PowerLevelChart, TrackingStats, EnhancedTrackingStats } from "@/components/charts";
import { Member, ActivityLog, MemberHistory } from "@/types/database";
import {
  formatNumber,
  formatDate,
  formatRelativeTime,
  getActivityEmoji,
  getRankColor,
} from "@/lib/utils";
import { getProfileIconUrl } from "@/lib/brawl-assets";
import {
  Trophy,
  Star,
  Gamepad2,
  Target,
  Users,
  Calendar,
  RefreshCw,
  ArrowLeft,
  TrendingUp,
  Clock3,
} from "lucide-react";
import Link from "next/link";

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
  highestTrophies: number;
  power: number;
  rank: number;
  icon_url: string;
}

interface RecentMatch {
  battle_time: string;
  mode: string | null;
  map: string | null;
  result: string | null;
  trophy_change: number;
  is_star_player: boolean;
  brawler_name: string | null;
  brawler_power: number | null;
}

interface PageProps {
  params: Promise<{ tag: string }>;
}

export default function MemberDetailPage({ params }: PageProps) {
  const resolvedParams = use(params);
  const { apiKey } = useAppStore();
  const [member, setMember] = useState<Member | null>(null);
  const [activityHistory, setActivityHistory] = useState<ActivityLog[]>([]);
  const [memberHistory, setMemberHistory] = useState<MemberHistory | null>(null);
  const [lastBattleTime, setLastBattleTime] = useState<string | null>(null);
  const [battleStats, setBattleStats] = useState<BattleStats | null>(null);
  const [powerDistribution, setPowerDistribution] = useState<PowerDistribution | null>(null);
  const [enhancedStats, setEnhancedStats] = useState<EnhancedStats | null>(null);
  const [calendarBattlesByDay, setCalendarBattlesByDay] = useState<Record<string, number>>({});
  const [topBrawlers, setTopBrawlers] = useState<TopBrawler[]>([]);
  const [recentMatches, setRecentMatches] = useState<RecentMatch[]>([]);
  const [playerTags, setPlayerTags] = useState<string[]>([]);
  const [avatarError, setAvatarError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const playerTag = decodeURIComponent(resolvedParams.tag);

  useEffect(() => {
    loadMemberData();
  }, [playerTag, apiKey]);

  const loadMemberData = async () => {
    try {
      const url = `/api/members/${encodeURIComponent(playerTag)}${apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : ''}`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setMember(data.member);
        setActivityHistory(data.activityHistory || []);
        setMemberHistory(data.memberHistory);
        setLastBattleTime(data.lastBattleTime || null);
        setBattleStats(data.battleStats || null);
        setPowerDistribution(data.powerDistribution || null);
        setEnhancedStats(data.enhancedStats || null);
        setCalendarBattlesByDay(data.calendarBattlesByDay || {});
        setTopBrawlers(data.topBrawlers || []);
        setRecentMatches(data.recentMatches || []);
        setPlayerTags(data.playerTags || []);
      }
    } catch (error) {
      console.error("Error loading member:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const response = await fetch(`/api/members/${encodeURIComponent(playerTag)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });

      if (response.ok) {
        const data = await response.json();
        setMember(data.member);
      }
    } catch (error) {
      console.error("Error refreshing member:", error);
    } finally {
      setIsRefreshing(false);
    }
  };

  const getMemberBadge = () => {
    if (!memberHistory) return null;
    
    if (memberHistory.times_joined <= 1 && memberHistory.times_left === 0) {
      return <Badge variant="success">⭐ Original Member</Badge>;
    } else if (memberHistory.times_joined > 1) {
      return <Badge variant="warning">🔄 Returned ({memberHistory.times_joined}x)</Badge>;
    }
    return <Badge variant="success">⭐ Original Member</Badge>;
  };

  const trophyChartData = activityHistory
    .slice()
    .reverse()
    .map((log) => ({
      date: new Date(log.recorded_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      trophies: log.trophies,
      recorded_at: log.recorded_at,
    }));

  const totalPowerTracked = powerDistribution
    ? powerDistribution.distribution.reduce((sum, count) => sum + count, 0)
    : 0;
  const dominantPower = powerDistribution
    ? powerDistribution.distribution.reduce(
        (best, count, index) => (count > best.count ? { level: index + 1, count } : best),
        { level: 1, count: 0 }
      )
    : { level: 1, count: 0 };
  const hasDominantPower = totalPowerTracked > 0 && dominantPower.count / totalPowerTracked >= 0.8;

  const formatBattleResult = (result: string | null) => {
    if (!result) return { label: "Unknown", className: "text-muted-foreground" };
    if (result === "victory") return { label: "Victory", className: "text-green-500" };
    if (result === "defeat") return { label: "Defeat", className: "text-red-500" };
    return { label: result, className: "text-muted-foreground" };
  };

  if (isLoading) {
    return (
      <LayoutWrapper>
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </div>
      </LayoutWrapper>
    );
  }

  if (!member) {
    return (
      <LayoutWrapper>
        <div className="flex-1 flex items-center justify-center">
          <Card className="w-96">
            <CardContent className="pt-6 text-center">
              <p className="text-muted-foreground">Member not found</p>
              <Link href="/members">
                <Button className="mt-4">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back to Members
                </Button>
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
        <ArrowLeft className="h-4 w-4 mr-2" />
        Back to Members
      </Link>

      <div className="space-y-6">
        {/* Player Header */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-center gap-4">
                {getProfileIconUrl(member.icon_id) && !avatarError ? (
                  <img
                    src={getProfileIconUrl(member.icon_id) || undefined}
                    alt={`${member.player_name} icon`}
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
                        <span className="text-lg">
                          {getActivityEmoji(member.is_active ? "active" : "inactive")}
                        </span>
                      </div>
                      <p className="text-muted-foreground">{member.player_tag}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge>{member.role}</Badge>
                        {getMemberBadge()}
                      </div>
                      {playerTags.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 mt-2">
                          {playerTags.map((tag) => (
                            <Badge key={tag} variant="outline">{tag}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <Button onClick={handleRefresh} disabled={isRefreshing}>
                    <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
                    Refresh Stats
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Stats Grid */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Trophies</CardTitle>
                  <Trophy className="h-4 w-4 text-yellow-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{formatNumber(member.trophies)}</div>
                  <p className="text-xs text-muted-foreground">
                    Highest: {formatNumber(member.highest_trophies)}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Rank</CardTitle>
                  <Star className="h-4 w-4 text-purple-500" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${getRankColor(member.rank_current || "")}`}>
                    {member.rank_current || "Unranked"}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Highest: {member.rank_highest || "N/A"}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Experience</CardTitle>
                  <TrendingUp className="h-4 w-4 text-blue-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">Level {member.exp_level}</div>
                  <p className="text-xs text-muted-foreground">
                    {member.brawlers_count} Brawlers
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Victories</CardTitle>
                  <Gamepad2 className="h-4 w-4 text-green-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{formatNumber(member.trio_victories)}</div>
                  <p className="text-xs text-muted-foreground">3v3 Victories</p>
                </CardContent>
              </Card>
            </div>

            {/* Victories Breakdown */}
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">3v3 Victories</p>
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
                      <p className="text-sm text-muted-foreground">Solo Victories</p>
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
                      <p className="text-sm text-muted-foreground">Duo Victories</p>
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
                  <CardTitle>Top Brawlers</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                    {topBrawlers.map((brawler) => (
                      <div key={brawler.id} className="rounded-md border border-border/70 bg-card/50 p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <img
                            src={brawler.icon_url}
                            alt={brawler.name}
                            className="h-9 w-9 rounded-md border border-border/70 bg-muted/30"
                            loading="lazy"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-semibold truncate">{brawler.name}</p>
                            <p className="text-xs text-muted-foreground">Rank {brawler.rank}</p>
                          </div>
                        </div>
                        <div className="text-sm space-y-1">
                          <div className="flex justify-between"><span className="text-muted-foreground">Trophies</span><span className="font-medium">{formatNumber(brawler.trophies)}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Highest</span><span className="font-medium">{formatNumber(brawler.highestTrophies)}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Power</span><span className="font-medium">{brawler.power}</span></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Trophy Statistics Chart */}
            <TrophyStatistics data={trophyChartData} currentTrophies={member.trophies} />

            {/* Battle Stats Row */}
            {(battleStats || powerDistribution || enhancedStats || Object.keys(calendarBattlesByDay).length > 0) && (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {/* Activity Calendar */}
                {(Object.keys(calendarBattlesByDay).length > 0 || battleStats) && (
                  <ActivityCalendar battlesByDay={
                    Object.keys(calendarBattlesByDay).length > 0 
                      ? calendarBattlesByDay 
                      : (battleStats?.battlesByDay || {})
                  } />
                )}
                
                {/* Power Level Distribution */}
                {powerDistribution && (
                  hasDominantPower ? (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">BY POWER LEVEL</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="rounded-md border border-border/70 bg-card/50 p-4 text-center">
                          <p className="text-lg font-semibold">Maxed Account</p>
                          <p className="text-sm text-muted-foreground mt-1">
                            {dominantPower.count}/{totalPowerTracked} at Power {dominantPower.level}
                          </p>
                          <p className="text-xs text-muted-foreground mt-2">
                            Average Power: {powerDistribution.avgPower.toFixed(1)}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  ) : (
                    <PowerLevelChart 
                      distribution={powerDistribution.distribution}
                      avgPower={powerDistribution.avgPower}
                      maxedCount={powerDistribution.maxedCount}
                    />
                  )
                )}
                
                {/* Tracking Stats - Use enhanced if available, otherwise basic */}
                {enhancedStats ? (
                  <EnhancedTrackingStats
                    totalBattles={enhancedStats.totalBattles}
                    totalWins={enhancedStats.totalWins}
                    totalLosses={enhancedStats.totalLosses}
                    winRate={enhancedStats.winRate}
                    starPlayerCount={enhancedStats.starPlayerCount}
                    trophiesGained={enhancedStats.trophiesGained}
                    trophiesLost={enhancedStats.trophiesLost}
                    activeDays={enhancedStats.activeDays}
                    totalDays={enhancedStats.totalDays}
                    currentStreak={enhancedStats.currentStreak}
                    bestStreak={enhancedStats.bestStreak}
                    peakDayBattles={enhancedStats.peakDayBattles}
                    powerUps={enhancedStats.powerUps}
                    unlocks={enhancedStats.unlocks}
                    trackedDays={enhancedStats.trackedDays}
                  />
                ) : battleStats && (
                  <TrackingStats
                    battles={battleStats.battles}
                    wins={battleStats.wins}
                    losses={battleStats.losses}
                    winRate={battleStats.winRate}
                    starPlayer={battleStats.starPlayer}
                    trophyChange={battleStats.trophyChange}
                    activeDays={battleStats.activeDays}
                  />
                )}
              </div>
            )}

            {/* Recent Matches */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Recent Matches</CardTitle>
                <Badge variant="outline">Last 25</Badge>
              </CardHeader>
              <CardContent>
                {recentMatches.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No recent matches tracked yet.</p>
                ) : (
                  <div className="space-y-2">
                    {recentMatches.map((match, index) => {
                      const result = formatBattleResult(match.result);
                      return (
                        <div key={`${match.battle_time}-${index}`} className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`text-sm font-medium ${result.className}`}>{result.label}</span>
                              <span className="text-sm text-muted-foreground">{match.mode || "Unknown mode"}</span>
                            </div>
                            <p className="text-xs text-muted-foreground truncate">
                              {match.map || "Unknown map"} • {match.brawler_name || "Unknown brawler"}
                              {typeof match.brawler_power === "number" ? ` (P${match.brawler_power})` : ""}
                            </p>
                          </div>
                          <div className="text-right ml-3">
                            <p className={`text-sm font-semibold ${match.trophy_change > 0 ? "text-green-500" : match.trophy_change < 0 ? "text-red-500" : "text-muted-foreground"}`}>
                              {match.trophy_change > 0 ? `+${match.trophy_change}` : match.trophy_change}
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
              </CardContent>
            </Card>

            {/* Member History */}
            {memberHistory && (
              <Card>
                <CardHeader>
                  <CardTitle>Membership History</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="flex items-center gap-3">
                      <Calendar className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">First Joined</p>
                        <p className="text-sm text-muted-foreground">
                          {memberHistory.first_seen && new Date(memberHistory.first_seen).getFullYear() > 1970
                            ? formatDate(memberHistory.first_seen)
                            : "Since before tracking"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Users className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">Times Joined</p>
                        <p className="text-sm text-muted-foreground">
                          {memberHistory.times_joined ?? 0} time(s)
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Target className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">Times Left</p>
                        <p className="text-sm text-muted-foreground">
                          {memberHistory.times_left ?? 0} time(s)
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Calendar className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">Last Active</p>
                        <p className="text-sm text-muted-foreground">
                          {lastBattleTime ? formatRelativeTime(lastBattleTime) : "No recent battles"}
                        </p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
    </LayoutWrapper>
  );
}
