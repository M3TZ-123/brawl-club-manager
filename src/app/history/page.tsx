"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { MemberHistory } from "@/types/database";
import { formatDate, formatDateTime } from "@/lib/utils";
import { Search, UserPlus, UserMinus, Star, RefreshCw } from "lucide-react";

export default function HistoryPage() {
  const [history, setHistory] = useState<MemberHistory[]>([]);
  const [filteredHistory, setFilteredHistory] = useState<MemberHistory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "current" | "former">("all");

  useEffect(() => {
    loadHistory();
  }, []);

  useEffect(() => {
    let filtered = [...history];

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter(
        (h) =>
          h.player_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          h.player_tag.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Status filter
    if (filter === "current") {
      filtered = filtered.filter((h) => h.is_current_member);
    } else if (filter === "former") {
      filtered = filtered.filter((h) => !h.is_current_member);
    }

    setFilteredHistory(filtered);
  }, [history, searchQuery, filter]);

  const loadHistory = async () => {
    try {
      const response = await fetch("/api/history");
      if (response.ok) {
        const data = await response.json();
        setHistory(data.history || []);
      }
    } catch (error) {
      console.error("Error loading history:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const getMemberBadge = (h: MemberHistory) => {
    if (!h.is_current_member) {
      return <Badge variant="destructive">Former Member</Badge>;
    }
    if (h.times_joined === 1 && h.times_left === 0) {
      return <Badge variant="success">⭐ Original</Badge>;
    }
    if (h.times_joined > 1) {
      return <Badge variant="warning">🔄 Returned ({h.times_joined}x)</Badge>;
    }
    return <Badge variant="default">Current</Badge>;
  };

  const currentCount = history.filter((h) => h.is_current_member).length;
  const formerCount = history.filter((h) => !h.is_current_member).length;
  const returningCount = history.filter((h) => h.times_joined > 1).length;

  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          <div className="space-y-6">
            {/* Stats */}
            <div className="grid gap-4 md:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Total Records</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{history.length}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Current Members</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-500">{currentCount}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Former Members</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-red-500">{formerCount}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Returning Members</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-yellow-500">{returningCount}</div>
                </CardContent>
              </Card>
            </div>

            {/* History Table */}
            <Card>
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <CardTitle>Member History</CardTitle>
                    <CardDescription>
                      Track who has been in your club and identify returning members
                    </CardDescription>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Search players..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10 w-full sm:w-64"
                      />
                    </div>
                    <select
                      value={filter}
                      onChange={(e) => setFilter(e.target.value as typeof filter)}
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="all">All Members</option>
                      <option value="current">Current Members</option>
                      <option value="former">Former Members</option>
                    </select>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Player</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>First Joined</TableHead>
                        <TableHead>Last Seen</TableHead>
                        <TableHead className="text-center">Joined</TableHead>
                        <TableHead className="text-center">Left</TableHead>
                        <TableHead>Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredHistory.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                            No member history found
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredHistory.map((h) => (
                          <TableRow key={h.player_tag}>
                            <TableCell>
                              <div>
                                <p className="font-medium">{h.player_name}</p>
                                <p className="text-xs text-muted-foreground">{h.player_tag}</p>
                              </div>
                            </TableCell>
                            <TableCell>{getMemberBadge(h)}</TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatDate(h.first_seen)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatDate(h.last_seen)}
                            </TableCell>
                            <TableCell className="text-center">
                              <span className="inline-flex items-center gap-1 text-green-500">
                                <UserPlus className="h-3 w-3" />
                                {h.times_joined}
                              </span>
                            </TableCell>
                            <TableCell className="text-center">
                              <span className="inline-flex items-center gap-1 text-red-500">
                                <UserMinus className="h-3 w-3" />
                                {h.times_left}
                              </span>
                            </TableCell>
                            <TableCell className="text-muted-foreground max-w-[200px] truncate">
                              {h.notes || "-"}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* Legend */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Member Status Legend</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-4">
                  <div className="flex items-center gap-2">
                    <Badge variant="success">⭐ Original</Badge>
                    <span className="text-sm text-muted-foreground">
                      Never left since joining
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="warning">🔄 Returned</Badge>
                    <span className="text-sm text-muted-foreground">
                      Left and rejoined the club
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="default">Current</Badge>
                    <span className="text-sm text-muted-foreground">
                      Currently in the club
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="destructive">Former</Badge>
                    <span className="text-sm text-muted-foreground">
                      No longer in the club
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
