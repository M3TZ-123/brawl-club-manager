"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { LayoutWrapper } from "@/components/layout-wrapper";
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
import { cn, formatDateTime, formatNumber, formatRelativeTime } from "@/lib/utils";
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
  Activity,
  AlertTriangle,
  Check,
  Columns3,
  Copy,
  Download,
  ExternalLink,
  Filter,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  SlidersHorizontal,
  Trophy,
  TrendingDown,
  TrendingUp,
  UserX,
  Users,
} from "lucide-react";

type QuickFilter = "all" | "attention" | "top-gainers" | "losing" | "inactive" | "officers";
type RoleFilter = "all" | "president" | "vicepresident" | "senior" | "member";
type ActivityFilter = "all" | ActivityStatus | "unknown";
type MovementFilter = "all" | "positive" | "negative" | "flat" | "unknown";
type RankFilter = "all" | "masters" | "legendary" | "mythic" | "diamond" | "gold" | "lower" | "unranked";

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
  { key: "trophies_24h", label: "24h", description: "One-day movement" },
  { key: "trophies_7d", label: "7 days", description: "Weekly movement" },
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

function getSevenDayChange(member: MemberWithGains) {
  return member.trophies_7d;
}

function needsAttention(member: MemberWithGains) {
  const status = getActivityStatus(member);
  const sevenDayChange = getSevenDayChange(member);
  return status === "minimal" || status === "inactive" || (sevenDayChange != null && sevenDayChange < 0);
}

function isOfficer(member: MemberWithGains) {
  const role = member.role.toLowerCase();
  return role === "president" || role === "vicepresident";
}

function rankMatches(rank: string | null, filter: RankFilter) {
  if (filter === "all") return true;
  const value = (rank || "").toLowerCase();
  if (filter === "unranked") return !rank || value.includes("unranked");
  if (filter === "lower") {
    return value.includes("silver") || value.includes("bronze");
  }
  return value.includes(filter);
}

function getSortValue(member: MemberWithGains, key: MemberSortKey): string | number | null {
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
    case "trophies_7d":
      return member.trophies_7d ?? null;
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

function compareMembers(a: MemberWithGains, b: MemberWithGains, sort: MemberSortState) {
  const aValue = getSortValue(a, sort.key);
  const bValue = getSortValue(b, sort.key);

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

function formatDelta(value: number | null | undefined) {
  if (value == null) return "No data";
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${formatNumber(value)}`;
}

function getDeltaClass(value: number | null | undefined) {
  if (value == null || value === 0) return "text-muted-foreground";
  return value > 0 ? "text-green-500" : "text-red-400";
}

function formatLastSync(lastSyncTime: string | null) {
  if (!lastSyncTime) return "No sync yet";
  const parsed = new Date(lastSyncTime);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return formatRelativeTime(parsed);
}

function formatLastSyncDetail(lastSyncTime: string | null) {
  if (!lastSyncTime) return "Waiting for sync";
  const parsed = new Date(lastSyncTime);
  if (Number.isNaN(parsed.getTime())) return "Timestamp unavailable";
  return formatDateTime(parsed);
}

function getRankLabel(filter: RankFilter) {
  const labels: Record<RankFilter, string> = {
    all: "All ranks",
    masters: "Masters",
    legendary: "Legendary",
    mythic: "Mythic",
    diamond: "Diamond",
    gold: "Gold",
    lower: "Silver / Bronze",
    unranked: "Unranked",
  };
  return labels[filter];
}

function SummaryCard({
  title,
  value,
  description,
  icon: Icon,
  tone,
}: {
  title: string;
  value: string | number;
  description: string;
  icon: React.ElementType;
  tone: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className="mt-2 text-2xl font-bold">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
          <Icon className={cn("h-5 w-5", tone)} />
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
  const {
    lastSyncTime,
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
  const [sortState, setSortState] = useState<MemberSortState>({ key: "trophies", direction: "desc" });
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
        invalidateJsonCache("/api/sync/status");
      }

      const [membersData, syncStatus] = await Promise.all([
        fetchJsonCached<{ members: MemberWithGains[] }>("/api/members", {
          staleMs: 30_000,
          force,
        }),
        fetchJsonCached<{ lastSyncTime: string | null }>("/api/sync/status", {
          staleMs: 30_000,
          force,
        }).catch(() => ({ lastSyncTime: null })),
      ]);

      setMembers(membersData.members || []);
      if (syncStatus.lastSyncTime) {
        setLastSyncTime(syncStatus.lastSyncTime);
      }
    } catch (error) {
      console.error("Error loading members:", error);
      setErrorMessage(error instanceof Error ? error.message : "Failed to load members");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [setLastSyncTime]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    const handleClubDataUpdated = () => {
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

  const summary = useMemo(() => {
    const totalTrophies = members.reduce((sum, member) => sum + (member.trophies || 0), 0);
    const active = members.filter((member) => getActivityStatus(member) === "active").length;
    const inactive = members.filter((member) => getActivityStatus(member) === "inactive").length;
    return {
      total: members.length,
      active,
      inactive,
      averageTrophies: members.length > 0 ? Math.round(totalTrophies / members.length) : 0,
      attention: members.filter(needsAttention).length,
    };
  }, [members]);

  const quickFilters = useMemo(() => [
    { id: "all" as const, label: "All", count: members.length, icon: Users },
    { id: "attention" as const, label: "Needs Attention", count: members.filter(needsAttention).length, icon: AlertTriangle },
    { id: "top-gainers" as const, label: "Top Gainers", count: members.filter((member) => (member.trophies_7d ?? 0) > 0).length, icon: TrendingUp },
    { id: "losing" as const, label: "Losing Trophies", count: members.filter((member) => (member.trophies_7d ?? 0) < 0).length, icon: TrendingDown },
    { id: "inactive" as const, label: "Inactive", count: members.filter((member) => getActivityStatus(member) === "inactive").length, icon: UserX },
    { id: "officers" as const, label: "Officers", count: members.filter(isOfficer).length, icon: Shield },
  ], [members]);

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

        if (quickFilter === "attention" && !needsAttention(member)) return false;
        if (quickFilter === "top-gainers" && !((member.trophies_7d ?? 0) > 0)) return false;
        if (quickFilter === "losing" && !((member.trophies_7d ?? 0) < 0)) return false;
        if (quickFilter === "inactive" && getActivityStatus(member) !== "inactive") return false;
        if (quickFilter === "officers" && !isOfficer(member)) return false;

        if (roleFilter !== "all" && member.role.toLowerCase() !== roleFilter) return false;
        if (activityFilter !== "all" && getActivityStatus(member) !== activityFilter) return false;
        if (!rankMatches(member.rank_current, rankFilter)) return false;

        if (movementFilter === "positive" && !((member.trophies_7d ?? 0) > 0)) return false;
        if (movementFilter === "negative" && !((member.trophies_7d ?? 0) < 0)) return false;
        if (movementFilter === "flat" && member.trophies_7d !== 0) return false;
        if (movementFilter === "unknown" && member.trophies_7d != null) return false;

        if (min != null && Number.isFinite(min) && member.trophies < min) return false;
        if (max != null && Number.isFinite(max) && member.trophies > max) return false;

        return true;
      })
      .sort((a, b) => compareMembers(a, b, sortState));
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
  ]);

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
      setSortState({ key: "trophies_7d", direction: "desc" });
    } else if (filter === "losing") {
      setSortState({ key: "trophies_7d", direction: "asc" });
    } else if (filter === "inactive" || filter === "attention") {
      setSortState({ key: "activity_status", direction: "asc" });
    } else if (filter === "officers") {
      setSortState({ key: "role", direction: "asc" });
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
    } catch (error) {
      console.error("Sync failed:", error);
      setErrorMessage(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleExport = () => {
    const csv = [
      [
        "Tag",
        "Name",
        "Role",
        "Trophies",
        "Highest",
        "24h",
        "7 Days",
        "Activity",
        "Last Battle",
        "Win Rate",
        "Current Rank",
        "Best Rank",
        "Brawlers",
        "3v3 Wins",
      ].join(","),
      ...filteredMembers.map((member) => [
        sanitizeCsvValue(member.player_tag),
        sanitizeCsvValue(member.player_name),
        sanitizeCsvValue(member.role),
        sanitizeCsvValue(member.trophies),
        sanitizeCsvValue(member.highest_trophies),
        sanitizeCsvValue(member.trophies_24h),
        sanitizeCsvValue(member.trophies_7d),
        sanitizeCsvValue(getActivityLabel(getActivityStatus(member))),
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
    anchor.download = `club-members-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <LayoutWrapper>
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <SummaryCard
            title="Total Members"
            value={summary.total}
            description={`${filteredMembers.length} currently visible`}
            icon={Users}
            tone="text-blue-500"
          />
          <SummaryCard
            title="Active"
            value={summary.active}
            description="Tracked as active"
            icon={Activity}
            tone="text-green-500"
          />
          <SummaryCard
            title="Inactive"
            value={summary.inactive}
            description={`${summary.attention} need review`}
            icon={UserX}
            tone="text-red-400"
          />
          <SummaryCard
            title="Avg Trophies"
            value={formatNumber(summary.averageTrophies)}
            description="Per current member"
            icon={Trophy}
            tone="text-yellow-500"
          />
          <SummaryCard
            title="Last Sync"
            value={formatLastSync(lastSyncTime)}
            description={formatLastSyncDetail(lastSyncTime)}
            icon={RefreshCw}
            tone="text-primary"
          />
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <CardTitle>Members</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Full roster with activity, weekly movement, filters, and quick review.
                </p>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap xl:justify-end">
                <div className="relative min-w-0 sm:w-72">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search name or tag..."
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    className="pl-10"
                  />
                </div>
                <Button
                  variant={showFilters || hasAdvancedFilters ? "default" : "outline"}
                  onClick={() => setShowFilters((value) => !value)}
                  className="gap-2"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  Filters
                </Button>
                <Button
                  variant={showColumns ? "default" : "outline"}
                  onClick={() => setShowColumns((value) => !value)}
                  className="gap-2"
                >
                  <Columns3 className="h-4 w-4" />
                  Columns
                </Button>
                {isAdmin && (
                  <Button
                    variant="outline"
                    onClick={handleSyncNow}
                    disabled={isSyncing || isRefreshing || isAdminLoading || !clubTag || !apiKeyConfigured}
                    className="gap-2"
                  >
                    <RefreshCw className={cn("h-4 w-4", (isSyncing || isRefreshing) && "animate-spin")} />
                    {isSyncing ? "Syncing" : "Sync Now"}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={handleExport}
                  disabled={filteredMembers.length === 0}
                  className="gap-2"
                >
                  <Download className="h-4 w-4" />
                  Export
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
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
                    {filter.label}
                    <span className={cn("rounded-full px-2 py-0.5 text-xs", isActive ? "bg-primary-foreground/20" : "bg-muted")}>
                      {filter.count}
                    </span>
                  </button>
                );
              })}
            </div>

            {showFilters && (
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Filter className="h-4 w-4 text-primary" />
                    <h3 className="font-semibold">Advanced Filters</h3>
                  </div>
                  <Button variant="ghost" size="sm" onClick={resetAdvancedFilters} className="gap-2">
                    <RotateCcw className="h-4 w-4" />
                    Reset
                  </Button>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground">Role</span>
                    <select
                      value={roleFilter}
                      onChange={(event) => setRoleFilter(event.target.value as RoleFilter)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="all">All roles</option>
                      <option value="president">President</option>
                      <option value="vicepresident">Vice President</option>
                      <option value="senior">Senior</option>
                      <option value="member">Member</option>
                    </select>
                  </label>

                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground">Activity</span>
                    <select
                      value={activityFilter}
                      onChange={(event) => setActivityFilter(event.target.value as ActivityFilter)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="all">All activity</option>
                      <option value="active">Active</option>
                      <option value="minimal">Low activity</option>
                      <option value="inactive">Inactive</option>
                      <option value="unknown">No data</option>
                    </select>
                  </label>

                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground">7-day movement</span>
                    <select
                      value={movementFilter}
                      onChange={(event) => setMovementFilter(event.target.value as MovementFilter)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="all">All movement</option>
                      <option value="positive">Gained trophies</option>
                      <option value="negative">Lost trophies</option>
                      <option value="flat">No movement</option>
                      <option value="unknown">No data</option>
                    </select>
                  </label>

                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground">Rank</span>
                    <select
                      value={rankFilter}
                      onChange={(event) => setRankFilter(event.target.value as RankFilter)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {(["all", "masters", "legendary", "mythic", "diamond", "gold", "lower", "unranked"] as RankFilter[]).map((filter) => (
                        <option key={filter} value={filter}>{getRankLabel(filter)}</option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground">Min trophies</span>
                    <Input
                      inputMode="numeric"
                      value={minTrophies}
                      onChange={(event) => setMinTrophies(event.target.value.replace(/[^\d]/g, ""))}
                      placeholder="0"
                    />
                  </label>

                  <label className="space-y-1.5 text-sm">
                    <span className="text-muted-foreground">Max trophies</span>
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
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Columns3 className="h-4 w-4 text-primary" />
                    <h3 className="font-semibold">Visible Columns</h3>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setColumnVisibility(DEFAULT_MEMBER_COLUMNS)}
                    className="gap-2"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Default
                  </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {COLUMN_OPTIONS.map((column) => (
                    <div key={column.key} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/60 p-3">
                      <div>
                        <p className="text-sm font-medium">{column.label}</p>
                        <p className="text-xs text-muted-foreground">{column.description}</p>
                      </div>
                      <Switch
                        checked={columnVisibility[column.key]}
                        onCheckedChange={(checked) => toggleColumn(column.key, checked)}
                        aria-label={`Toggle ${column.label} column`}
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
                  <p className="font-semibold">Members failed to load</p>
                  <p className="text-red-100/80">{errorMessage}</p>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>
                  Showing <span className="font-semibold text-foreground">{filteredMembers.length}</span> of{" "}
                  <span className="font-semibold text-foreground">{members.length}</span>
                </span>
                {quickFilter !== "all" && (
                  <Badge variant="secondary">{quickFilters.find((filter) => filter.id === quickFilter)?.label}</Badge>
                )}
                {hasAdvancedFilters && <Badge variant="outline">Advanced filters active</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                Click a row for quick details. Open profile for full history.
              </p>
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
                members={filteredMembers}
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
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {selectedMember && (
            <>
              <SheetHeader>
                <SheetTitle>{selectedMember.player_name}</SheetTitle>
                <SheetDescription>{selectedMember.player_tag}</SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{selectedMember.role}</Badge>
                  <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-semibold", getActivityClass(getActivityStatus(selectedMember)))}>
                    {getActivityLabel(getActivityStatus(selectedMember))}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">Trophies</p>
                    <p className="mt-1 text-xl font-bold">{formatNumber(selectedMember.trophies)}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">Highest</p>
                    <p className="mt-1 text-xl font-bold">{formatNumber(selectedMember.highest_trophies)}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">24h</p>
                    <p className={cn("mt-1 text-xl font-bold", getDeltaClass(selectedMember.trophies_24h))}>
                      {formatDelta(selectedMember.trophies_24h)}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">7 days</p>
                    <p className={cn("mt-1 text-xl font-bold", getDeltaClass(selectedMember.trophies_7d))}>
                      {formatDelta(selectedMember.trophies_7d)}
                    </p>
                  </div>
                </div>

                <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Last battle</span>
                    <span className="text-right font-medium">
                      {selectedMember.last_battle_at ? formatRelativeTime(selectedMember.last_battle_at) : "No battle data"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Last updated</span>
                    <span className="text-right font-medium">{formatDateTime(selectedMember.last_updated)}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Win rate</span>
                    <span className="text-right font-medium">{selectedMember.win_rate != null ? `${selectedMember.win_rate}%` : "No data"}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Current rank</span>
                    <span className="text-right font-medium">{selectedMember.rank_current || "Unranked"}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Best rank</span>
                    <span className="text-right font-medium">{selectedMember.rank_highest || "Unranked"}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Brawlers</span>
                    <span className="text-right font-medium">{selectedMember.brawlers_count}</span>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                    variant="outline"
                    onClick={() => copyText(selectedMember.player_tag, "tag")}
                    className="gap-2"
                  >
                    {copied === "tag" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    Copy Tag
                  </Button>
                  <Button asChild className="gap-2">
                    <Link href={`/members/${encodeURIComponent(selectedMember.player_tag)}`}>
                      <ExternalLink className="h-4 w-4" />
                      Open Profile
                    </Link>
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
