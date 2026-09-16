"use client";
import { T, useI18n } from "@/components/locale-provider";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { DataConfidenceNotice } from "@/components/sync-health";
import { MemberReviewButton } from "@/components/member-review";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { TimeRangePicker } from "@/components/time-range-picker";
import { TIME_RANGES, type TimeRangeKey } from "@/lib/time-range";
import {
  DEFAULT_MEMBER_COLUMNS,
  MembersTable,
  type ActivityStatus,
  type MemberColumnKey,
  type MemberColumnVisibility,
  type MemberSortKey,
  type MemberSortState,
  type MemberWithGains,
} from "@/components/members-table";
import { fetchJsonCached, invalidateJsonCache } from "@/lib/client-data-cache";
import { useAppStore } from "@/lib/store";
import { useAdminSession } from "@/hooks/use-admin-session";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertTriangle,
  Check,
  CircleMinus,
  Columns3,
  Copy,
  Download,
  ExternalLink,
  Filter,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trophy,
  TrendingUp,
  Users,
} from "lucide-react";

type QuickFilter = "all" | "attention" | "top-gainers" | "no-progress";
type RoleFilter = "all" | "president" | "vicepresident" | "senior" | "member";
type ActivityFilter = "all" | ActivityStatus | "unknown";
type MovementFilter = "all" | "positive" | "flat" | "unknown";
import { rankMatches, type RankFilter } from "@/lib/rank-filter";

const ROLE_ORDER = ["president", "vicepresident", "senior", "member"];
const ACTIVITY_ORDER: Record<ActivityFilter, number> = {
  active: 0,
  minimal: 1,
  inactive: 2,
  unknown: 3,
  all: 4,
};

const COLUMN_OPTIONS: Array<{ key: MemberColumnKey; label: string; description: string }> = [
  { key: "role", label: "Role", description: "Club permission level" },
  { key: "trophies", label: "Trophies", description: "Current trophy count" },
  { key: "progress", label: "Trophy progress", description: "Follows the selected period" },
  { key: "trophies_24h", label: "24h", description: "One-day trophy progress" },
  { key: "trophies_3d", label: "3 days", description: "Short-term trophy progress" },
  { key: "trophies_7d", label: "7 days", description: "Weekly trophy progress" },
  { key: "trophies_30d", label: "1 month", description: "30-day comparison" },
  { key: "trophies_90d", label: "3 months", description: "90-day comparison" },
  { key: "activity", label: "Activity", description: "Readable status badge" },
  { key: "last_battle", label: "Last Battle", description: "Most recent tracked battle" },
  { key: "highest_trophies", label: "Highest", description: "Personal best trophies" },
  { key: "win_rate", label: "Win Rate", description: "Tracked battle win rate" },
  { key: "rank_current", label: "Current Rank", description: "Current ranked tier" },
  { key: "rank_highest", label: "Best Rank", description: "Best ranked tier" },
  { key: "brawlers_count", label: "Brawlers", description: "Unlocked brawler count" },
  { key: "trio_victories", label: "3v3 Wins", description: "Total 3v3 victories" },
];

function getActivityStatus(member: MemberWithGains): ActivityFilter {
  return member.activity_status || "unknown";
}

function getActivityLabel(status: ActivityFilter) {
  if (status === "active") return "Active";
  if (status === "minimal") return "Low activity";
  if (status === "inactive") return "Inactive";
  if (status === "unknown") return "No data";
  return "All";
}

function getActivityClass(status: ActivityFilter) {
  if (status === "active") return "border-green-500/30 bg-green-500/10 text-green-400";
  if (status === "minimal") return "border-yellow-500/30 bg-yellow-500/10 text-yellow-300";
  if (status === "inactive") return "border-red-500/30 bg-red-500/10 text-red-300";
  return "border-border bg-muted/40 text-muted-foreground";
}

function getProgress(member: MemberWithGains, timeRange: TimeRangeKey) {
  return member[TIME_RANGES[timeRange].metric];
}

function hasGain(member: MemberWithGains, timeRange: TimeRangeKey) {
  const change = getProgress(member, timeRange);
  return change != null && change > 0;
}

function hasNoProgress(member: MemberWithGains, timeRange: TimeRangeKey) {
  return getProgress(member, timeRange) === 0;
}

function needsAttention(member: MemberWithGains, timeRange: TimeRangeKey) {
  const status = getActivityStatus(member);
  return status === "minimal" || status === "inactive" || hasNoProgress(member, timeRange);
}

function getSortValue(member: MemberWithGains, key: MemberSortKey, timeRange: TimeRangeKey): string | number | null {
  switch (key) {
    case "player_name":
      return member.player_name.toLowerCase();
    case "role": {
      const index = ROLE_ORDER.indexOf(member.role.toLowerCase());
      return index === -1 ? ROLE_ORDER.length : index;
    }
    case "trophies":
      return member.trophies;
    case "highest_trophies":
      return member.highest_trophies;
    case "win_rate":
      return member.win_rate;
    case "rank_current":
      return member.rank_current?.toLowerCase() || null;
    case "rank_highest":
      return member.rank_highest?.toLowerCase() || null;
    case "trophies_24h":
      return member.trophies_24h ?? null;
    case "trophies_3d":
      return member.trophies_3d ?? null;
    case "trophies_7d":
      return member.trophies_7d ?? null;
    case "trophies_30d":
      return member.trophies_30d ?? null;
    case "trophies_90d":
      return member.trophies_90d ?? null;
    case "progress":
      return getProgress(member, timeRange) ?? null;
    case "activity_status":
      return ACTIVITY_ORDER[getActivityStatus(member)];
    case "last_battle_at":
      return member.last_battle_at ? new Date(member.last_battle_at).getTime() : null;
    case "brawlers_count":
      return member.brawlers_count;
    case "trio_victories":
      return member.trio_victories;
  }
}

function compareMembers(a: MemberWithGains, b: MemberWithGains, sort: MemberSortState, timeRange: TimeRangeKey) {
  const aValue = getSortValue(a, sort.key, timeRange);
  const bValue = getSortValue(b, sort.key, timeRange);

  if (aValue == null && bValue == null) return 0;
  if (aValue == null) return 1;
  if (bValue == null) return -1;

  let result = 0;
  if (typeof aValue === "number" && typeof bValue === "number") {
    result = aValue - bValue;
  } else {
    result = String(aValue).localeCompare(String(bValue));
  }

  return sort.direction === "asc" ? result : -result;
}



function getDeltaClass(value: number | null | undefined) {
  if (value == null || value === 0) return "text-muted-foreground";
  return value > 0 ? "text-green-500" : "text-red-400";
}





function getRankLabel(filter: RankFilter) {
  const labels: Record<RankFilter, string> = {
    all: "All ranks",
    pro: "Pro",
    masters: "Masters",
    legendary: "Legendary",
    mythic: "Mythic",
    diamond: "Diamond",
    gold: "Gold",
    lower: "Silver / Bronze",
    unranked: "Unranked",
    unknown: "Unknown",
  };
  return labels[filter];
}

function SummaryCard({
  title,
  value,
  description,
  icon: Icon,
  tone,
  className,
}: {
  title: string;
  value: string | number;
  description: string;
  icon: React.ElementType;
  tone: string;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-center justify-between gap-2 sm:gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground sm:text-sm">{title}</p>
            <p className="mt-1 text-lg font-bold sm:mt-2 sm:text-2xl">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
          <Icon className={cn("h-4 w-4 shrink-0 sm:h-5 sm:w-5", tone)} />
        </div>
      </CardContent>
    </Card>
  );
}

function sanitizeCsvValue(value: string | number | boolean | null | undefined) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export default function MembersPage() {
  const { number: formatNumber, delta: formatDelta, relative: formatRelativeTime, dateTime: formatDateTime } = useI18n();
  const { t, direction } = useI18n();
  const {
    setLastSyncTime,
    clubTag,
    apiKeyConfigured,
    isSyncing,
    setIsSyncing,
  } = useAppStore();
  const { isAdmin, isLoading: isAdminLoading } = useAdminSession();
  const [members, setMembers] = useState<MemberWithGains[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRangeKey>("7d");
  const period = TIME_RANGES[timeRange];
  const progressLabel = t("Progress · {period}", { period: t(period.shortLabel) });
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [movementFilter, setMovementFilter] = useState<MovementFilter>("all");
  const [rankFilter, setRankFilter] = useState<RankFilter>("all");
  const [minTrophies, setMinTrophies] = useState("");
  const [maxTrophies, setMaxTrophies] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState<MemberColumnVisibility>(DEFAULT_MEMBER_COLUMNS);
  const [sortState, setSortState] = useState<MemberSortState>({ key: "progress", direction: "desc" });
  const [selectedMember, setSelectedMember] = useState<MemberWithGains | null>(null);
  const [copied, setCopied] = useState<"tag" | null>(null);
  const copyResetTimeoutRef = useRef<number | null>(null);

  const loadMembers = useCallback(async (force = false) => {
    try {
      setErrorMessage(null);
      setIsRefreshing(true);
      if (!force) {
        setIsLoading(true);
      }
      if (force) {
        invalidateJsonCache("/api/members");
      }

      const membersData = await fetchJsonCached<{ members: MemberWithGains[] }>("/api/members", { staleMs: 30_000, force });
      setMembers(membersData.members || []);
    } catch (error) {
      console.error("Error loading members:", error);
      setErrorMessage(error instanceof Error ? error.message : "Failed to load members");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    const handleClubDataUpdated = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.source === "members-page") {
        return;
      }
      loadMembers(true);
    };
    window.addEventListener("club-data-updated", handleClubDataUpdated);
    return () => window.removeEventListener("club-data-updated", handleClubDataUpdated);
  }, [loadMembers]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
    };
  }, []);

  const quickFilters = useMemo(() => [
    { id: "all" as const, label: "All", count: members.length, icon: Users },
    { id: "top-gainers" as const, label: "Gained trophies", count: members.filter(member => hasGain(member, timeRange)).length, icon: TrendingUp },
    { id: "no-progress" as const, label: "No Progress", count: members.filter(member => hasNoProgress(member, timeRange)).length, icon: CircleMinus },
    { id: "attention" as const, label: "Needs Attention", count: members.filter(member => needsAttention(member, timeRange)).length, icon: AlertTriangle },
  ], [members, timeRange]);

  const filteredMembers = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const min = minTrophies.trim() ? Number.parseInt(minTrophies, 10) : null;
    const max = maxTrophies.trim() ? Number.parseInt(maxTrophies, 10) : null;

    return members
      .filter((member) => {
        if (normalizedSearch) {
          const name = member.player_name.toLowerCase();
          const tag = member.player_tag.toLowerCase();
          if (!name.includes(normalizedSearch) && !tag.includes(normalizedSearch)) {
            return false;
          }
        }

        if (quickFilter === "attention" && !needsAttention(member, timeRange)) return false;
        if (quickFilter === "top-gainers" && !hasGain(member, timeRange)) return false;
        if (quickFilter === "no-progress" && !hasNoProgress(member, timeRange)) return false;

        if (roleFilter !== "all" && member.role.toLowerCase() !== roleFilter) return false;
        if (activityFilter !== "all" && getActivityStatus(member) !== activityFilter) return false;
        if (!rankMatches(member.rank_current, rankFilter)) return false;

        if (movementFilter === "positive" && !hasGain(member, timeRange)) return false;
        if (movementFilter === "flat" && !hasNoProgress(member, timeRange)) return false;
        if (movementFilter === "unknown" && getProgress(member, timeRange) != null) return false;

        if (min != null && Number.isFinite(min) && member.trophies < min) return false;
        if (max != null && Number.isFinite(max) && member.trophies > max) return false;

        return true;
      })
      .sort((a, b) => compareMembers(a, b, sortState, timeRange));
  }, [
    activityFilter,
    maxTrophies,
    members,
    minTrophies,
    movementFilter,
    quickFilter,
    rankFilter,
    roleFilter,
    searchQuery,
    sortState,
    timeRange,
  ]);

  const summary = useMemo(() => {
    const known = filteredMembers.filter(member => getProgress(member, timeRange) != null);
    return {
      progress: known.length ? known.reduce((sum, member) => sum + getProgress(member, timeRange)!, 0) : null,
      known: known.length,
      gained: filteredMembers.filter(member => hasGain(member, timeRange)).length,
    };
  }, [filteredMembers, timeRange]);

  const hasAdvancedFilters = roleFilter !== "all"
    || activityFilter !== "all"
    || movementFilter !== "all"
    || rankFilter !== "all"
    || minTrophies.trim() !== ""
    || maxTrophies.trim() !== "";

  const handleSort = (key: MemberSortKey) => {
    setSortState((current) => {
      if (current.key === key) {
        return { key, direction: current.direction === "asc" ? "desc" : "asc" };
      }
      const defaultAscending = key === "player_name" || key === "role" || key === "activity_status";
      return { key, direction: defaultAscending ? "asc" : "desc" };
    });
  };

  const handleQuickFilter = (filter: QuickFilter) => {
    setQuickFilter(filter);
    if (filter === "top-gainers") {
      setSortState({ key: "progress", direction: "desc" });
    } else if (filter === "no-progress") {
      setSortState({ key: "progress", direction: "asc" });
    } else if (filter === "attention") {
      setSortState({ key: "activity_status", direction: "asc" });
    }
  };

  const resetAdvancedFilters = () => {
    setRoleFilter("all");
    setActivityFilter("all");
    setMovementFilter("all");
    setRankFilter("all");
    setMinTrophies("");
    setMaxTrophies("");
  };

  const toggleColumn = (key: MemberColumnKey, checked: boolean) => {
    setColumnVisibility((current) => ({
      ...current,
      [key]: checked,
    }));
  };

  const copyText = async (text: string, copiedType: "tag") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(copiedType);
      if (copyResetTimeoutRef.current) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopied(null);
        copyResetTimeoutRef.current = null;
      }, 1400);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  const handleSyncNow = async () => {
    if (!isAdmin) return;
    if (!clubTag || !apiKeyConfigured) {
      setErrorMessage("Club tag and API key must be configured before syncing.");
      return;
    }

    try {
      setErrorMessage(null);
      setIsSyncing(true);
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clubTag }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || data.message || "Sync failed");
      }

      invalidateJsonCache();
      const syncTime = typeof data.timestamp === "string" ? data.timestamp : new Date().toISOString();
      setLastSyncTime(syncTime);
      await loadMembers(true);
      window.dispatchEvent(new CustomEvent("club-data-updated", {
        detail: { changes: data.changes, source: "members-page", syncTime },
      }));
    } catch (error) {
      console.error("Sync failed:", error);
      setErrorMessage(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleExport = () => {
    const comparisons = Object.values(TIME_RANGES).filter(range => columnVisibility[range.metric] && range.metric !== period.metric);
    const csv = [
      [
        "Tag",
        "Name",
        "Role",
        "Trophies",
        "Highest",
        t("Trophy progress · {period}", { period: t(period.label) }),
        ...comparisons.map(range => t("Trophy progress · {period}", { period: t(range.label) })),
        "Activity",
        "Last Battle",
        "Win Rate",
        "Current Rank",
        "Best Rank",
        "Brawlers",
        "3v3 Wins",
      ].map(header => sanitizeCsvValue(t(header))).join(","),
      ...filteredMembers.map((member) => [
        sanitizeCsvValue(member.player_tag),
        sanitizeCsvValue(member.player_name),
        sanitizeCsvValue(member.role),
        sanitizeCsvValue(member.trophies),
        sanitizeCsvValue(member.highest_trophies),
        sanitizeCsvValue(getProgress(member, timeRange)),
        ...comparisons.map(range => sanitizeCsvValue(member[range.metric])),
        sanitizeCsvValue(t(getActivityLabel(getActivityStatus(member)))),
        sanitizeCsvValue(member.last_battle_at || ""),
        sanitizeCsvValue(member.win_rate),
        sanitizeCsvValue(member.rank_current),
        sanitizeCsvValue(member.rank_highest),
        sanitizeCsvValue(member.brawlers_count),
        sanitizeCsvValue(member.trio_victories),
      ].join(",")),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `club-members-${timeRange}-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <LayoutWrapper>
      <div className="space-y-6"><DataConfidenceNotice />
        <Card>
          <CardHeader>
            <div className="space-y-4">
              <div>
                <CardTitle><T text="Members" /></CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  <T text="Choose a period to compare trophy progress." /></p>
              </div>

              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="relative min-w-0 lg:w-72">
                  <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={t("Search name or tag...")}
                    aria-label={t("Search name or tag...")}
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    className="ps-10"
                  />
                </div>
                <TimeRangePicker value={timeRange} onChange={setTimeRange} />
              </div>
              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                <Button
                  variant={showFilters || hasAdvancedFilters ? "default" : "outline"}
                  onClick={() => setShowFilters((value) => !value)}
                  aria-expanded={showFilters}
                  aria-controls="member-advanced-filters"
                  size="sm"
                  className="gap-2"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  <T text="Advanced Filters" /></Button>
                <Button
                  variant={showColumns ? "default" : "outline"}
                  onClick={() => setShowColumns((value) => !value)}
                  aria-expanded={showColumns}
                  aria-controls="member-visible-columns"
                  size="sm"
                  className="gap-2"
                >
                  <Columns3 className="h-4 w-4" />
                  <T text=" Columns " /></Button>
                {isAdmin && <Button asChild variant="outline" size="sm"><Link href="/reviews"><T text="Member reviews" /></Link></Button>}
                {isAdmin && (
                  <Button
                    variant="outline"
                    onClick={handleSyncNow}
                    size="sm"
                    disabled={isSyncing || isRefreshing || isAdminLoading || !clubTag || !apiKeyConfigured}
                    className="gap-2"
                  >
                    <RefreshCw className={cn("h-4 w-4", (isSyncing || isRefreshing) && "animate-spin")} />
                    {isSyncing ? <T text="Syncing" /> : <T text="Sync Now" />}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={handleExport}
                  size="sm"
                  disabled={filteredMembers.length === 0}
                  className="gap-2"
                >
                  <Download className="h-4 w-4" />
                  <T text=" Export " /></Button>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
              <SummaryCard
                title={t("Members shown")}
                value={formatNumber(filteredMembers.length)}
                description={t("{count} members in the club", { count: formatNumber(members.length) })}
                icon={Users}
                tone="text-blue-500"
              />
              <SummaryCard
                title={progressLabel}
                className="order-last col-span-2 sm:order-none sm:col-span-1"
                value={summary.progress == null ? t("Not enough history") : formatDelta(summary.progress)}
                description={t("{known} of {total} members have period data", { known: formatNumber(summary.known), total: formatNumber(filteredMembers.length) })}
                icon={Trophy}
                tone="text-yellow-500"
              />
              <SummaryCard
                title={t("Gained trophies")}
                value={formatNumber(summary.gained)}
                description={t(period.label)}
                icon={TrendingUp}
                tone="text-green-500"
              />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {quickFilters.map((filter) => {
                const Icon = filter.icon;
                const isActive = quickFilter === filter.id;
                return (
                  <button
                    key={filter.id}
                    type="button"
                    onClick={() => handleQuickFilter(filter.id)}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {<T text={filter.label} />}
                    <span className={cn("rounded-full px-2 py-0.5 text-xs", isActive ? "bg-primary-foreground/20" : "bg-muted")}>
                      {formatNumber(filter.count)}
                    </span>
                  </button>
                );
              })}
            </div>

            {showFilters && (
              <div id="member-advanced-filters" className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Filter className="h-4 w-4 text-primary" />
                    <h3 className="font-semibold"><T text="Advanced Filters" /></h3>
                  </div>
                  <Button variant="ghost" size="sm" onClick={resetAdvancedFilters} className="gap-2">
                    <RotateCcw className="h-4 w-4" />
                    <T text=" Reset " /></Button>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground"><T text="Role" /></span>
                    <select
                      value={roleFilter}
                      onChange={(event) => setRoleFilter(event.target.value as RoleFilter)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="all"><T text="All roles" /></option>
                      <option value="president"><T text="President" /></option>
                      <option value="vicepresident"><T text="Vice President" /></option>
                      <option value="senior"><T text="Senior" /></option>
                      <option value="member"><T text="Member" /></option>
                    </select>
                  </label>

                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground"><T text="Recent activity" /></span>
                    <select
                      value={activityFilter}
                      onChange={(event) => setActivityFilter(event.target.value as ActivityFilter)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="all"><T text="All activity" /></option>
                      <option value="active"><T text="Active" /></option>
                      <option value="minimal"><T text="Low activity" /></option>
                      <option value="inactive"><T text="Inactive" /></option>
                      <option value="unknown"><T text="No data" /></option>
                    </select>
                  </label>

                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground">{progressLabel}</span>
                    <select
                      value={movementFilter}
                      onChange={(event) => setMovementFilter(event.target.value as MovementFilter)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="all"><T text="All progress" /></option>
                      <option value="positive"><T text="Gained trophies" /></option>
                      <option value="flat"><T text="No progress" /></option>
                      <option value="unknown"><T text="No data" /></option>
                    </select>
                  </label>

                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground"><T text="Rank" /></span>
                    <select
                      value={rankFilter}
                      onChange={(event) => setRankFilter(event.target.value as RankFilter)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {(["all", "pro", "masters", "legendary", "mythic", "diamond", "gold", "lower", "unranked", "unknown"] as RankFilter[]).map((filter) => (
                        <option key={filter} value={filter}><T text={getRankLabel(filter)} /></option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground"><T text="Min trophies" /></span>
                    <Input
                      inputMode="numeric"
                      value={minTrophies}
                      onChange={(event) => setMinTrophies(event.target.value.replace(/[^\d]/g, ""))}
                      placeholder="0"
                    />
                  </label>

                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground"><T text="Max trophies" /></span>
                    <Input
                      inputMode="numeric"
                      value={maxTrophies}
                      onChange={(event) => setMaxTrophies(event.target.value.replace(/[^\d]/g, ""))}
                      placeholder="120000"
                    />
                  </label>
                </div>
              </div>
            )}

            {showColumns && (
              <div id="member-visible-columns" className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Columns3 className="h-4 w-4 text-primary" />
                    <h3 className="font-semibold"><T text="Visible Columns" /></h3>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setColumnVisibility(DEFAULT_MEMBER_COLUMNS)}
                    className="gap-2"
                  >
                    <RotateCcw className="h-4 w-4" />
                    <T text=" Default " /></Button>
                </div>
                <p className="mb-3 text-xs text-muted-foreground"><T text="Extra period columns are optional comparisons." /></p>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {COLUMN_OPTIONS.map((column) => (
                    <div key={column.key} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/60 p-3">
                      <div>
                        <p className="text-sm font-medium">{<T text={column.label} />}</p>
                        <p className="text-xs text-muted-foreground">{<T text={column.description} />}</p>
                      </div>
                      <Switch
                        checked={columnVisibility[column.key]}
                        onCheckedChange={(checked) => toggleColumn(column.key, checked)}
                        aria-label={t("Toggle {column} column", { column: t(column.label) })}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {errorMessage && (
              <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                <div>
                  <p className="font-semibold"><T text="Members failed to load" /></p>
                  <p className="text-red-100/80">{errorMessage}</p>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>{t("Showing {shown} of {total}", { shown: formatNumber(filteredMembers.length), total: formatNumber(members.length) })}</span>
                <Badge variant="outline">{t(period.label)}</Badge>
                {quickFilter !== "all" && (
                  <Badge variant="secondary">{<T text={quickFilters.find((filter) => filter.id === quickFilter)?.label} />}</Badge>
                )}
                {hasAdvancedFilters && <Badge variant="outline"><T text="Advanced filters active" /></Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                <T text=" Click a row for quick details. Open profile for full history. " /></p>
            </div>

            {isLoading ? (
              <>
                <div className="grid gap-3 md:hidden">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="h-36 animate-pulse rounded-lg bg-muted/50" />
                  ))}
                </div>
                <div className="hidden h-80 items-center justify-center md:flex">
                  <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                </div>
              </>
            ) : (
              <MembersTable
                key={`${timeRange}:${quickFilter}:${searchQuery}:${roleFilter}:${activityFilter}:${movementFilter}:${rankFilter}:${minTrophies}:${maxTrophies}`}
                members={filteredMembers}
                timeRange={timeRange}
                columnVisibility={columnVisibility}
                sortState={sortState}
                onSort={handleSort}
                onMemberSelect={setSelectedMember}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Sheet open={selectedMember != null} onOpenChange={(open) => !open && setSelectedMember(null)}>
        <SheetContent side={direction === "rtl" ? "left" : "right"} className="w-full overflow-y-auto sm:max-w-lg">
          {selectedMember && (
            <>
              <SheetHeader>
                <SheetTitle>{selectedMember.player_name}</SheetTitle>
                <SheetDescription><bdi dir="ltr">{selectedMember.player_tag}</bdi></SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{<T text={selectedMember.role} />}</Badge>
                  <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-semibold", getActivityClass(getActivityStatus(selectedMember)))}>
                    <T text={getActivityLabel(getActivityStatus(selectedMember))} />
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground"><T text="Trophies" /></p>
                    <p className="mt-1 text-xl font-bold">{formatNumber(selectedMember.trophies)}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground"><T text="Highest" /></p>
                    <p className="mt-1 text-xl font-bold">{formatNumber(selectedMember.highest_trophies)}</p>
                  </div>
                  <div className="col-span-2 rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">{t("Trophy progress · {period}", { period: t(period.label) })}</p>
                    <p className={cn("mt-1 text-xl font-bold", getDeltaClass(getProgress(selectedMember, timeRange)))}>
                      {getProgress(selectedMember, timeRange) == null ? t("Not enough history") : formatDelta(getProgress(selectedMember, timeRange))}
                    </p>
                  </div>
                </div>

                <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground"><T text="Last battle" /></span>
                    <span className="text-end font-medium">
                      {selectedMember.last_battle_at ? formatRelativeTime(selectedMember.last_battle_at) : <T text="No battle data" />}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground"><T text="Last updated" /></span>
                    <span className="text-end font-medium">{formatDateTime(selectedMember.last_updated)}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground"><T text="Win rate" /></span>
                    <span className="text-end font-medium">{selectedMember.win_rate != null ? <T text="{value0}%" values={{ value0: String(selectedMember.win_rate) }} /> : <T text="No data" />}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground"><T text="Current rank" /></span>
                    <span className="text-end font-medium">{selectedMember.rank_current || <T text="Unknown" />}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground"><T text="Best rank" /></span>
                    <span className="text-end font-medium">{selectedMember.rank_highest || <T text="Unknown" />}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground"><T text="Brawlers" /></span>
                    <span className="text-end font-medium">{selectedMember.brawlers_count}</span>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">{isAdmin && <MemberReviewButton member={selectedMember} initialRange={timeRange} />}
                  <Button
                    variant="outline"
                    onClick={() => copyText(selectedMember.player_tag, "tag")}
                    className="gap-2"
                  >
                    {copied === "tag" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    <T text=" Copy Tag " /></Button>
                  <Button asChild className="gap-2">
                    <Link href={`/members/${encodeURIComponent(selectedMember.player_tag)}`}>
                      <ExternalLink className="h-4 w-4" />
                      <T text=" Open Profile " /></Link>
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </LayoutWrapper>
  );
}
