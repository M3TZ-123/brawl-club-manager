"use client";
import { T, useI18n } from "@/components/locale-provider";


import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { DataConfidenceNotice } from "@/components/sync-health";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { fetchJsonCached } from "@/lib/client-data-cache";
import { TimeRangePicker } from "@/components/time-range-picker";
import { ClubActivityCalendar } from "@/components/club-activity-calendar";
import { TIME_RANGES, type TimeRangeKey } from "@/lib/time-range";
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
  Search,
  Filter,
} from "lucide-react";

type ActivityFilter = "all" | "active" | "minimal" | "inactive";
type RoleFilter = "all" | "president" | "vicepresident" | "senior" | "member";

interface LeaderboardMember {
  tag: string;
  name: string;
  role: string;
  trophies: number;
  highestTrophies: number;
  brawlersCount: number;
  activityStatus: "active" | "minimal" | "inactive";
  lastBattleAt: string | null;
  weekly: {
    battles: number;
    wins: number;
    losses: number;
    starPlayer: number;
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
}

interface LeaderboardResponse {
  period?: { start: string; end: string };
  leaderboards: Leaderboards;
  memberCount?: number;
  range?: {
    key: TimeRangeKey;
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







function normalizeRole(role: string) {
  return role.toLowerCase().replace(/\s+/g, "");
}

const Podium = memo(function Podium({
  members,
  formatValue,
  subtitle,
  emptyText,
}: {
  members: LeaderboardMember[];
  formatValue: (m: LeaderboardMember) => string;
  subtitle?: (m: LeaderboardMember) => string;
  emptyText: string;
}) {
  const top3 = useMemo(() => members.slice(0, 3), [members]);

  if (top3.length === 0) {
    return (
      <p className="text-center text-muted-foreground py-8">
        <T text={emptyText} /></p>
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
              <TableHead><T text="Player" /></TableHead>
              {columns.map((col) => (
                <TableHead key={col.header} className={col.className}>
                  <T text={col.header} />
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
              <T text=" Previous " /></Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              className="h-7 px-2 text-xs"
            >
              <T text=" Next " /></Button>
          </div>
        </div>
      )}
    </div>
  );
});

function useCategories() {
  const { t, number: formatNumber, relative: formatRelativeTime } = useI18n();
  return [
  {
    key: "trophyLeaders" as const,
    label: "Trophies",
    icon: Trophy,
    description: () => t("Current trophy rankings"),
    help: () => t("Sorted by each member's current trophy total. Time range does not change this tab."),
    formatValue: (m: LeaderboardMember) => formatNumber(m.trophies),
    subtitle: (m: LeaderboardMember) => t("Peak: {value0}", { value0: formatNumber(m.highestTrophies) }),
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
    description: (rangeLabel: string) => t("Best trophy movement over the {value0}", { value0: rangeLabel }),
    help: () => t("Net trophies means gained minus lost. Players with missing progress data are not ranked here."),
    formatValue: (m: LeaderboardMember) => {
      const n = m.weekly.netTrophies;
      if (n == null) return t("No data");
      return n >= 0 ? `+${n}` : `${n}`;
    },
    subtitle: (m: LeaderboardMember) => t("{value0} current trophies", { value0: formatNumber(m.trophies) }),
    columns: [
      {
        header: "Net",
        value: (m: LeaderboardMember) => {
          const n = m.weekly.netTrophies;
          if (n == null) return <span className="text-muted-foreground"><T text="No data" /></span>;
          const color = n > 0 ? "text-green-500" : n < 0 ? "text-red-500" : "";
          return <span className={`font-semibold ${color}`}>{n >= 0 ? <T text="+{value0}" values={{ value0: String(n) }} /> : n}</span>;
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
    description: (rangeLabel: string) => t("Most battles played in the {value0}", { value0: rangeLabel }),
    help: () => t("Based on recorded battles in this period."),
    formatValue: (m: LeaderboardMember) => m.weekly.battles.toString(),
    subtitle: (m: LeaderboardMember) => {
      // The summary does not distinguish explicit draws from unknown results.
      const other = Math.max(0, m.weekly.battles - m.weekly.wins - m.weekly.losses);
      return t(other > 0 ? "{wins} wins · {losses} losses · {other} other results" : "{wins} wins · {losses} losses", {
        wins: formatNumber(m.weekly.wins), losses: formatNumber(m.weekly.losses), other: formatNumber(other),
      });
    },
    columns: [
      { header: "Battles", value: (m: LeaderboardMember) => m.weekly.battles, className: "text-right" },
      { header: "Wins", value: (m: LeaderboardMember) => m.weekly.wins, className: "text-right" },
      { header: "Win %", value: (m: LeaderboardMember) => t("{value0}%", { value0: m.weekly.winRate }), className: "text-right" },
    ],
  },
  {
    key: "weeklyWinRate" as const,
    label: "Win Rate",
    icon: Target,
    description: (rangeLabel: string) => t("Highest win rate in the {value0}", { value0: rangeLabel }),
    help: (_rangeLabel: string, minBattles: number) => t("Only players with at least {value0} tracked battles are ranked here.", { value0: minBattles }),
    formatValue: (m: LeaderboardMember) => t("{value0}%", { value0: m.weekly.winRate }),
    subtitle: (m: LeaderboardMember) => t("{value0} battles", { value0: m.weekly.battles }),
    columns: [
      { header: "Win %", value: (m: LeaderboardMember) => <span className="font-semibold">{m.weekly.winRate}%</span>, className: "text-right" },
      { header: "W / L", value: (m: LeaderboardMember) => t("{value0} / {value1}", { value0: m.weekly.wins, value1: m.weekly.losses }), className: "text-right" },
      { header: "Battles", value: (m: LeaderboardMember) => m.weekly.battles, className: "text-right" },
    ],
  },
  {
    key: "weeklyStarPlayers" as const,
    label: "Stars",
    icon: Star,
    description: (rangeLabel: string) => t("Most Star Player awards in the {value0}", { value0: rangeLabel }),
    help: () => t("Based on recorded battles in this period."),
    formatValue: (m: LeaderboardMember) => t("{value0}", { value0: m.weekly.starPlayer }),
    subtitle: (m: LeaderboardMember) => t("{value0} battles", { value0: m.weekly.battles }),
    columns: [
      { header: "Stars", value: (m: LeaderboardMember) => <span className="font-semibold text-yellow-500">{m.weekly.starPlayer}</span>, className: "text-right" },
      { header: "Battles", value: (m: LeaderboardMember) => m.weekly.battles, className: "text-right" },
      {
        header: "Star %",
        value: (m: LeaderboardMember) => {
          const pct = m.weekly.battles > 0 ? Math.round((m.weekly.starPlayer / m.weekly.battles) * 100) : 0;
          return t("{value0}%", { value0: pct });
        },
        className: "text-right",
      },
    ],
  },
  {
    key: "mostActive" as const,
    label: "Activity",
    icon: Flame,
    description: (rangeLabel: string) => t("Most active members in the {value0}", { value0: rangeLabel }),
    help: () => t("Days with at least one recorded battle in this period."),
    formatValue: (m: LeaderboardMember) => t("{value0}d", { value0: m.weekly.activeDays }),
    subtitle: (m: LeaderboardMember) => t("{value0} battles", { value0: m.weekly.battles }),
    columns: [
      { header: "Active Days", value: (m: LeaderboardMember) => m.weekly.activeDays, className: "text-right" },
      { header: "Battles", value: (m: LeaderboardMember) => m.weekly.battles, className: "text-right" },
      { header: "Last Battle", value: (m: LeaderboardMember) => formatRelativeTime(m.lastBattleAt), className: "text-right" },
    ],
  },

];
}

export default function LeaderboardPage() {
  const categories = useCategories();
  const { t, reportDate } = useI18n();
  const [period, setPeriod] = useState<LeaderboardResponse["period"]>();
  const [leaderboards, setLeaderboards] = useState<Leaderboards | null>(null);
  const [memberCount, setMemberCount] = useState(0);
  const [rangeMeta, setRangeMeta] = useState<LeaderboardResponse["range"]>({
    key: "7d",
    label: "last 7 days",
    minWinRateBattles: 10,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("weeklyTrophyGainers");
  const [selectedRange, setSelectedRange] = useState<TimeRangeKey>("7d");
  const [loadError, setLoadError] = useState(false);
  const loadSequence = useRef(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [minBattles, setMinBattles] = useState("");

  const loadLeaderboard = useCallback(async (force = false) => {
    const sequence = ++loadSequence.current;
    setLoadError(false);
    setIsLoading(true);
    try {
      const data = await fetchJsonCached<LeaderboardResponse>(
        `/api/leaderboard?range=${selectedRange}`,
        { staleMs: 60_000, force }
      );
      if (sequence !== loadSequence.current) return;
      setLeaderboards(data.leaderboards);
      setPeriod(data.period);
      setMemberCount(data.memberCount || 0);
      if (data.range) setRangeMeta(data.range);
    } catch (err) {
      if (sequence !== loadSequence.current) return;
      setLoadError(true);
      setLeaderboards(null);
      console.error("Error loading leaderboard:", err);
    } finally {
      if (sequence === loadSequence.current) setIsLoading(false);
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

  const battleCategory = activeTab !== "weeklyTrophyGainers" && activeTab !== "trophyLeaders";
  const rangeLabel = selectedRange === "24h" && battleCategory ? "Today (UTC)" : TIME_RANGES[selectedRange].label;
  const minWinRateBattles = rangeMeta?.minWinRateBattles || 10;

  return (
    <LayoutWrapper><DataConfidenceNotice />
      <div className="space-y-4">
        <h1 className="text-2xl font-bold"><T text="Club activity" /></h1>
        <ClubActivityCalendar />
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Trophy className="h-6 w-6 text-yellow-500" />
              <T text=" Club Leaderboard " /></h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {!isLoading && !loadError && <span>{memberCount} <T text="Members" /></span>}
            </p>
          </div>

          <TimeRangePicker value={selectedRange} onChange={range => { if (range !== selectedRange) { setIsLoading(true); setSelectedRange(range); } }} dayBased={battleCategory} />
        </div>

        <div className="rounded-lg border border-border bg-card/40 p-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t("Search player or tag")}
                aria-label={t("Search player or tag")}
                className="h-10 w-full rounded-md border border-border bg-background ps-9 pe-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-3 xl:flex xl:items-center">
              <label className="flex items-center gap-2 rounded-md border border-border bg-background px-3">
                <Filter className="h-4 w-4 text-muted-foreground" />
                <select
                  value={roleFilter}
                  onChange={(event) => setRoleFilter(event.target.value as RoleFilter)}
                  className="h-10 bg-transparent text-sm outline-none"
                  aria-label={t("Filter by role")}
                >
                  {roleOptions.map((option) => (
                    <option key={option.value} value={option.value}>{<T text={option.label} />}</option>
                  ))}
                </select>
              </label>

              <select
                value={activityFilter}
                onChange={(event) => setActivityFilter(event.target.value as ActivityFilter)}
                className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none"
                aria-label={t("Filter by activity")}
              >
                {activityOptions.map((option) => (
                  <option key={option.value} value={option.value}>{<T text={option.label} />}</option>
                ))}
              </select>

              <input
                value={minBattles}
                onChange={(event) => setMinBattles(event.target.value)}
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder={t("Min battles")}
                className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
                aria-label={t("Minimum tracked battles")}
              />
            </div>

            {(searchQuery || roleFilter !== "all" || activityFilter !== "all" || minBattles) && (
              <Button variant="outline" size="sm" onClick={resetFilters} className="h-10">
                <T text=" Reset " /></Button>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : loadError || !leaderboards ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <p role="alert"><T text="Could not load the leaderboard." /></p>
              <Button variant="outline" className="mt-3" onClick={() => loadLeaderboard(true)}><T text="Retry" /></Button>
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
                    <span>{<T text={cat.label} />}</span>
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
                            <CardTitle className="text-lg">{<T text={cat.label} />}</CardTitle>
                            <CardDescription>{cat.description(t(rangeLabel))}</CardDescription>
                            <p className="mt-1 text-xs text-muted-foreground">{cat.help(t(rangeLabel), minWinRateBattles)}</p>
                          </div>
                        </div>
                        <div className="text-sm text-muted-foreground sm:text-end">
                          <p>
                            <span className="font-semibold text-foreground">{data.length}</span> <T text=" shown " />{data.length !== rawData.length && ` / ${rawData.length}`}
                          </p>
                          {cat.key !== "trophyLeaders" && (
                            <p><T text={rangeLabel} />{battleCategory && period && <span className="block">{reportDate(period.start)} – {reportDate(period.end)} (UTC)</span>}</p>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <Podium
                        members={data}
                        formatValue={cat.formatValue}
                        subtitle={cat.subtitle}
                        emptyText={rawData.length > 0 ? "No members match these filters." : cat.key === "trophyLeaders" ? "No current members found." : "No recorded results for this period."}
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
