"use client";

import { useEffect, useState } from "react";
import { LayoutWrapper } from "@/components/layout-wrapper";
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
import { Button } from "@/components/ui/button";
import { MemberHistory } from "@/types/database";
import { formatDate, formatDateTime } from "@/lib/utils";
import { Search, UserPlus, UserMinus, Pencil, Check, X, Trash2 } from "lucide-react";

const MIN_VALID_DATE_MS = new Date("2000-01-01T00:00:00.000Z").getTime();

function formatSafeDate(value: string | null | undefined, withTime = false): string {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  const ts = parsed.getTime();
  if (Number.isNaN(ts) || ts < MIN_VALID_DATE_MS) return "Unknown";
  return withTime ? formatDateTime(parsed.toISOString()) : formatDate(parsed.toISOString());
}

export default function HistoryPage() {
  const [history, setHistory] = useState<MemberHistory[]>([]);
  const [filteredHistory, setFilteredHistory] = useState<MemberHistory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "current" | "former">("all");
  const [timeRange, setTimeRange] = useState<"all" | "7" | "30" | "90">("30");
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    loadHistory();
  }, [timeRange]);

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
      const query = timeRange === "all" ? "" : `?days=${timeRange}`;
      const response = await fetch(`/api/history${query}`);
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
      return <Badge variant="destructive">Former</Badge>;
    }
    if (h.times_left > 0 || h.times_joined > 1) {
      return <Badge variant="warning">🔄 Returned ({h.times_joined}x)</Badge>;
    }
    return <Badge variant="success">⭐ Original</Badge>;
  };

  const startEditingNote = (playerTag: string, currentNote: string | null) => {
    setEditingTag(playerTag);
    setEditingNote(currentNote || "");
  };

  const cancelEditingNote = () => {
    setEditingTag(null);
    setEditingNote("");
  };

  const saveNote = async (playerTag: string) => {
    try {
      setSavingNote(true);
      const response = await fetch("/api/history", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_tag: playerTag, notes: editingNote.trim() }),
      });
      if (response.ok) {
        setHistory((prev) =>
          prev.map((h) =>
            h.player_tag === playerTag ? { ...h, notes: editingNote.trim() || null } : h
          )
        );
        setEditingTag(null);
        setEditingNote("");
      }
    } catch (error) {
      console.error("Error saving note:", error);
    } finally {
      setSavingNote(false);
    }
  };

  const currentCount = history.filter((h) => h.is_current_member).length;
  const formerCount = history.filter((h) => !h.is_current_member).length;
  const returningCount = history.filter((h) => h.times_joined > 1).length;

  return (
    <LayoutWrapper>
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
                    <select
                      value={timeRange}
                      onChange={(e) => setTimeRange(e.target.value as typeof timeRange)}
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="all">All Time</option>
                      <option value="7">Last 7 Days</option>
                      <option value="30">Last 30 Days</option>
                      <option value="90">Last 90 Days</option>
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
                  <div className="overflow-x-auto -mx-4 sm:mx-0">
                  <Table className="min-w-[700px] sm:min-w-full">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Player</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="hidden sm:table-cell">First Joined</TableHead>
                        <TableHead className="hidden sm:table-cell">Left At</TableHead>
                        <TableHead className="hidden lg:table-cell">Role At Leave</TableHead>
                        <TableHead className="hidden lg:table-cell">Trophies At Leave</TableHead>
                        <TableHead className="text-center">Joined</TableHead>
                        <TableHead className="text-center">Left</TableHead>
                        <TableHead className="hidden md:table-cell">Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredHistory.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                            No member history found
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredHistory.map((h) => (
                          <TableRow key={h.player_tag}>
                            <TableCell>
                              <div>
                                <p className="font-medium truncate max-w-[120px] sm:max-w-none">{h.player_name}</p>
                                <p className="text-xs text-muted-foreground">{h.player_tag}</p>
                              </div>
                            </TableCell>
                            <TableCell>{getMemberBadge(h)}</TableCell>
                            <TableCell className="hidden sm:table-cell text-muted-foreground">
                              {formatSafeDate(h.first_seen)}
                            </TableCell>
                            <TableCell className="hidden sm:table-cell text-muted-foreground">
                              {formatSafeDate(h.last_left_at || (!h.is_current_member ? h.last_seen : null), true)}
                            </TableCell>
                            <TableCell className="hidden lg:table-cell text-muted-foreground">
                              {!h.is_current_member ? (h.role_at_leave || "Unknown") : "-"}
                            </TableCell>
                            <TableCell className="hidden lg:table-cell text-muted-foreground">
                              {!h.is_current_member
                                ? (typeof h.trophies_at_leave === "number" ? h.trophies_at_leave.toLocaleString() : "Unknown")
                                : "-"}
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
                            <TableCell className="hidden md:table-cell max-w-[200px]">
                              {editingTag === h.player_tag ? (
                                <div className="flex items-center gap-1">
                                  <Input
                                    value={editingNote}
                                    onChange={(e) => setEditingNote(e.target.value)}
                                    placeholder="Add a note..."
                                    className="h-8 text-sm"
                                    autoFocus
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") saveNote(h.player_tag);
                                      if (e.key === "Escape") cancelEditingNote();
                                    }}
                                  />
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 shrink-0"
                                    onClick={() => saveNote(h.player_tag)}
                                    disabled={savingNote}
                                  >
                                    <Check className="h-3.5 w-3.5 text-green-500" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 shrink-0"
                                    onClick={cancelEditingNote}
                                  >
                                    <X className="h-3.5 w-3.5 text-red-500" />
                                  </Button>
                                </div>
                              ) : (
                                <div
                                  className="flex items-center gap-1 cursor-pointer group"
                                  onClick={() => startEditingNote(h.player_tag, h.notes)}
                                  title="Click to edit note"
                                >
                                  <span className="text-muted-foreground truncate">
                                    {h.notes || "-"}
                                  </span>
                                  <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                                  {h.notes && (
                                    <button
                                      className="h-5 w-5 flex items-center justify-center rounded hover:bg-destructive/20 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                      title="Delete note"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setEditingNote("");
                                        setSavingNote(true);
                                        fetch("/api/history", {
                                          method: "PATCH",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ player_tag: h.player_tag, notes: "" }),
                                        }).then((res) => {
                                          if (res.ok) {
                                            setHistory((prev) =>
                                              prev.map((item) =>
                                                item.player_tag === h.player_tag ? { ...item, notes: null } : item
                                              )
                                            );
                                          }
                                        }).finally(() => setSavingNote(false));
                                      }}
                                    >
                                      <Trash2 className="h-3 w-3 text-red-500" />
                                    </button>
                                  )}
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                  </div>
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
                      Never left since joining — loyal member
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="warning">🔄 Returned</Badge>
                    <span className="text-sm text-muted-foreground">
                      Left at least once but came back
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
    </LayoutWrapper>
  );
}
