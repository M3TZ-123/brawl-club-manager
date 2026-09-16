"use client";
import { T, useI18n, LocalDate } from "@/components/locale-provider";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { TimeRangePicker } from "@/components/time-range-picker";
import { ClubRetention } from "@/components/club-retention";
import { ClubIdentity } from "@/components/club-identity";
import { type TimeRangeKey } from "@/lib/time-range";
import { clubRoleLabel } from "@/lib/club-role";
import { invalidateJsonCache } from "@/lib/client-data-cache";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import { useAdminSession } from "@/hooks/use-admin-session";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import Link from "next/link";
import { HistoryMemberCard } from "@/components/history-member-card";
import { MemberReviewSheet } from "@/components/member-review";
import { Search, UserPlus, UserMinus, Pencil, Check, X, Trash2 } from "lucide-react";

export default function HistoryPage() {
  const { number } = useI18n();
  const { t } = useI18n();
  const { isAdmin, isLoading: sessionLoading } = useAdminSession();
  const [history, setHistory] = useState<MemberHistory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "current" | "former">("all");
  const [timeRange, setTimeRange] = useState<TimeRangeKey | "all">("7d");
  const [loadError, setLoadError] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [sessionRevision, setSessionRevision] = useState(0);
  const loadSequence = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const authBlocked = useRef(!isAdmin);
  const mounted = useRef(false);
  const [noteEditor, setNoteEditor] = useState<{ tag: string; note: string; updatedAt: string | null } | null>(null);
  const editingTag = noteEditor?.tag ?? null;
  const editingNote = noteEditor?.note ?? "";
  const [savingNote, setSavingNote] = useState(false);
  const noteSaveInFlight = useRef(false);
  const [reviewMember, setReviewMember] = useState<MemberHistory | null>(null);
  const cancelRead = useCallback(() => { loadSequence.current++; readController.current?.abort(); }, []);

  const loadHistory = useCallback(async () => {
    const sequence = ++loadSequence.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setIsLoading(true);
    setLoadError(false);
    try {
      const query = `?range=${timeRange}`;
      const data = await fetchJsonWithTimeout<{ history?: MemberHistory[] }>(`/api/history${query}`, {
        cache: "no-store", signal: controller.signal,
      });
      if (controller.signal.aborted || sequence !== loadSequence.current) return;
      setHistory(data.history || []);
    } catch (error) {
      if (controller.signal.aborted || sequence !== loadSequence.current) return;
      setLoadError(true);
      setHistory([]);
      console.error("Error loading history:", error);
    } finally {
      if (!controller.signal.aborted && sequence === loadSequence.current) setIsLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    mounted.current = true;
    const resetSession = () => {
      authBlocked.current = true;
      cancelRead();
      writeController.current?.abort();
      noteSaveInFlight.current = false;
      setHistory([]); setNoteEditor(null); setReviewMember(null); setNoteError(""); setSavingNote(false);
      setSessionRevision(value => value + 1);
    };
    window.addEventListener("admin-session-changed", resetSession);
    return () => {
      mounted.current = false; authBlocked.current = true;
      cancelRead(); writeController.current?.abort();
      window.removeEventListener("admin-session-changed", resetSession);
    };
  }, [cancelRead]);

  useEffect(() => {
    if (sessionLoading) return;
    authBlocked.current = !isAdmin;
    void loadHistory();
    return cancelRead;
  }, [loadHistory, isAdmin, sessionLoading, sessionRevision, cancelRead]);

  useEffect(() => {
    const handleClubDataUpdated = () => {
      if (!sessionLoading) void loadHistory();
    };
    window.addEventListener("club-data-updated", handleClubDataUpdated);
    window.addEventListener("member-reviews-updated", handleClubDataUpdated);
    return () => { window.removeEventListener("club-data-updated", handleClubDataUpdated); window.removeEventListener("member-reviews-updated", handleClubDataUpdated); };
  }, [loadHistory, sessionLoading]);

  const filteredHistory = useMemo(() => {
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

    return filtered;
  }, [history, searchQuery, filter]);

  const getMemberBadge = (h: MemberHistory) => {
    if (!h.is_current_member) {
      return <Badge variant="destructive"><T text="Former" /></Badge>;
    }
    if (h.times_left > 0 || h.times_joined > 1) {
      return <Badge variant="warning"><T text="Returned" /></Badge>;
    }
    return <Badge variant="success"><T text="Current" /></Badge>;
  };

  const startEditingNote = (member: MemberHistory) => {
    if (!isAdmin || authBlocked.current) return;
    setNoteError("");
    setNoteEditor({ tag: member.player_tag, note: member.notes || "", updatedAt: member.review_updated_at ?? null });
  };

  const cancelEditingNote = () => {
    setNoteEditor(null);
  };

  const saveNote = async (playerTag: string, value = editingNote) => {
    if (!isAdmin || sessionLoading || authBlocked.current || !mounted.current || noteSaveInFlight.current) return;
    const controller = new AbortController();
    writeController.current = controller;
    noteSaveInFlight.current = true;
    setNoteError("");
    try {
      setSavingNote(true);
      const expectedUpdatedAt = noteEditor?.tag === playerTag ? noteEditor.updatedAt : history.find(member => member.player_tag === playerTag)?.review_updated_at ?? null;
      const data = await fetchJsonWithTimeout<{ review: { notes: string | null; updated_at: string } }>("/api/history", {
        method: "PATCH",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_tag: playerTag, notes: value.trim(), expected_updated_at: expectedUpdatedAt }),
      });
      if (!controller.signal.aborted && mounted.current) {
        invalidateJsonCache("/api/history");
        setHistory((prev) =>
          prev.map((h) =>
            h.player_tag === playerTag ? { ...h, notes: data.review.notes, review_updated_at: data.review.updated_at } : h
          )
        );
        // A delayed save must not close a different member's editor, or erase
        // further typing in the same editor while that save was in flight.
        setNoteEditor(current => current?.tag !== playerTag ? current : current.note.trim() === value.trim() ? null : { ...current, updatedAt: data.review.updated_at });
        window.dispatchEvent(new CustomEvent("member-reviews-updated"));
      }
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      setNoteError(error instanceof Error && error.message === "Review changed. Reload before saving."
        ? "This note changed elsewhere. Your draft is preserved. Open Member notes to review the latest saved note."
        : "Could not save the note. Your changes are still available to retry.");
      console.error("Error saving note:", error);
    } finally {
      if (writeController.current === controller) noteSaveInFlight.current = false;
      if (!controller.signal.aborted && mounted.current) setSavingNote(false);
    }
  };

  const currentCount = history.filter((h) => h.is_current_member).length;
  const formerCount = history.filter((h) => !h.is_current_member).length;
  const returningCount = history.filter((h) => h.times_joined > 1).length;

  return (
    <LayoutWrapper>
      <div className="space-y-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div><h1 className="text-2xl font-bold"><T text="Member History" /></h1><p className="mt-1 text-sm text-muted-foreground"><T text="Membership records matching this period" /></p></div>
          <TimeRangePicker value={timeRange} onChange={range => { if (range !== timeRange) { setIsLoading(true); setTimeRange(range); } }} includeAll />
        </div>
        {loadError && <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm"><T text="Could not load member history." /> <Button variant="ghost" onClick={() => loadHistory()}><T text="Retry" /></Button></div>}
        {isAdmin && noteError && <p role="alert" className="text-sm text-destructive"><T text={noteError} /></p>}
        {/* Stats */}
        <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-card p-3 text-sm sm:grid-cols-4">
          {([["Total Records", history.length], ["Current Members", currentCount], ["Former Members", formerCount], ["Returning Members", returningCount]] as const).map(([label, count]) => <div key={label}><dt className="text-xs text-muted-foreground"><T text={label} /></dt><dd className="mt-1 text-lg font-semibold">{isLoading || loadError ? "—" : number(count)}</dd></div>)}
        </dl>

            {/* History Table */}
            <Card>
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <CardTitle><T text="Members" /></CardTitle>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <div className="relative">
                      <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder={t("Search players...")} aria-label={t("Search players...")}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="ps-10 w-full sm:w-64"
                      />
                    </div>
                    <select
                      aria-label={t("Membership status")}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value as typeof filter)}
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="all"><T text="All Members" /></option>
                      <option value="current"><T text="Current Members" /></option>
                      <option value="former"><T text="Former Members" /></option>
                    </select>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                  </div>
                ) : loadError ? null : (
                  <>
                  <p className="mb-3 text-xs text-muted-foreground"><T text="First observed is not an exact joining date." /></p>
                  <div className="space-y-3 md:hidden">{filteredHistory.length ? filteredHistory.map(member => <HistoryMemberCard key={member.player_tag} member={member} isAdmin={isAdmin} onReview={() => setReviewMember(member)} />) : <p><T text="No member history found" /></p>}</div>
                  <div className="hidden overflow-x-auto md:block">
                  <Table className="min-w-[700px] sm:min-w-full">
                    <TableHeader>
                      <TableRow>
                        <TableHead><T text="Player" /></TableHead>
                        <TableHead><T text="Status" /></TableHead>
                        <TableHead className="hidden sm:table-cell"><T text="First observed" /></TableHead>
                        <TableHead className="hidden sm:table-cell"><T text="Left At" /></TableHead>
                        <TableHead className="hidden lg:table-cell"><T text="Role At Leave" /></TableHead>
                        <TableHead className="hidden lg:table-cell"><T text="Trophies At Leave" /></TableHead>
                        <TableHead className="text-center"><T text="Joined" /></TableHead>
                        <TableHead className="text-center"><T text="Left" /></TableHead>
                        <TableHead><T text="Member notes" /></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredHistory.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                            <T text=" No member history found " /></TableCell>
                        </TableRow>
                      ) : (
                        filteredHistory.map((h) => (
                          <TableRow key={h.player_tag}>
                            <TableCell>
                              <div>
                                <p className="font-medium truncate max-w-[120px] sm:max-w-none"><Link href={`/members/${encodeURIComponent(h.player_tag)}`}><bdi>{h.player_name}</bdi></Link></p>
                                <p className="text-xs text-muted-foreground"><bdi dir="ltr">{h.player_tag}</bdi></p>
                              </div>
                            </TableCell>
                            <TableCell>{getMemberBadge(h)}</TableCell>
                            <TableCell className="hidden sm:table-cell text-muted-foreground">
                              <LocalDate value={h.first_seen} />
                            </TableCell>
                            <TableCell className="hidden sm:table-cell text-muted-foreground">
                              <LocalDate value={h.last_left_at} time />
                            </TableCell>
                            <TableCell className="hidden lg:table-cell text-muted-foreground">
                              {!h.is_current_member ? t(clubRoleLabel(h.role_at_leave)) : "-"}
                            </TableCell>
                            <TableCell className="hidden lg:table-cell text-muted-foreground">
                              {!h.is_current_member
                                ? (typeof h.trophies_at_leave === "number" ? number(h.trophies_at_leave) : t("Unknown"))
                                : "-"}
                            </TableCell>
                            <TableCell className="text-center">
                              <span className="inline-flex items-center gap-1 text-green-500">
                                <UserPlus className="h-3 w-3" />
                                {h.times_joined == null ? t("Unknown") : number(h.times_joined)}
                              </span>
                            </TableCell>
                            <TableCell className="text-center">
                              <span className="inline-flex items-center gap-1 text-red-500">
                                <UserMinus className="h-3 w-3" />
                                {h.times_left == null ? t("Unknown") : number(h.times_left)}
                              </span>
                            </TableCell>
                            <TableCell className="max-w-[240px]">
                              {isAdmin ? <div className="space-y-2"><Button variant="outline" size="sm" onClick={() => setReviewMember(h)}><T text="Member notes" /></Button>
                              {editingTag === h.player_tag ? (
                                <div className="flex items-center gap-1">
                                  <Input
                                    value={editingNote}
                                    onChange={(e) => setNoteEditor(current => current ? { ...current, note: e.target.value } : current)}
                                    placeholder={t("Add a note...")}
                                    aria-label={t("Member notes")}
                                    maxLength={1000}
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
                                    aria-label={t("Save note")}
                                    className="h-7 w-7 shrink-0"
                                    onClick={() => saveNote(h.player_tag)}
                                    disabled={savingNote}
                                  >
                                    <Check className="h-3.5 w-3.5 text-green-500" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={t("Cancel")}
                                    className="h-7 w-7 shrink-0"
                                    onClick={cancelEditingNote}
                                  >
                                    <X className="h-3.5 w-3.5 text-red-500" />
                                  </Button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-1 group">
                                  <button
                                  className="flex min-w-0 items-center gap-1 text-start"
                                  onClick={() => startEditingNote(h)}
                                  title={t("Click to edit note")}
                                >
                                  <span className="text-muted-foreground truncate">
                                    {isAdmin ? h.notes || "-" : "-"}
                                  </span>
                                  {isAdmin && (
                                    <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                                  )}
                                  </button>
                                  {h.notes && isAdmin && (
                                    <button
                                      className="h-5 w-5 flex items-center justify-center rounded hover:bg-destructive/20 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                      title={t("Delete note")}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (!isAdmin) return;
                                        void saveNote(h.player_tag, "");
                                      }}
                                    >
                                      <Trash2 className="h-3 w-3 text-red-500" />
                                    </button>
                                  )}
                                </div>
                              )}
                              </div> : <Button asChild variant="outline" size="sm"><Link href={`/reviews?member=${encodeURIComponent(h.player_tag)}`}><T text="Sign in for member notes" /></Link></Button>}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                  </div></>
                )}
              </CardContent>
            </Card>

            {/* Legend */}
            <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer font-medium"><T text="Understanding member history" /></summary><div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-4">
                  <div className="flex items-center gap-2">
                    <Badge variant="success"><T text="Current" /></Badge>
                    <span className="text-sm text-muted-foreground">
                      <T text=" Currently in the club " /></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="warning"><T text="🔄 Returned" /></Badge>
                    <span className="text-sm text-muted-foreground">
                      <T text=" Left at least once but came back " /></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="destructive"><T text="Former" /></Badge>
                    <span className="text-sm text-muted-foreground">
                      <T text=" No longer in the club " /></span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground"><T text="First observed is the earliest retained evidence, not the actual join date. Counts cover the tracked history only." /></p>
                <p className="text-xs text-muted-foreground"><T text="Private member notes can record why someone left or was removed. These reasons are entered by administrators." /></p>
                {!isAdmin && <p className="text-sm"><Link href="/reviews" className="text-primary underline"><T text="Sign in to view or add member notes" /></Link></p>}
              </div></details>
            <details className="rounded-xl border bg-card p-4"><summary className="cursor-pointer font-semibold"><T text="Club growth and retention" /></summary><div className="grid gap-4 pt-4 xl:grid-cols-2"><ClubRetention /><ClubIdentity showHistory /></div></details>
          </div>
      {isAdmin && reviewMember && <MemberReviewSheet key={reviewMember.player_tag} member={reviewMember} open onOpenChange={open => { if (!open) setReviewMember(null); }} />}
    </LayoutWrapper>
  );
}
