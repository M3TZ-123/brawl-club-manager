"use client";

import { useEffect, useState, use } from "react";
import { useAppStore } from "@/lib/store";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { TrophyStatistics, ActivityCalendar, PowerLevelChart, TrackingStats, EnhancedTrackingStats } from "@/components/charts";
import { Member, ActivityLog, MemberHistory } from "@/types/database";
import {
  formatNumber,
  formatDate,
  formatRelativeTime,
  getActivityEmoji,
  getRankColor,
} from "@/lib/utils";
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
                <div className="h-16 w-16 rounded-full bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center text-2xl font-bold text-white">
                  {member.player_name.charAt(0)}
                </div>
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
            <Card>
              <CardHeader>
                <CardTitle>Battle Statistics</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>3v3 Victories</span>
                      <span>{formatNumber(member.trio_victories)}</span>
                    </div>
                    <Progress
                      value={
                        (member.trio_victories /
                          ((member.trio_victories + member.solo_victories + member.duo_victories) || 1)) *
                        100
                      }
                      className="h-2"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>Solo Victories</span>
                      <span>{formatNumber(member.solo_victories)}</span>
                    </div>
                    <Progress
                      value={
                        (member.solo_victories /
                          ((member.trio_victories + member.solo_victories + member.duo_victories) || 1)) *
                        100
                      }
                      className="h-2"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>Duo Victories</span>
                      <span>{formatNumber(member.duo_victories)}</span>
                    </div>
                    <Progress
                      value={
                        (member.duo_victories /
                          ((member.trio_victories + member.solo_victories + member.duo_victories) || 1)) *
                        100
                      }
                      className="h-2"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Trophy Statistics Chart */}
            {trophyChartData.length > 0 && (
              <TrophyStatistics data={trophyChartData} currentTrophies={member.trophies} />
            )}

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
                  <PowerLevelChart 
                    distribution={powerDistribution.distribution}
                    avgPower={powerDistribution.avgPower}
                    maxedCount={powerDistribution.maxedCount}
                  />
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
