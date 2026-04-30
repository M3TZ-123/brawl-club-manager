"use client";

import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { fetchJsonCached } from "@/lib/client-data-cache";
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
  Search,
  Filter,
  Clock3,
} from "lucide-react";

type RangeKey = "24h" | "3d" | "7d" | "30d";
type ActivityFilter = "all" | "active" | "minimal" | "inactive";
type RoleFilter = "all" | "president" | "vicepresident" | "senior" | "member";

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
  activityStatus: "active" | "minimal" | "inactive";
  lastBattleAt: string | null;
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
    netTrophies: number | null;
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

interface LeaderboardResponse {
  leaderboards: Leaderboards;
  memberCount?: number;
  range?: {
    key: RangeKey;
    label: string;
    minWinRateBattles: number;
  };
  generatedAt?: string;
  lastSyncTime?: string | null;
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

const rangeOptions: Array<{ key: RangeKey; label: string }> = [
  { key: "24h", label: "24h" },
  { key: "3d", label: "3d" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

const roleOptions: Array<{ value: RoleFilter; label: string }> = [
  { value: "all", label: "All roles" },
  { value: "president", label: "President" },
  { value: "vicepresident", label: "Vice President" },
  { value: "senior", label: "Senior" },
  { value: "member", label: "Member" },
];

const activityOptions: Array<{ value: ActivityFilter; label: string }> = [
  { value: "all", label: "All activity" },
  { value: "active", label: "Active" },
  { value: "minimal", label: "Low activity" },
  { value: "inactive", label: "Inactive" },
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

function formatRelativeTime(value: string | null | undefined) {
  if (!value) return "No battle";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  const diffMs = Math.max(Date.now() - date.getTime(), 0);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatSyncTime(value: string | null | undefined) {
  if (!value) return "No sync recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sync time unknown";
  return `Last sync ${formatRelativeTime(value)}`;
}

function normalizeRole(role: string) {
  return role.toLowerCase().replace(/\s+/g, "");
}

const Podium = memo(function Podium({
  members,
  formatValue,
  subtitle,
}: {
  members: LeaderboardMember[];
  formatValue: (m: LeaderboardMember) => string;
  subtitle?: (m: LeaderboardMember) => string;
}) {
  const top3 = useMemo(() => members.slice(0, 3), [members]);

  if (top3.length === 0) {
    return (
      <p className="text-center text-muted-foreground py-8">
        No tracked data available yet. Run Sync Now or wait for the next automatic update.
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
});

const LeaderboardTable = memo(function LeaderboardTable({
  members,
  columns,
}: {
  members: LeaderboardMember[];
  columns: {
    header: string;
    value: (m: LeaderboardMember) => ReactNode;
    className?: string;
  }[];
}) {
  const PAGE_SIZE = 10;
  const [page, setPage] = useState(0);
  const rest = useMemo(() => members.slice(3), [members]);
  const totalPages = Math.max(1, Math.ceil(rest.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const paginated = useMemo(
    () => rest.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [safePage, rest]
  );

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
                  <RankBadge rank={safePage * PAGE_SIZE + i + 4} />
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
              disabled={safePage === 0}
              className="h-7 px-2 text-xs"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              className="h-7 px-2 text-xs"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});

const categories = [
  {
    key: "trophyLeaders" as const,
    label: "Trophies",
    icon: Trophy,
    description: () => "Current trophy rankings",
    help: () => "Sorted by each member's current trophy total. Time range does not change this tab.",
    formatValue: (m: LeaderboardMember) => formatNumber(m.trophies),
    subtitle: (m: LeaderboardMember) => `Peak: ${formatNumber(m.highestTrophies)}`,
    columns: [
      { header: "Trophies", value: (m: LeaderboardMember) => formatNumber(m.trophies), className: "text-right" },
      { header: "Peak", value: (m: LeaderboardMember) => formatNumber(m.highestTrophies), className: "text-right" },
      { header: "Brawlers", value: (m: LeaderboardMember) => m.brawlersCount, className: "text-right" },
    ],
  },
  {
    key: "weeklyTrophyGainers" as const,
    label: "Progress",
    icon: TrendingUp,
    description: (rangeLabel: string) => `Best trophy movement over the ${rangeLabel}`,
    help: () => "Net trophies means gained minus lost. Players with missing progress data are not ranked here.",
    formatValue: (m: LeaderboardMember) => {
      const n = m.weekly.netTrophies;
      if (n == null) return "No data";
      return n >= 0 ? `+${n}` : `${n}`;
    },
    subtitle: (m: LeaderboardMember) => `${formatNumber(m.trophies)} current trophies`,
    columns: [
      {
        header: "Net",
        value: (m: LeaderboardMember) => {
          const n = m.weekly.netTrophies;
          if (n == null) return <span className="text-muted-foreground">No data</span>;
          const color = n > 0 ? "text-green-500" : n < 0 ? "text-red-500" : "";
          return <span className={`font-semibold ${color}`}>{n >= 0 ? `+${n}` : n}</span>;
        },
        className: "text-right",
      },
      { header: "Current", value: (m: LeaderboardMember) => formatNumber(m.trophies), className: "text-right" },
      { header: "Peak", value: (m: LeaderboardMember) => formatNumber(m.highestTrophies), className: "text-right" },
    ],
  },
  {
    key: "weeklyBattlers" as const,
    label: "Battles",
    icon: Swords,
    description: (rangeLabel: string) => `Most battles played in the ${rangeLabel}`,
    help: () => "Counts tracked battles stored by BrawlStatz syncs for the selected range.",
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
    description: (rangeLabel: string) => `Highest win rate in the ${rangeLabel}`,
    help: (_rangeLabel: string, minBattles: number) => `Only players with at least ${minBattles} tracked battles are ranked here.`,
    formatValue: (m: LeaderboardMember) => `${m.weekly.winRate}%`,
    subtitle: (m: LeaderboardMember) => `${m.weekly.battles} battles`,
    columns: [
      { header: "Win %", value: (m: LeaderboardMember) => <span className="font-semibold">{m.weekly.winRate}%</span>, className: "text-right" },
      { header: "W / L", value: (m: LeaderboardMember) => `${m.weekly.wins} / ${m.weekly.losses}`, className: "text-right" },
      { header: "Battles", value: (m: LeaderboardMember) => m.weekly.battles, className: "text-right" },
    ],
  },
  {
    key: "weeklyStarPlayers" as const,
    label: "Stars",
    icon: Star,
    description: (rangeLabel: string) => `Most Star Player awards in the ${rangeLabel}`,
    help: () => "Counts tracked Star Player awards from stored battle history.",
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
    description: (rangeLabel: string) => `Most active members in the ${rangeLabel}`,
    help: () => "Activity means days with at least one tracked battle. It is capped by the selected range, so 24h maxes at 1 day, 3d at 3 days, and 7d at 7 days.",
    formatValue: (m: LeaderboardMember) => `${m.weekly.activeDays}d`,
    subtitle: (m: LeaderboardMember) => `${m.weekly.battles} battles`,
    columns: [
      { header: "Active Days", value: (m: LeaderboardMember) => m.weekly.activeDays, className: "text-right" },
      { header: "Battles", value: (m: LeaderboardMember) => m.weekly.battles, className: "text-right" },
      { header: "Last Battle", value: (m: LeaderboardMember) => formatRelativeTime(m.lastBattleAt), className: "text-right" },
    ],
  },
  {
    key: "allTimeBattlers" as const,
    label: "Battle Records",
    icon: Zap,
    description: () => "Battle totals recorded by BrawlStatz syncs",
    help: () => "This is app-recorded history, not the player's full lifetime Brawl Stars history.",
    formatValue: (m: LeaderboardMember) => formatNumber(m.allTime.battles),
    subtitle: (m: LeaderboardMember) => {
      const draws = m.allTime.battles - m.allTime.wins - m.allTime.losses;
      return draws > 0 ? `${m.allTime.wins}W / ${m.allTime.losses}L / ${draws}D` : `${m.allTime.wins}W / ${m.allTime.losses}L`;
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
  const [rangeMeta, setRangeMeta] = useState<LeaderboardResponse["range"]>({
    key: "7d",
    label: "last 7 days",
    minWinRateBattles: 10,
  });
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("trophyLeaders");
  const [selectedRange, setSelectedRange] = useState<RangeKey>("7d");
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [minBattles, setMinBattles] = useState("");

  const loadLeaderboard = useCallback(async (force = false) => {
    try {
      const data = await fetchJsonCached<LeaderboardResponse>(
        `/api/leaderboard?range=${selectedRange}`,
        { staleMs: 60_000, force }
      );
      setLeaderboards(data.leaderboards);
      setMemberCount(data.memberCount || 0);
      if (data.range) setRangeMeta(data.range);
      setLastSyncTime(data.lastSyncTime || null);
    } catch (err) {
      console.error("Error loading leaderboard:", err);
    } finally {
      setIsLoading(false);
    }
  }, [selectedRange]);

  useEffect(() => {
    setIsLoading(true);
    loadLeaderboard();
  }, [loadLeaderboard]);

  useEffect(() => {
    const handleClubDataUpdated = () => {
      loadLeaderboard(true);
    };
    window.addEventListener("club-data-updated", handleClubDataUpdated);
    return () => window.removeEventListener("club-data-updated", handleClubDataUpdated);
  }, [loadLeaderboard]);

  const minBattlesValue = useMemo(() => {
    const parsed = Number.parseInt(minBattles, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [minBattles]);

  const filterMembers = useCallback((items: LeaderboardMember[]) => {
    const search = searchQuery.trim().toLowerCase();
    return items.filter((member) => {
      if (search) {
        const name = member.name.toLowerCase();
        const tag = member.tag.toLowerCase();
        if (!name.includes(search) && !tag.includes(search)) return false;
      }

      if (roleFilter !== "all" && normalizeRole(member.role) !== roleFilter) return false;
      if (activityFilter !== "all" && member.activityStatus !== activityFilter) return false;
      if (minBattlesValue != null && member.weekly.battles < minBattlesValue) return false;

      return true;
    });
  }, [activityFilter, minBattlesValue, roleFilter, searchQuery]);

  const resetFilters = () => {
    setSearchQuery("");
    setRoleFilter("all");
    setActivityFilter("all");
    setMinBattles("");
  };

  const rangeLabel = rangeMeta?.label || "selected range";
  const minWinRateBattles = rangeMeta?.minWinRateBattles || 10;

  return (
    <LayoutWrapper>
      <div className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Trophy className="h-6 w-6 text-yellow-500" />
              Club Leaderboard
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{memberCount} members tracked</span>
              <span className="inline-flex items-center gap-1.5">
                <Clock3 className="h-3.5 w-3.5" />
                {formatSyncTime(lastSyncTime)}
              </span>
            </p>
          </div>

          <div className="flex w-full flex-wrap gap-2 lg:w-auto lg:justify-end">
            {rangeOptions.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setSelectedRange(option.key)}
                className={`h-9 rounded-lg border px-3 text-sm font-semibold transition-colors ${
                  selectedRange === option.key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card/40 p-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search player or tag"
                className="h-10 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-3 xl:flex xl:items-center">
              <label className="flex items-center gap-2 rounded-md border border-border bg-background px-3">
                <Filter className="h-4 w-4 text-muted-foreground" />
                <select
                  value={roleFilter}
                  onChange={(event) => setRoleFilter(event.target.value as RoleFilter)}
                  className="h-10 bg-transparent text-sm outline-none"
                  aria-label="Filter by role"
                >
                  {roleOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              <select
                value={activityFilter}
                onChange={(event) => setActivityFilter(event.target.value as ActivityFilter)}
                className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                aria-label="Filter by activity"
              >
                {activityOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>

              <input
                value={minBattles}
                onChange={(event) => setMinBattles(event.target.value)}
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="Min battles"
                className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
                aria-label="Minimum tracked battles"
              />
            </div>

            {(searchQuery || roleFilter !== "all" || activityFilter !== "all" || minBattles) && (
              <Button variant="outline" size="sm" onClick={resetFilters} className="h-10">
                Reset
              </Button>
            )}
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
                return (
                  <TabsTrigger
                    key={cat.key}
                    value={cat.key}
                    className="flex items-center gap-1.5 px-3 py-2 data-[state=active]:bg-accent rounded-lg border border-border/60 data-[state=active]:border-border text-xs sm:text-sm"
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{cat.label}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>

            {categories.map((cat) => {
              const rawData = leaderboards[cat.key] || [];
              const data = filterMembers(rawData);
              return (
                <TabsContent key={cat.key} value={cat.key} className="space-y-4 mt-4">
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex items-start gap-2">
                          <cat.icon className="mt-1 h-5 w-5 text-muted-foreground" />
                          <div>
                            <CardTitle className="text-lg">{cat.label}</CardTitle>
                            <CardDescription>{cat.description(rangeLabel)}</CardDescription>
                            <p className="mt-1 text-xs text-muted-foreground">{cat.help(rangeLabel, minWinRateBattles)}</p>
                          </div>
                        </div>
                        <div className="text-sm text-muted-foreground sm:text-right">
                          <p>
                            <span className="font-semibold text-foreground">{data.length}</span> shown
                            {data.length !== rawData.length && ` / ${rawData.length}`}
                          </p>
                          {cat.key !== "trophyLeaders" && cat.key !== "allTimeBattlers" && (
                            <p>{rangeLabel}</p>
                          )}
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
