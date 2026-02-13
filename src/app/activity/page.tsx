"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Trophy,
  Swords,
  Target,
  TrendingUp,
  Star,
  Flame,
  Crown,
  Medal,
  Zap,
} from "lucide-react";

interface LeaderboardMember {
  tag: string;
  name: string;
  role: string;
  trophies: number;
  highestTrophies: number;
  winRate: number | null;
  totalVictories: number;
  brawlersCount: number;
  expLevel: number;
  rankCurrent: string | null;
  rankHighest: string | null;
  allTime: {
    battles: number;
    wins: number;
    losses: number;
    starPlayer: number;
    trophiesGained: number;
    trophiesLost: number;
    activeDays: number;
    currentStreak: number;
    bestStreak: number;
    peakDayBattles: number;
  };
  weekly: {
    battles: number;
    wins: number;
    losses: number;
    starPlayer: number;
    trophiesGained: number;
    trophiesLost: number;
    activeDays: number;
    winRate: number;
    netTrophies: number;
  };
}

interface Leaderboards {
  trophyLeaders: LeaderboardMember[];
  weeklyBattlers: LeaderboardMember[];
  weeklyWinRate: LeaderboardMember[];
  weeklyTrophyGainers: LeaderboardMember[];
  weeklyStarPlayers: LeaderboardMember[];
  mostActive: LeaderboardMember[];
  allTimeBattlers: LeaderboardMember[];
}

const PODIUM_COLORS = [
  "from-yellow-500/20 to-yellow-600/5 border-yellow-500/40",
  "from-slate-300/20 to-slate-400/5 border-slate-400/40",
  "from-amber-700/20 to-amber-800/5 border-amber-700/40",
];

const PODIUM_ICONS = [
  <Crown key="gold" className="h-6 w-6 text-yellow-500" />,
  <Medal key="silver" className="h-6 w-6 text-slate-400" />,
  <Medal key="bronze" className="h-6 w-6 text-amber-700" />,
];

const RANK_BADGES = [
  "bg-yellow-500/20 text-yellow-500 border-yellow-500/30",
  "bg-slate-400/20 text-slate-300 border-slate-400/30",
  "bg-amber-700/20 text-amber-600 border-amber-700/30",
];

function RankBadge({ rank }: { rank: number }) {
  if (rank <= 3) {
    return (
      <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold border ${RANK_BADGES[rank - 1]}`}>
        {rank}
      </span>
    );
  }
  return <span className="text-sm text-muted-foreground w-7 text-center inline-block">{rank}</span>;
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function Podium({
  members,
  formatValue,
  subtitle,
}: {
  members: LeaderboardMember[];
  formatValue: (m: LeaderboardMember) => string;
  subtitle?: (m: LeaderboardMember) => string;
}) {
  const top3 = members.slice(0, 3);
  if (top3.length === 0) {
    return (
      <p className="text-center text-muted-foreground py-8">
        No data available yet. Sync your club to start tracking!
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
      {top3.map((member, i) => (
        <Link href={`/members/${encodeURIComponent(member.tag)}`} key={member.tag}>
          <div
            className={`relative p-4 rounded-xl bg-gradient-to-b border transition-colors hover:bg-accent/50 ${PODIUM_COLORS[i]}`}
          >
            <div className="flex items-center gap-3">
              <div className="flex-shrink-0">{PODIUM_ICONS[i]}</div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-sm truncate">{member.name}</p>
                <p className="text-2xl font-bold">{formatValue(member)}</p>
                {subtitle && (
                  <p className="text-xs text-muted-foreground">{subtitle(member)}</p>
                )}
              </div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function LeaderboardTable({
  members,
  columns,
}: {
  members: LeaderboardMember[];
  columns: {
    header: string;
    value: (m: LeaderboardMember) => React.ReactNode;
    className?: string;
  }[];
}) {
  const rest = members.slice(3);
  const PAGE_SIZE = 10;
  const [page, setPage] = useState(0);
  const totalPages = Math.ceil(rest.length / PAGE_SIZE);
  const paginated = rest.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (rest.length === 0) return null;

  return (
    <div>
      <div className="overflow-x-auto -mx-4 sm:mx-0 rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Player</TableHead>
              {columns.map((col) => (
                <TableHead key={col.header} className={col.className}>
                  {col.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginated.map((member, i) => (
              <TableRow key={member.tag} className="group">
                <TableCell>
                  <RankBadge rank={page * PAGE_SIZE + i + 4} />
                </TableCell>
                <TableCell>
                  <Link
                    href={`/members/${encodeURIComponent(member.tag)}`}
                    className="hover:underline font-medium"
                  >
                    {member.name}
                  </Link>
                </TableCell>
                {columns.map((col) => (
                  <TableCell key={col.header} className={col.className}>
                    {col.value(member)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-end pt-3 px-1">
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="h-7 px-2 text-xs"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="h-7 px-2 text-xs"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const categories = [
  {
    key: "trophyLeaders" as const,
    label: "Trophies",
    icon: Trophy,
    description: "Current trophy rankings",
    formatValue: (m: LeaderboardMember) => formatNumber(m.trophies),
    subtitle: (m: LeaderboardMember) => `Peak: ${formatNumber(m.highestTrophies)}`,
    columns: [
      { header: "Trophies", value: (m: LeaderboardMember) => formatNumber(m.trophies), className: "text-right" },
      { header: "Peak", value: (m: LeaderboardMember) => formatNumber(m.highestTrophies), className: "text-right" },
      { header: "Brawlers", value: (m: LeaderboardMember) => m.brawlersCount, className: "text-right" },
    ],
  },
  {
    key: "weeklyBattlers" as const,
    label: "Battles",
    icon: Swords,
    description: "Most battles played this week",
    formatValue: (m: LeaderboardMember) => m.weekly.battles.toString(),
    subtitle: (m: LeaderboardMember) => {
      const draws = m.weekly.battles - m.weekly.wins - m.weekly.losses;
      return draws > 0 ? `${m.weekly.wins}W / ${m.weekly.losses}L / ${draws}D` : `${m.weekly.wins}W / ${m.weekly.losses}L`;
    },
    columns: [
      { header: "Battles", value: (m: LeaderboardMember) => m.weekly.battles, className: "text-right" },
      { header: "Wins", value: (m: LeaderboardMember) => m.weekly.wins, className: "text-right" },
      { header: "Win %", value: (m: LeaderboardMember) => `${m.weekly.winRate}%`, className: "text-right" },
    ],
  },
  {
    key: "weeklyWinRate" as const,
    label: "Win Rate",
    icon: Target,
    description: "Highest win rate this week (min 10 battles)",
    formatValue: (m: LeaderboardMember) => `${m.weekly.winRate}%`,
    subtitle: (m: LeaderboardMember) => `${m.weekly.battles} battles`,
    columns: [
      { header: "Win %", value: (m: LeaderboardMember) => <span className="font-semibold">{m.weekly.winRate}%</span>, className: "text-right" },
      { header: "W / L", value: (m: LeaderboardMember) => `${m.weekly.wins} / ${m.weekly.losses}`, className: "text-right" },
      { header: "Battles", value: (m: LeaderboardMember) => m.weekly.battles, className: "text-right" },
    ],
  },
  {
    key: "weeklyTrophyGainers" as const,
    label: "Progress",
    icon: TrendingUp,
    description: "Most trophies gained this week",
    formatValue: (m: LeaderboardMember) => {
      const n = m.weekly.netTrophies;
      return n >= 0 ? `+${n}` : `${n}`;
    },
    subtitle: (m: LeaderboardMember) => `${formatNumber(m.trophies)} total`,
    columns: [
      {
        header: "Net",
        value: (m: LeaderboardMember) => {
          const n = m.weekly.netTrophies;
          const color = n > 0 ? "text-green-500" : n < 0 ? "text-red-500" : "";
          return <span className={`font-semibold ${color}`}>{n >= 0 ? `+${n}` : n}</span>;
        },
        className: "text-right",
      },
      { header: "Gained", value: (m: LeaderboardMember) => `+${m.weekly.trophiesGained}`, className: "text-right" },
      { header: "Lost", value: (m: LeaderboardMember) => `-${m.weekly.trophiesLost}`, className: "text-right" },
    ],
  },
  {
    key: "weeklyStarPlayers" as const,
    label: "Stars",
    icon: Star,
    description: "Most Star Player awards this week",
    formatValue: (m: LeaderboardMember) => `${m.weekly.starPlayer}`,
    subtitle: (m: LeaderboardMember) => `${m.weekly.battles} battles`,
    columns: [
      { header: "Stars", value: (m: LeaderboardMember) => <span className="font-semibold text-yellow-500">{m.weekly.starPlayer}</span>, className: "text-right" },
      { header: "Battles", value: (m: LeaderboardMember) => m.weekly.battles, className: "text-right" },
      {
        header: "Star %",
        value: (m: LeaderboardMember) => {
          const pct = m.weekly.battles > 0 ? Math.round((m.weekly.starPlayer / m.weekly.battles) * 100) : 0;
          return `${pct}%`;
        },
        className: "text-right",
      },
    ],
  },
  {
    key: "mostActive" as const,
    label: "Activity",
    icon: Flame,
    description: "Most active members (tracked days)",
    formatValue: (m: LeaderboardMember) => `${m.allTime.activeDays}d`,
    subtitle: (m: LeaderboardMember) => m.allTime.currentStreak > 0 ? `${m.allTime.currentStreak}d streak` : "No streak",
    columns: [
      { header: "Days", value: (m: LeaderboardMember) => m.allTime.activeDays, className: "text-right" },
      { header: "Streak", value: (m: LeaderboardMember) => m.allTime.currentStreak > 0 ? <span className="text-orange-500 font-semibold">{m.allTime.currentStreak}d</span> : <span className="text-muted-foreground">-</span>, className: "text-right" },
      { header: "Best", value: (m: LeaderboardMember) => `${m.allTime.bestStreak}d`, className: "text-right" },
    ],
  },
  {
    key: "allTimeBattlers" as const,
    label: "All-Time",
    icon: Zap,
    description: "All-time battle statistics",
    formatValue: (m: LeaderboardMember) => formatNumber(m.allTime.battles),
    subtitle: (m: LeaderboardMember) => {
      const draws = m.allTime.battles - m.allTime.wins - m.allTime.losses;
      const wl = draws > 0 ? `${m.allTime.wins}W / ${m.allTime.losses}L / ${draws}D` : `${m.allTime.wins}W / ${m.allTime.losses}L`;
      return wl;
    },
    columns: [
      { header: "Battles", value: (m: LeaderboardMember) => formatNumber(m.allTime.battles), className: "text-right" },
      { header: "Wins", value: (m: LeaderboardMember) => formatNumber(m.allTime.wins), className: "text-right" },
      { header: "Stars", value: (m: LeaderboardMember) => <span className="text-yellow-500">{m.allTime.starPlayer}</span>, className: "text-right" },
    ],
  },
];

export default function LeaderboardPage() {
  const [leaderboards, setLeaderboards] = useState<Leaderboards | null>(null);
  const [memberCount, setMemberCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("trophyLeaders");

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/leaderboard");
        if (res.ok) {
          const data = await res.json();
          setLeaderboards(data.leaderboards);
          setMemberCount(data.memberCount || 0);
        }
      } catch (err) {
        console.error("Error loading leaderboard:", err);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  return (
    <LayoutWrapper>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Trophy className="h-6 w-6 text-yellow-500" />
              Club Leaderboard
            </h1>
            <p className="text-sm text-muted-foreground">
              {memberCount} members tracked
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : !leaderboards ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              Failed to load leaderboard data. Try syncing your club first.
            </CardContent>
          </Card>
        ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="w-full flex flex-wrap h-auto gap-1 bg-transparent p-0">
              {categories.map((cat) => {
                const Icon = cat.icon;
                const data = leaderboards[cat.key] || [];
                return (
                  <TabsTrigger
                    key={cat.key}
                    value={cat.key}
                    className="flex items-center gap-1.5 px-3 py-2 data-[state=active]:bg-accent rounded-lg border border-transparent data-[state=active]:border-border text-xs sm:text-sm"
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{cat.label}</span>
                    {data.length > 0 && (
                      <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 h-4">
                        {data.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>

            {categories.map((cat) => {
              const data = leaderboards[cat.key] || [];
              return (
                <TabsContent key={cat.key} value={cat.key} className="space-y-4 mt-4">
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex items-center gap-2">
                        <cat.icon className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <CardTitle className="text-lg">{cat.label}</CardTitle>
                          <CardDescription>{cat.description}</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <Podium
                        members={data}
                        formatValue={cat.formatValue}
                        subtitle={cat.subtitle}
                      />
                      <LeaderboardTable members={data} columns={cat.columns} />
                    </CardContent>
                  </Card>
                </TabsContent>
              );
            })}
          </Tabs>
        )}
      </div>
    </LayoutWrapper>
  );
}
