"use client";

import { useState } from "react";
import Image from "next/image";
import { Member } from "@/types/database";
import { formatDateTime, formatNumber, formatRelativeTime, getActivityEmoji, getRankColor } from "@/lib/utils";
import { getFallbackInitial, getProfileIconUrl, getRankIconUrl } from "@/lib/brawl-assets";
import Link from "next/link";
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
import { Copy, Check, ChevronLeft, ChevronRight, Trophy, Crown, Gem, Medal, Shield } from "lucide-react";

interface MemberWithGains extends Member {
  trophies_24h?: number | null;
  trophies_7d?: number | null;
  activity_status?: "active" | "minimal" | "inactive";
  last_battle_at?: string | null;
}

interface MembersTableProps {
  members: MemberWithGains[];
  pageSize?: number;
  showPagination?: boolean;
}

function ProfileAvatar({ playerName, iconId }: { playerName: string; iconId: number | null }) {
  const [imageError, setImageError] = useState(false);
  const iconUrl = !imageError ? getProfileIconUrl(iconId) : null;

  if (!iconUrl) {
    return (
      <div className="h-7 w-7 rounded-md border border-border/70 bg-muted/30 shadow-sm flex items-center justify-center text-[10px] font-semibold text-muted-foreground">
        {getFallbackInitial(playerName)}
      </div>
    );
  }

  return (
    <Image
      src={iconUrl}
      alt={`${playerName} icon`}
      width={28}
      height={28}
      className="h-7 w-7 rounded-md border border-border/70 bg-muted/30 shadow-sm"
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

export function MembersTable({ members, pageSize = 10, showPagination = true }: MembersTableProps) {
  const [copiedTag, setCopiedTag] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const normalizedPageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(members.length / normalizedPageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const startIndex = (safeCurrentPage - 1) * normalizedPageSize;
  const paginatedMembers = showPagination ? members.slice(startIndex, startIndex + normalizedPageSize) : members;

  const copyToClipboard = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTag(tag);
      setTimeout(() => setCopiedTag(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const getRoleBadgeVariant = (role: string) => {
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
  };

  return (
    <>
    <div className="overflow-x-auto -mx-4 sm:mx-0">
      <Table className="min-w-[600px] sm:min-w-full">
        <TableHeader>
          <TableRow>
            <TableHead className="w-10 sm:w-12">#</TableHead>
            <TableHead>Player</TableHead>
            <TableHead className="hidden sm:table-cell">Role</TableHead>
            <TableHead className="text-right">Trophies</TableHead>
            <TableHead className="hidden lg:table-cell text-right">Highest</TableHead>
            <TableHead className="hidden xl:table-cell text-center">Win Rate</TableHead>
            <TableHead className="hidden xl:table-cell">Current Rank</TableHead>
            <TableHead className="hidden xl:table-cell">Best Rank</TableHead>
            <TableHead className="hidden md:table-cell text-right">24h</TableHead>
            <TableHead className="hidden sm:table-cell text-right">7 Days</TableHead>
            <TableHead className="text-center">Activity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
        {paginatedMembers.length === 0 ? (
          <TableRow>
            <TableCell colSpan={11} className="py-10 text-center text-muted-foreground">
              No members found
            </TableCell>
          </TableRow>
        ) : (
          paginatedMembers.map((member, index) => (
          <TableRow key={member.player_tag}>
            <TableCell className="font-medium">{startIndex + index + 1}</TableCell>
            <TableCell>
              <div className="flex items-center gap-2 sm:gap-2">
                <ProfileAvatar playerName={member.player_name} iconId={member.icon_id} />
                <Link
                  href={`/members/${encodeURIComponent(member.player_tag)}`}
                  className="flex flex-col hover:underline min-w-0"
                >
                  <span className="font-medium truncate max-w-[100px] sm:max-w-none">{member.player_name}</span>
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    {member.player_tag}
                  </span>
                </Link>
                <button
                  onClick={() => copyToClipboard(member.player_tag, member.player_tag)}
                  className="p-1 rounded hover:bg-muted transition-colors hidden sm:block"
                  title="Copy player tag"
                  aria-label={`Copy tag ${member.player_tag}`}
                >
                  {copiedTag === member.player_tag ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                  )}
                </button>
              </div>
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              <Badge variant={getRoleBadgeVariant(member.role)}>
                {member.role}
              </Badge>
            </TableCell>
            <TableCell className="text-right font-medium">
              {formatNumber(member.trophies)}
            </TableCell>
            <TableCell className="hidden lg:table-cell text-right text-muted-foreground">
              {formatNumber(member.highest_trophies)}
            </TableCell>
            <TableCell className="hidden xl:table-cell text-center">
              <span className={
                member.win_rate != null && member.win_rate >= 60 
                  ? "text-green-500 font-medium" 
                  : member.win_rate != null && member.win_rate >= 50 
                    ? "text-yellow-500" 
                    : member.win_rate != null 
                      ? "text-red-500" 
                      : "text-muted-foreground"
              }>
                {member.win_rate != null ? `${member.win_rate}%` : "-"}
              </span>
            </TableCell>
            <TableCell className="hidden xl:table-cell">
              <span className={`inline-flex items-center gap-1 ${getRankColor(member.rank_current || "Unranked")}`}>
                <RankIcon rank={member.rank_current} />
                {member.rank_current || "Unranked"}
              </span>
            </TableCell>
            <TableCell className="hidden xl:table-cell">
              <span className={`inline-flex items-center gap-1 ${getRankColor(member.rank_highest || "Unranked")}`}>
                <RankIcon rank={member.rank_highest} />
                {member.rank_highest || "Unranked"}
              </span>
            </TableCell>
            <TableCell className="hidden md:table-cell text-right">
              <span className={
                member.trophies_24h != null && member.trophies_24h > 0 
                  ? "text-green-500" 
                  : member.trophies_24h != null && member.trophies_24h < 0 
                    ? "text-red-500" 
                    : "text-muted-foreground"
              }>
                {member.trophies_24h != null 
                  ? (member.trophies_24h > 0 ? "+" : "") + formatNumber(member.trophies_24h) 
                  : "N/A"}
              </span>
            </TableCell>
            <TableCell className="hidden sm:table-cell text-right">
              <span className={
                member.trophies_7d != null && member.trophies_7d > 0 
                  ? "text-green-500" 
                  : member.trophies_7d != null && member.trophies_7d < 0 
                    ? "text-red-500" 
                    : "text-muted-foreground"
              }>
                {member.trophies_7d != null 
                  ? (member.trophies_7d > 0 ? "+" : "") + formatNumber(member.trophies_7d) 
                  : "N/A"}
              </span>
            </TableCell>
            <TableCell className="text-center text-lg" title={`Last update: ${formatRelativeTime(member.last_updated)} (${formatDateTime(member.last_updated)})${member.last_battle_at ? ` • Last battle: ${formatRelativeTime(member.last_battle_at)} (${formatDateTime(member.last_battle_at)})` : ""}`}>
              {getActivityEmoji(member.activity_status || (member.is_active ? "minimal" : "inactive"))}
            </TableCell>
          </TableRow>
          ))
        )}
      </TableBody>
    </Table>
    </div>
    {showPagination && totalPages > 1 && (
      <div className="flex items-center justify-end gap-2 pt-4 px-1">
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
          <span className="text-sm font-medium px-2">
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
}
