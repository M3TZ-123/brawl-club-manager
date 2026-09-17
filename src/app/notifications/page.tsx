"use client";
import { T, useI18n, LocalDate } from "@/components/locale-provider";


import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { fetchJsonCached, invalidateJsonCache } from "@/lib/client-data-cache";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import { localizeNotificationForDisplay, type NotificationMessagePart } from "@/lib/notification-display";
import { useAdminSession } from "@/hooks/use-admin-session";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { TimeRangePicker } from "@/components/time-range-picker";
import { type TimeRangeKey } from "@/lib/time-range";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Bell,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock3,
  Database,
  Loader2,
  Pencil,
  TriangleAlert,
  UserMinus,
  UserPlus,
} from "lucide-react";

interface Notification {
  id: number;
  type: string;
  title: string;
  message: string;
  player_tag: string | null;
  player_name: string | null;
  is_read: boolean;
  created_at: string;
}

type NotificationMutationResponse = {
  success?: boolean;
  unreadCount?: number;
  error?: string;
};

type NotificationPageBoundary = { cursor: string } | { offset: number };

function getDateHeading(date: Date, locale: string) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  return new Intl.DateTimeFormat(locale === "ar" ? "ar-TN" : "en-GB", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export default function NotificationsPage() {
  const { locale, t, number } = useI18n();
  const { isAdmin, isLoading: sessionLoading } = useAdminSession();
  const session = useRef({ isAdmin, sessionLoading });
  session.current = { isAdmin, sessionLoading };
  const mutationController = useRef<AbortController | null>(null);
  const pendingMutation = useRef(false);
  const [mutating, setMutating] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextPage, setNextPage] = useState<NotificationPageBoundary | null>(null);
  const failedPage = useRef<NotificationPageBoundary | null>(null);
  const loadSequence = useRef(0);
  const [selectedRange, setSelectedRange] = useState<TimeRangeKey>("7d");
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [category, setCategory] = useState<"all" | "join" | "leave" | "inactive" | "promotion" | "name_change" | "capacity" | "battle_gap">("all");

  useEffect(() => {
    mutationController.current = new AbortController();
    const changed = () => {
      mutationController.current?.abort(); mutationController.current = new AbortController();
      pendingMutation.current = false; setMutating(false); setActionError(false);
      setCategory(value => value === "capacity" ? "all" : value);
    };
    window.addEventListener("admin-session-changed", changed);
    return () => {
      mutationController.current?.abort();
      window.removeEventListener("admin-session-changed", changed);
    };
  }, []);

  const loadNotifications = useCallback(async (force = false, page: NotificationPageBoundary | null = null) => {
    const sequence = ++loadSequence.current;
    failedPage.current = page;
    setLoadError(false);
    try {
      if (page === null) setLoading(true);
      else setLoadingMore(true);
      const params = new URLSearchParams({ limit: "100", range: selectedRange });
      if (page && "cursor" in page) params.set("cursor", page.cursor);
      else params.set("offset", String(page?.offset ?? 0));
      if (filter === "unread") params.set("unreadOnly", "true");
      if (category !== "all") {
        params.set("types", category === "promotion" ? "promotion,demotion" : category);
      }
      const data = await fetchJsonCached<{
        notifications?: Notification[];
        unreadCount?: number;
        nextOffset?: number | null;
        nextCursor?: string | null;
      }>(`/api/notifications?${params}`, {
        staleMs: 30_000,
        force,
      });
      if (sequence !== loadSequence.current) return;
      setNotifications((previous) => page === null
        ? data.notifications || []
        : Array.from(new Map(
          [...previous, ...(data.notifications || [])].map((notification) => [notification.id, notification])
        ).values()));
      setUnreadCount(data.unreadCount || 0);
      setNextPage(data.nextCursor !== undefined
        ? (data.nextCursor ? { cursor: data.nextCursor } : null)
        : (data.nextOffset != null ? { offset: data.nextOffset } : null));
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setLoadError(true);
      if (page === null) setNotifications([]);
      console.error("Failed to load notifications:", error);
    } finally {
      if (sequence === loadSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [category, filter, selectedRange]);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  useEffect(() => {
    const handleClubDataUpdated = () => {
      loadNotifications(true);
    };
    window.addEventListener("club-data-updated", handleClubDataUpdated);
    window.addEventListener("notifications-updated", handleClubDataUpdated);
    return () => {
      window.removeEventListener("club-data-updated", handleClubDataUpdated);
      window.removeEventListener("notifications-updated", handleClubDataUpdated);
    };
  }, [loadNotifications]);

  const markRead = async (id?: number) => {
    const current = mutationController.current;
    if (!session.current.isAdmin || session.current.sessionLoading || pendingMutation.current || !current || current.signal.aborted) return;
    pendingMutation.current = true; setMutating(true); setActionError(false);
    try {
      const data = await fetchJsonWithTimeout<NotificationMutationResponse>("/api/notifications", {
        method: "PATCH", signal: current.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id === undefined ? { all: true } : { ids: [id] }),
      });
      if (current.signal.aborted) return;
      if (data?.success !== true || !Number.isSafeInteger(data.unreadCount) || data.unreadCount! < 0) throw new Error("Invalid notification response");
      invalidateJsonCache("/api/notifications");
      setNotifications(previous => previous.map(row => id === undefined || row.id === id ? { ...row, is_read: true } : row));
      setUnreadCount(data.unreadCount!);
      window.dispatchEvent(new CustomEvent("notifications-updated"));
    } catch {
      if (!current.signal.aborted) setActionError(true);
    } finally {
      if (mutationController.current === current) pendingMutation.current = false;
      if (!current.signal.aborted) setMutating(false);
    }
  };
  const markAsRead = (id: number) => markRead(id);
  const markAllAsRead = () => markRead();

  const getStyle = (type: string) => {
    switch (type) {
      case "join":
        return { icon: UserPlus, color: "text-green-500", bg: "border-l-green-500" };
      case "leave":
        return { icon: UserMinus, color: "text-red-500", bg: "border-l-red-500" };
      case "inactive":
        return { icon: Clock3, color: "text-amber-500", bg: "border-l-amber-500" };
      case "promotion":
        return { icon: ChevronUp, color: "text-emerald-500", bg: "border-l-emerald-500" };
      case "demotion":
        return { icon: ChevronDown, color: "text-orange-500", bg: "border-l-orange-500" };
      case "name_change":
        return { icon: Pencil, color: "text-cyan-500", bg: "border-l-cyan-500" };
      case "capacity":
        return { icon: Database, color: "text-amber-500", bg: "border-l-amber-500" };
      case "battle_gap":
        return { icon: TriangleAlert, color: "text-amber-500", bg: "border-l-amber-500" };
      default:
        return { icon: Bell, color: "text-blue-500", bg: "border-l-blue-500" };
    }
  };

  const renderMessageWithMemberLinks = (message: string, messageParts?: NotificationMessagePart[]) => {
    if (messageParts) return messageParts.map((part, index) => part.tag
      ? <Link key={`${part.tag}-${index}`} href={`/members/${encodeURIComponent(part.tag)}`} className="font-medium text-primary hover:underline" onClick={event => event.stopPropagation()}>{part.text}</Link>
      : part.text);
    const parts: ReactNode[] = [];
    const regex = /([^,()]+?)\s\((#[A-Z0-9]+)\)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(message)) !== null) {
      const [full, , tag] = match;
      if (match.index > lastIndex) {
        parts.push(message.slice(lastIndex, match.index));
      }

      parts.push(
        <Link
          key={`${tag}-${match.index}`}
          href={`/members/${encodeURIComponent(tag)}`}
          className="font-medium text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {full.trim()}
        </Link>
      );

      lastIndex = match.index + full.length;
    }

    if (lastIndex < message.length) {
      parts.push(message.slice(lastIndex));
    }

    if (parts.length === 0) return message;
    return parts;
  };

  const filtered = useMemo(() => notifications.filter((n) => {
    if (filter === "unread" && n.is_read) return false;
    if (category === "all") return true;
    if (category === "promotion") return n.type === "promotion" || n.type === "demotion";
    return n.type === category;
  }), [category, filter, notifications]);

  const groupedByDate = useMemo(
    () => filtered.reduce<Array<{ key: string; label: string; items: Notification[] }>>(
      (groups, notif) => {
        const date = new Date(notif.created_at);
        const key = date.toDateString();
        const existing = groups.find((group) => group.key === key);
        if (existing) {
          existing.items.push(notif);
          return groups;
        }

        groups.push({
          key,
          label: getDateHeading(date, locale),
          items: [notif],
        });
        return groups;
      },
      []
    ),
    [filtered, locale]
  );

  return (
    <LayoutWrapper>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bell className="h-6 w-6" />
            <T text=" Notifications " /></h1>
          <p className="text-sm text-muted-foreground mt-1">
            {!loading && !loadError && (unreadCount > 0 ? <T text="{value0} unread across all periods" values={{ value0: String(unreadCount) }} /> : <T text="No unread notifications." />)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Filter tabs */}
          <div className="flex rounded-lg border bg-muted/30 p-0.5">
            <button
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
              className={cn(
                "px-3 py-1.5 text-sm rounded-md transition-colors",
                filter === "all"
                  ? "bg-background shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <T text=" All " /></button>
            <button
              aria-pressed={filter === "unread"} title={t("Unread count includes all periods")}
              onClick={() => setFilter("unread")}
              className={cn(
                "px-3 py-1.5 text-sm rounded-md transition-colors",
                filter === "unread"
                  ? "bg-background shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <T text=" Unread" />{unreadCount > 0 && ` (${unreadCount})`}
            </button>
          </div>
          {unreadCount > 0 && isAdmin && (
            <Button variant="outline" size="sm" disabled={mutating} onClick={markAllAsRead}>
              <CheckCheck className="h-4 w-4 me-1" />
              <T text=" Mark all read " /></Button>
          )}
        </div>
      </div>

      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <TimeRangePicker value={selectedRange} onChange={range => { if (range !== selectedRange) { setLoading(true); setSelectedRange(range); } }} />
        <select aria-label={t("Notification type")} value={category} onChange={event => setCategory(event.target.value as typeof category)} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="all">{t("All Types")}</option><option value="join">{t("Joined")}</option><option value="leave">{t("Left")}</option>
          <option value="inactive">{t("Inactive")}</option><option value="promotion">{t("Promotions")}</option><option value="name_change">{t("Name Changes")}</option>
          {isAdmin && <option value="capacity">{t("Database capacity")}</option>}
          <option value="battle_gap">{t("Battle history coverage")}</option>
        </select>
      </div>

      {loadError && <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm"><T text="Could not load notifications." /> <Button variant="ghost" onClick={() => loadNotifications(true, failedPage.current)}><T text="Retry" /></Button></div>}
      {actionError && <p role="alert" className="text-sm text-destructive"><T text="Could not update notifications. Please try again." /></p>}

      {/* Notification list */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : loadError && notifications.length === 0 ? null : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Bell className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-lg font-medium">
              {filter === "unread" ? <T text="No unread notifications" /> : <T text="No notifications found" />}
            </p>
            <p className="text-sm mt-1">
              {filter === "unread"
                ? <T text="No unread notifications match these filters." />
                : <T text="Try changing filters or wait for new club events." />}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {groupedByDate.map((group) => (
            <section key={group.key} className="space-y-2">
              <h2 className="text-base font-semibold text-foreground/90">{<T text={group.label} />}</h2>
              {group.items.map((notif) => {
                const style = getStyle(notif.type);
                const Icon = style.icon;
                const display = localizeNotificationForDisplay(notif, t, number);

                return (
                  <Card
                    key={notif.id}
                    className={cn(
                      "border-l-4 transition-all",
                      style.bg,
                      notif.is_read
                        ? "opacity-60 hover:opacity-80"
                        : "bg-primary/[0.02] hover:bg-primary/[0.05] shadow-sm"
                    )}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <span className={cn("mt-0.5 shrink-0", style.color)}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={cn("text-sm font-semibold", style.color)}>
                              {display.title}
                            </span>
                            {!notif.is_read && (
                              <span className="text-[10px] uppercase tracking-wider font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                                <T text=" New " /></span>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground mt-1 break-words">
                            {renderMessageWithMemberLinks(display.message, display.messageParts)}
                          </p>
                          <p className="text-xs text-muted-foreground/60 mt-2">
                            <LocalDate value={notif.created_at} time />
                          </p>
                          {isAdmin && !notif.is_read && <Button variant="ghost" size="sm" className="mt-2" disabled={mutating} onClick={() => markAsRead(notif.id)}>
                            <T text="Mark as read" />
                          </Button>}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </section>
          ))}
          {nextPage !== null && (
            <div className="text-center">
              <Button variant="outline" disabled={loadingMore} onClick={() => loadNotifications(false, nextPage)}>
                {loadingMore ? <T text="Loading..." /> : <T text="Load More" />}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
    </LayoutWrapper>
  );
}
