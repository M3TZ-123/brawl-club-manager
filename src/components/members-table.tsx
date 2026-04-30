"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Member } from "@/types/database";
import { cn, formatDateTime, formatNumber, formatRelativeTime, getRankColor } from "@/lib/utils";
import { getFallbackInitial, getProfileIconUrl, getRankIconUrl } from "@/lib/brawl-assets";
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
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crown,
  ExternalLink,
  Gem,
  Medal,
  Shield,
  Trophy,
} from "lucide-react";

export type ActivityStatus = "active" | "minimal" | "inactive";
type ActivityDisplayStatus = ActivityStatus | "unknown";

export interface MemberWithGains extends Member {
  trophies_24h?: number | null;
  trophies_3d?: number | null;
  trophies_7d?: number | null;
  activity_status?: ActivityStatus;
  last_battle_at?: string | null;
}

export type MemberColumnKey =
  | "role"
  | "trophies"
  | "highest_trophies"
  | "win_rate"
  | "rank_current"
  | "rank_highest"
  | "trophies_24h"
  | "trophies_3d"
  | "trophies_7d"
  | "activity"
  | "last_battle"
  | "brawlers_count"
  | "trio_victories";

export type MemberSortKey =
  | "player_name"
  | "role"
  | "trophies"
  | "highest_trophies"
  | "win_rate"
  | "rank_current"
  | "rank_highest"
  | "trophies_24h"
  | "trophies_3d"
  | "trophies_7d"
  | "activity_status"
  | "last_battle_at"
  | "brawlers_count"
  | "trio_victories";

export type MemberSortState = {
  key: MemberSortKey;
  direction: "asc" | "desc";
};

export type MemberColumnVisibility = Record<MemberColumnKey, boolean>;

export const DEFAULT_MEMBER_COLUMNS: MemberColumnVisibility = {
  role: true,
  trophies: true,
  highest_trophies: false,
  win_rate: false,
  rank_current: false,
  rank_highest: false,
  trophies_24h: true,
  trophies_3d: true,
  trophies_7d: false,
  activity: true,
  last_battle: true,
  brawlers_count: false,
  trio_victories: false,
};

interface MembersTableProps {
  members: MemberWithGains[];
  pageSize?: number;
  showPagination?: boolean;
  columnVisibility?: MemberColumnVisibility;
  sortState?: MemberSortState;
  onSort?: (key: MemberSortKey) => void;
  onMemberSelect?: (member: MemberWithGains) => void;
}

const SORTABLE_COLUMNS: Partial<Record<MemberColumnKey, MemberSortKey>> = {
  role: "role",
  trophies: "trophies",
  highest_trophies: "highest_trophies",
  win_rate: "win_rate",
  rank_current: "rank_current",
  rank_highest: "rank_highest",
  trophies_24h: "trophies_24h",
  trophies_3d: "trophies_3d",
  trophies_7d: "trophies_7d",
  activity: "activity_status",
  last_battle: "last_battle_at",
  brawlers_count: "brawlers_count",
  trio_victories: "trio_victories",
};

function ProfileAvatar({ playerName, iconId }: { playerName: string; iconId: number | null }) {
  const [imageError, setImageError] = useState(false);
  const iconUrl = !imageError ? getProfileIconUrl(iconId) : null;

  if (!iconUrl) {
    return (
      <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-xs font-semibold text-muted-foreground shadow-sm">
        {getFallbackInitial(playerName)}
      </div>
    );
  }

  return (
    <Image
      src={iconUrl}
      alt={`${playerName} icon`}
      width={36}
      height={36}
      className="h-9 w-9 rounded-md border border-border/70 bg-muted/30 object-cover shadow-sm"
      onError={() => setImageError(true)}
    />
  );
}

function getRankTier(rank: string | null) {
  const value = (rank || "Unranked").toLowerCase();
  if (value.includes("masters") || value.includes("pro")) return "masters";
  if (value.includes("legendary")) return "legendary";
  if (value.includes("mythic") || value.includes("diamond")) return "gem";
  if (value.includes("gold") || value.includes("silver") || value.includes("bronze")) return "medal";
  return "default";
}

function RankIcon({ rank }: { rank: string | null }) {
  const [imageError, setImageError] = useState(false);
  const rankIconUrl = !imageError ? getRankIconUrl(rank) : null;

  if (rankIconUrl) {
    return (
      <Image
        src={rankIconUrl}
        alt={rank || "Rank"}
        width={20}
        height={20}
        className="h-5 w-5 object-contain"
        onError={() => setImageError(true)}
      />
    );
  }

  const tier = getRankTier(rank);

  if (tier === "masters") return <Trophy className="h-5 w-5" />;
  if (tier === "legendary") return <Crown className="h-5 w-5" />;
  if (tier === "gem") return <Gem className="h-5 w-5" />;
  if (tier === "medal") return <Medal className="h-5 w-5" />;
  return <Shield className="h-5 w-5" />;
}

function getRoleBadgeVariant(role: string) {
  switch (role.toLowerCase()) {
    case "president":
      return "default";
    case "vicepresident":
      return "secondary";
    case "senior":
      return "outline";
    default:
      return "outline";
  }
}

function getActivityStatus(member: MemberWithGains): ActivityDisplayStatus {
  return member.activity_status || "unknown";
}

function getActivityLabel(status: ActivityDisplayStatus) {
  if (status === "active") return "Active";
  if (status === "minimal") return "Low activity";
  if (status === "inactive") return "Inactive";
  return "No data";
}

function getActivityClass(status: ActivityDisplayStatus) {
  if (status === "active") return "border-green-500/30 bg-green-500/10 text-green-400";
  if (status === "minimal") return "border-yellow-500/30 bg-yellow-500/10 text-yellow-300";
  if (status === "inactive") return "border-red-500/30 bg-red-500/10 text-red-300";
  return "border-border bg-muted/40 text-muted-foreground";
}

function ActivityBadge({ status }: { status: ActivityDisplayStatus }) {
  return (
    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold", getActivityClass(status))}>
      {getActivityLabel(status)}
    </span>
  );
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

function formatOptionalNumber(value: number | null | undefined) {
  return value == null ? "-" : formatNumber(value);
}

function formatLastBattle(member: MemberWithGains) {
  if (!member.last_battle_at) return "No battle data";
  return formatRelativeTime(member.last_battle_at);
}

function SortableHead({
  label,
  sortKey,
  sortState,
  onSort,
  className,
  align = "left",
}: {
  label: string;
  sortKey?: MemberSortKey;
  sortState?: MemberSortState;
  onSort?: (key: MemberSortKey) => void;
  className?: string;
  align?: "left" | "right" | "center";
}) {
  const isActive = Boolean(sortKey && sortState?.key === sortKey);
  const Icon = !isActive ? ArrowUpDown : sortState?.direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <TableHead className={className}>
      {sortKey && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className={cn(
            "inline-flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide hover:text-foreground",
            align === "right" && "justify-end",
            align === "center" && "justify-center"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", isActive ? "text-primary" : "text-muted-foreground/70")} />
        </button>
      ) : (
        <span
          className={cn(
            "block text-xs font-semibold uppercase tracking-wide",
            align === "right" && "text-right",
            align === "center" && "text-center"
          )}
        >
          {label}
        </span>
      )}
    </TableHead>
  );
}

function RankCell({ rank }: { rank: string | null }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", getRankColor(rank || "Unranked"))}>
      <RankIcon rank={rank} />
      {rank || "Unranked"}
    </span>
  );
}

export const MembersTable = memo(function MembersTable({
  members,
  pageSize = 12,
  showPagination = true,
  columnVisibility = DEFAULT_MEMBER_COLUMNS,
  sortState,
  onSort,
  onMemberSelect,
}: MembersTableProps) {
  const [copiedTag, setCopiedTag] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const copyResetTimeoutRef = useRef<number | null>(null);

  const normalizedPageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(members.length / normalizedPageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const startIndex = (safeCurrentPage - 1) * normalizedPageSize;
  const paginatedMembers = useMemo(
    () => showPagination ? members.slice(startIndex, startIndex + normalizedPageSize) : members,
    [members, normalizedPageSize, showPagination, startIndex]
  );
  const visibleColumnCount = 2 + Object.values(columnVisibility).filter(Boolean).length;

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
    };
  }, []);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTag(text);
      if (copyResetTimeoutRef.current) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopiedTag(null);
        copyResetTimeoutRef.current = null;
      }, 1600);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>, member: MemberWithGains) => {
    if (!onMemberSelect) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onMemberSelect(member);
    }
  };

  const renderMobileCards = () => (
    <div className="grid gap-3 md:hidden">
      {paginatedMembers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">
          No members found
        </div>
      ) : (
        paginatedMembers.map((member, index) => {
          const activityStatus = getActivityStatus(member);
          return (
            <div
              key={member.player_tag}
              role={onMemberSelect ? "button" : undefined}
              tabIndex={onMemberSelect ? 0 : undefined}
              onClick={() => onMemberSelect?.(member)}
              onKeyDown={(event) => {
                if (!onMemberSelect) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onMemberSelect(member);
                }
              }}
              className={cn(
                "rounded-lg border border-border bg-card p-4 shadow-sm",
                onMemberSelect && "cursor-pointer transition-colors hover:bg-muted/30"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <ProfileAvatar playerName={member.player_name} iconId={member.icon_id} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-muted-foreground">#{startIndex + index + 1}</span>
                      <Badge variant={getRoleBadgeVariant(member.role)} className="text-[11px]">
                        {member.role}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate font-semibold">{member.player_name}</p>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">{member.player_tag}</span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          copyToClipboard(member.player_tag);
                        }}
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        aria-label={`Copy tag ${member.player_tag}`}
                      >
                        {copiedTag === member.player_tag ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>
                <Link
                  href={`/members/${encodeURIComponent(member.player_tag)}`}
                  onClick={(event) => event.stopPropagation()}
                  className="rounded p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={`Open ${member.player_name} profile`}
                >
                  <ExternalLink className="h-4 w-4" />
                </Link>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Trophies</p>
                  <p className="font-semibold">{formatNumber(member.trophies)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">3 days</p>
                  <p className={cn("font-semibold", getDeltaClass(member.trophies_3d))}>
                    {formatDelta(member.trophies_3d)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">24h</p>
                  <p className={cn("font-semibold", getDeltaClass(member.trophies_24h))}>
                    {formatDelta(member.trophies_24h)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Last battle</p>
                  <p className="font-medium">{formatLastBattle(member)}</p>
                </div>
              </div>
              <div className="mt-3">
                <ActivityBadge status={activityStatus} />
              </div>
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <>
      {renderMobileCards()}

      <div className="hidden w-full overflow-x-auto md:block">
        <Table className="min-w-[980px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <SortableHead
                label="Player"
                sortKey="player_name"
                sortState={sortState}
                onSort={onSort}
                className="w-[260px]"
              />
              {columnVisibility.role && (
                <SortableHead label="Role" sortKey={SORTABLE_COLUMNS.role} sortState={sortState} onSort={onSort} />
              )}
              {columnVisibility.trophies && (
                <SortableHead label="Trophies" sortKey={SORTABLE_COLUMNS.trophies} sortState={sortState} onSort={onSort} align="right" />
              )}
              {columnVisibility.highest_trophies && (
                <SortableHead label="Highest" sortKey={SORTABLE_COLUMNS.highest_trophies} sortState={sortState} onSort={onSort} align="right" />
              )}
              {columnVisibility.trophies_24h && (
                <SortableHead label="24h" sortKey={SORTABLE_COLUMNS.trophies_24h} sortState={sortState} onSort={onSort} align="right" />
              )}
              {columnVisibility.trophies_3d && (
                <SortableHead label="3 days" sortKey={SORTABLE_COLUMNS.trophies_3d} sortState={sortState} onSort={onSort} align="right" />
              )}
              {columnVisibility.trophies_7d && (
                <SortableHead label="7 days" sortKey={SORTABLE_COLUMNS.trophies_7d} sortState={sortState} onSort={onSort} align="right" />
              )}
              {columnVisibility.activity && (
                <SortableHead label="Activity" sortKey={SORTABLE_COLUMNS.activity} sortState={sortState} onSort={onSort} align="center" />
              )}
              {columnVisibility.last_battle && (
                <SortableHead label="Last Battle" sortKey={SORTABLE_COLUMNS.last_battle} sortState={sortState} onSort={onSort} />
              )}
              {columnVisibility.win_rate && (
                <SortableHead label="Win Rate" sortKey={SORTABLE_COLUMNS.win_rate} sortState={sortState} onSort={onSort} align="center" />
              )}
              {columnVisibility.rank_current && (
                <SortableHead label="Current Rank" sortKey={SORTABLE_COLUMNS.rank_current} sortState={sortState} onSort={onSort} />
              )}
              {columnVisibility.rank_highest && (
                <SortableHead label="Best Rank" sortKey={SORTABLE_COLUMNS.rank_highest} sortState={sortState} onSort={onSort} />
              )}
              {columnVisibility.brawlers_count && (
                <SortableHead label="Brawlers" sortKey={SORTABLE_COLUMNS.brawlers_count} sortState={sortState} onSort={onSort} align="right" />
              )}
              {columnVisibility.trio_victories && (
                <SortableHead label="3v3 Wins" sortKey={SORTABLE_COLUMNS.trio_victories} sortState={sortState} onSort={onSort} align="right" />
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedMembers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={visibleColumnCount} className="py-10 text-center text-muted-foreground">
                  No members found
                </TableCell>
              </TableRow>
            ) : (
              paginatedMembers.map((member, index) => {
                const activityStatus = getActivityStatus(member);
                return (
                  <TableRow
                    key={member.player_tag}
                    tabIndex={onMemberSelect ? 0 : undefined}
                    onClick={() => onMemberSelect?.(member)}
                    onKeyDown={(event) => handleRowKeyDown(event, member)}
                    className={cn(onMemberSelect && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
                  >
                    <TableCell className="font-medium text-muted-foreground">{startIndex + index + 1}</TableCell>
                    <TableCell className="w-[260px]">
                      <div className="flex items-center gap-3">
                        <ProfileAvatar playerName={member.player_name} iconId={member.icon_id} />
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{member.player_name}</p>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-muted-foreground">{member.player_tag}</span>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                copyToClipboard(member.player_tag);
                              }}
                              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              aria-label={`Copy tag ${member.player_tag}`}
                            >
                              {copiedTag === member.player_tag ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                            </button>
                            <Link
                              href={`/members/${encodeURIComponent(member.player_tag)}`}
                              onClick={(event) => event.stopPropagation()}
                              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              aria-label={`Open ${member.player_name} profile`}
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </Link>
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    {columnVisibility.role && (
                      <TableCell>
                        <Badge variant={getRoleBadgeVariant(member.role)}>{member.role}</Badge>
                      </TableCell>
                    )}
                    {columnVisibility.trophies && (
                      <TableCell className="text-right font-semibold">{formatNumber(member.trophies)}</TableCell>
                    )}
                    {columnVisibility.highest_trophies && (
                      <TableCell className="text-right text-muted-foreground">{formatNumber(member.highest_trophies)}</TableCell>
                    )}
                    {columnVisibility.trophies_24h && (
                      <TableCell className={cn("text-right font-medium", getDeltaClass(member.trophies_24h))}>
                        {formatDelta(member.trophies_24h)}
                      </TableCell>
                    )}
                    {columnVisibility.trophies_3d && (
                      <TableCell className={cn("text-right font-medium", getDeltaClass(member.trophies_3d))}>
                        {formatDelta(member.trophies_3d)}
                      </TableCell>
                    )}
                    {columnVisibility.trophies_7d && (
                      <TableCell className={cn("text-right font-medium", getDeltaClass(member.trophies_7d))}>
                        {formatDelta(member.trophies_7d)}
                      </TableCell>
                    )}
                    {columnVisibility.activity && (
                      <TableCell className="text-center">
                        <ActivityBadge status={activityStatus} />
                      </TableCell>
                    )}
                    {columnVisibility.last_battle && (
                      <TableCell
                        className="text-muted-foreground"
                        title={`Last update: ${formatRelativeTime(member.last_updated)} (${formatDateTime(member.last_updated)})${member.last_battle_at ? ` | Last battle: ${formatRelativeTime(member.last_battle_at)} (${formatDateTime(member.last_battle_at)})` : ""}`}
                      >
                        {formatLastBattle(member)}
                      </TableCell>
                    )}
                    {columnVisibility.win_rate && (
                      <TableCell className="text-center">
                        <span
                          className={cn(
                            member.win_rate != null && member.win_rate >= 60 && "font-medium text-green-500",
                            member.win_rate != null && member.win_rate >= 50 && member.win_rate < 60 && "text-yellow-500",
                            member.win_rate != null && member.win_rate < 50 && "text-red-500",
                            member.win_rate == null && "text-muted-foreground"
                          )}
                        >
                          {member.win_rate != null ? `${member.win_rate}%` : "-"}
                        </span>
                      </TableCell>
                    )}
                    {columnVisibility.rank_current && (
                      <TableCell>
                        <RankCell rank={member.rank_current} />
                      </TableCell>
                    )}
                    {columnVisibility.rank_highest && (
                      <TableCell>
                        <RankCell rank={member.rank_highest} />
                      </TableCell>
                    )}
                    {columnVisibility.brawlers_count && (
                      <TableCell className="text-right">{formatOptionalNumber(member.brawlers_count)}</TableCell>
                    )}
                    {columnVisibility.trio_victories && (
                      <TableCell className="text-right">{formatOptionalNumber(member.trio_victories)}</TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {showPagination && totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 px-1 pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(Math.max(1, safeCurrentPage - 1))}
            disabled={safeCurrentPage === 1}
            aria-label="Previous members page"
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </Button>
          <span className="px-2 text-sm font-medium">
            {safeCurrentPage} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(Math.min(totalPages, safeCurrentPage + 1))}
            disabled={safeCurrentPage === totalPages}
            aria-label="Next members page"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </>
  );
});
