"use client";

import { useState } from "react";
import { Member } from "@/types/database";
import { formatNumber, getActivityEmoji, getRankColor } from "@/lib/utils";
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
import { Copy, Check, ChevronLeft, ChevronRight } from "lucide-react";

interface MemberWithGains extends Member {
  trophies_24h?: number | null;
  trophies_7d?: number | null;
}

interface MembersTableProps {
  members: MemberWithGains[];
  pageSize?: number;
  showPagination?: boolean;
}

export function MembersTable({ members, pageSize = 15, showPagination = true }: MembersTableProps) {
  const [copiedTag, setCopiedTag] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(members.length / pageSize));
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedMembers = showPagination ? members.slice(startIndex, startIndex + pageSize) : members;

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
        {paginatedMembers.map((member, index) => (
          <TableRow key={member.player_tag}>
            <TableCell className="font-medium">{startIndex + index + 1}</TableCell>
            <TableCell>
              <div className="flex items-center gap-1 sm:gap-2">
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
              <span className={getRankColor(member.rank_current || "Unranked")}>
                {member.rank_current || "Unranked"}
              </span>
            </TableCell>
            <TableCell className="hidden xl:table-cell">
              <span className={getRankColor(member.rank_highest || "Unranked")}>
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
                  : "-"}
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
                  : "-"}
              </span>
            </TableCell>
            <TableCell className="text-center text-lg">
              {getActivityEmoji(member.is_active ? "active" : "inactive")}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </div>
    {showPagination && totalPages > 1 && (
      <div className="flex items-center justify-between pt-4 px-1">
        <p className="text-sm text-muted-foreground">
          Showing {startIndex + 1}-{Math.min(startIndex + pageSize, members.length)} of {members.length}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </Button>
          <span className="text-sm font-medium px-2">
            {currentPage} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    )}
    </>
  );
}
