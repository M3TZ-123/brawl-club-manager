"use client";

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

interface MembersTableProps {
  members: Member[];
}

export function MembersTable({ members }: MembersTableProps) {
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">#</TableHead>
          <TableHead>Player</TableHead>
          <TableHead>Role</TableHead>
          <TableHead className="text-right">Trophies</TableHead>
          <TableHead className="text-right">Highest</TableHead>
          <TableHead>Rank</TableHead>
          <TableHead className="text-center">Activity</TableHead>
          <TableHead className="text-right">3v3 Wins</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member, index) => (
          <TableRow key={member.player_tag}>
            <TableCell className="font-medium">{index + 1}</TableCell>
            <TableCell>
              <Link
                href={`/members/${encodeURIComponent(member.player_tag)}`}
                className="flex flex-col hover:underline"
              >
                <span className="font-medium">{member.player_name}</span>
                <span className="text-xs text-muted-foreground">
                  {member.player_tag}
                </span>
              </Link>
            </TableCell>
            <TableCell>
              <Badge variant={getRoleBadgeVariant(member.role)}>
                {member.role}
              </Badge>
            </TableCell>
            <TableCell className="text-right font-medium">
              {formatNumber(member.trophies)}
            </TableCell>
            <TableCell className="text-right text-muted-foreground">
              {formatNumber(member.highest_trophies)}
            </TableCell>
            <TableCell>
              <span className={getRankColor(member.rank_current || "Bronze")}>
                {member.rank_current || "Unranked"}
              </span>
            </TableCell>
            <TableCell className="text-center text-lg">
              {getActivityEmoji(member.is_active ? "active" : "inactive")}
            </TableCell>
            <TableCell className="text-right">
              {formatNumber(member.trio_victories)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
