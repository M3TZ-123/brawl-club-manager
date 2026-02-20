"use client";

import { ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Bell,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock3,
  Loader2,
  Pencil,
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

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [category, setCategory] = useState<"all" | "join" | "leave" | "inactive" | "promotion" | "name_change">("all");

  useEffect(() => {
    loadNotifications();
  }, []);

  const loadNotifications = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/notifications?limit=100");
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      }
    } catch (error) {
      console.error("Failed to load notifications:", error);
    } finally {
      setLoading(false);
    }
  };

  const markAsRead = async (id: number) => {
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, is_read: true } : n))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch (error) {
      console.error("Error marking as read:", error);
    }
  };

  const markAllAsRead = async () => {
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch (error) {
      console.error("Error marking all as read:", error);
    }
  };

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
      default:
        return { icon: Bell, color: "text-blue-500", bg: "border-l-blue-500" };
    }
  };

  const renderMessageWithMemberLinks = (message: string) => {
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

  const getDateHeading = (date: Date) => {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return "Today";
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  };

  const filtered = notifications.filter((n) => {
    if (filter === "unread" && n.is_read) return false;
    if (category === "all") return true;
    if (category === "promotion") return n.type === "promotion" || n.type === "demotion";
    return n.type === category;
  });

  const groupedByDate = filtered.reduce<Array<{ key: string; label: string; items: Notification[] }>>(
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
        label: getDateHeading(date),
        items: [notif],
      });
      return groups;
    },
    []
  );

  return (
    <LayoutWrapper>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bell className="h-6 w-6" />
            Notifications
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {unreadCount > 0 ? `${unreadCount} unread` : "All caught up!"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Filter tabs */}
          <div className="flex rounded-lg border bg-muted/30 p-0.5">
            <button
              onClick={() => setFilter("all")}
              className={cn(
                "px-3 py-1.5 text-sm rounded-md transition-colors",
                filter === "all"
                  ? "bg-background shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              All
            </button>
            <button
              onClick={() => setFilter("unread")}
              className={cn(
                "px-3 py-1.5 text-sm rounded-md transition-colors",
                filter === "unread"
                  ? "bg-background shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Unread{unreadCount > 0 && ` (${unreadCount})`}
            </button>
          </div>
          {unreadCount > 0 && (
            <Button variant="outline" size="sm" onClick={markAllAsRead}>
              <CheckCheck className="h-4 w-4 mr-1" />
              Mark all read
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={category === "all" ? "default" : "outline"} onClick={() => setCategory("all")}>All Types</Button>
        <Button size="sm" variant={category === "join" ? "default" : "outline"} onClick={() => setCategory("join")}>Joined</Button>
        <Button size="sm" variant={category === "leave" ? "default" : "outline"} onClick={() => setCategory("leave")}>Left</Button>
        <Button size="sm" variant={category === "inactive" ? "default" : "outline"} onClick={() => setCategory("inactive")}>Inactive</Button>
        <Button size="sm" variant={category === "promotion" ? "default" : "outline"} onClick={() => setCategory("promotion")}>Promotions</Button>
        <Button size="sm" variant={category === "name_change" ? "default" : "outline"} onClick={() => setCategory("name_change")}>Name Changes</Button>
      </div>

      {/* Notification list */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Bell className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-lg font-medium">
              {filter === "unread" ? "No unread notifications" : "No notifications found"}
            </p>
            <p className="text-sm mt-1">
              {filter === "unread"
                ? "You've read all your notifications."
                : "Try changing filters or wait for new club events."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {groupedByDate.map((group) => (
            <section key={group.key} className="space-y-2">
              <h2 className="text-base font-semibold text-foreground/90">{group.label}</h2>
              {group.items.map((notif) => {
                const style = getStyle(notif.type);
                const Icon = style.icon;

                return (
                  <Card
                    key={notif.id}
                    onClick={() => !notif.is_read && markAsRead(notif.id)}
                    className={cn(
                      "border-l-4 cursor-pointer transition-all",
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
                              {notif.title}
                            </span>
                            {!notif.is_read && (
                              <span className="text-[10px] uppercase tracking-wider font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                                New
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground mt-1 break-words">
                            {renderMessageWithMemberLinks(notif.message)}
                          </p>
                          <p className="text-xs text-muted-foreground/60 mt-2">
                            {new Date(notif.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </div>
    </LayoutWrapper>
  );
}
