"use client";

import { ReactNode, createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAppStore } from "@/lib/store";
import { useAdminSession } from "@/hooks/use-admin-session";
import { cn, formatDateTime } from "@/lib/utils";
import { fetchJsonCached, invalidateJsonCache } from "@/lib/client-data-cache";
import {
  LayoutDashboard,
  Users,
  FileText,
  History,
  Settings,
  RefreshCw,
  Trophy,
  Swords,
  PanelLeft,
  X,
  Bell,
  ChevronDown,
  ChevronUp,
  Clock3,
  Pencil,
  UserMinus,
  UserPlus,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Members", href: "/members", icon: Users },
  { name: "Leaderboard", href: "/activity", icon: Trophy },
  { name: "Battle Feed", href: "/battle-feed", icon: Swords },
  { name: "Reports", href: "/reports", icon: FileText },
  { name: "History", href: "/history", icon: History },
  { name: "Notifications", href: "/notifications", icon: Bell },
  { name: "Settings", href: "/settings", icon: Settings, adminOnly: true },
  { name: "Admin", href: "/admin", icon: ShieldCheck, adminOnly: true },
];

// Simple sidebar context
type SidebarContextType = {
  isOpen: boolean;
  toggle: () => void;
  close: () => void;
};

const SidebarContext = createContext<SidebarContextType | null>(null);

export function useSidebarContext() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebarContext must be used within LayoutWrapper");
  }
  return context;
}

function SimpleSidebar() {
  const pathname = usePathname();
  const { clubName, lastSyncTime, isSyncing, clubTag, apiKeyConfigured, notificationsEnabled } = useAppStore();
  const { isOpen, close } = useSidebarContext();
  const { isAdmin, isLoading: isAdminLoading } = useAdminSession();

  // Ensure settings (including lastSyncTime) are loaded from DB on any page
  useEffect(() => {
    useAppStore.getState().loadSettingsFromDB();
  }, []);

  const handleSync = useCallback(async () => {
    if (!clubTag || !apiKeyConfigured) return;
    if (!isAdmin) {
      alert("Admin login required to sync club data.");
      return;
    }
    
    try {
      useAppStore.getState().setIsSyncing(true);
      const response = await fetch("/api/sync", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clubTag }),
      });
      const data = await response.json();
      if (!response.ok) {
        console.error("Sync error:", data.error);
        alert(`Sync failed: ${data.error}`);
      } else {
        const syncTime = new Date().toISOString();
        invalidateJsonCache();
        useAppStore.getState().setLastSyncTime(syncTime);
        // Persist last_sync_time to DB immediately (before potential reload)
        fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ last_sync_time: syncTime }),
        }).catch(() => {});
        // Check if there were any member changes (joins/leaves)
        const hasChanges = data.changes?.joins?.length > 0 || data.changes?.leaves?.length > 0;
        window.dispatchEvent(new CustomEvent("club-data-updated", {
          detail: { changes: data.changes, syncTime },
        }));
        if (hasChanges && notificationsEnabled) {
          // Show browser notification if permitted
          if (Notification.permission === "granted") {
            const joins = data.changes?.joins?.length || 0;
            const leaves = data.changes?.leaves?.length || 0;
            let message = "";
            if (joins > 0) message += `${joins} member(s) joined`;
            if (joins > 0 && leaves > 0) message += ", ";
            if (leaves > 0) message += `${leaves} member(s) left`;
            new Notification("Club Update", { body: message, icon: "/favicon.ico" });
          }
        }
      }
    } catch (error) {
      console.error("Sync failed:", error);
      alert("Sync failed. Check the console for details.");
    } finally {
      useAppStore.getState().setIsSyncing(false);
    }
  }, [apiKeyConfigured, clubTag, isAdmin, notificationsEnabled]);

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 md:hidden" 
          onClick={close}
        />
      )}
      
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed top-0 left-0 z-50 h-full w-64 bg-card border-r border-border transform transition-transform duration-200 ease-in-out",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between h-16 px-4 border-b border-border">
            <Link href="/" className="flex items-center gap-3">
              <div className="flex aspect-square size-10 items-center justify-center rounded-xl bg-gradient-to-br from-yellow-400 to-orange-500 shadow-lg">
                <Trophy className="size-6 text-white" />
              </div>
              <div className="flex flex-col">
                <span className="font-bold text-base text-foreground">Club Manager</span>
                {clubName && (
                  <span className="text-xs text-muted-foreground truncate max-w-[120px]">{clubName}</span>
                )}
              </div>
            </Link>
            <Button variant="ghost" size="icon" className="md:hidden" onClick={close}>
              <X className="h-5 w-5" />
            </Button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-3 py-4 space-y-1">
            {navigation
              .filter((item) => !item.adminOnly || isAdmin)
              .map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={() => {
                    // Only close on mobile
                    if (window.innerWidth < 768) {
                      close();
                    }
                  }}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg font-medium transition-all duration-200",
                    isActive 
                      ? "bg-primary text-primary-foreground" 
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <item.icon className="size-5" />
                  <span>{item.name}</span>
                </Link>
              );
            })}
          </nav>

          {/* Sync */}
          <div className="border-t border-border px-3 py-4">
            <Button
              onClick={handleSync}
              disabled={isSyncing || !clubTag || !apiKeyConfigured || !isAdmin || isAdminLoading}
              variant="outline"
              className="w-full justify-center gap-2 border-border"
            >
              <RefreshCw className={cn("size-4", isSyncing && "animate-spin")} />
              <span>{isSyncing ? "Syncing..." : "Sync Now"}</span>
            </Button>
            {lastSyncTime && (
              <p className="text-xs text-muted-foreground text-center mt-2">
                Last: {new Date(lastSyncTime).toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

interface NotificationItem {
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
  unreadCount?: number;
  error?: string;
};

function SimpleHeader() {
  const { clubName, theme, setTheme } = useAppStore();
  const { toggle } = useSidebarContext();
  const { isAdmin } = useAdminSession();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const loadNotifications = useCallback(async (force = false) => {
    try {
      const data = await fetchJsonCached<{
        notifications: NotificationItem[];
        unreadCount?: number;
      }>("/api/notifications?limit=5", {
        staleMs: 30_000,
        force,
      });
      setNotifications(data.notifications || []);
      setUnreadCount(data.unreadCount || 0);
    } catch (error) {
      console.error("Error loading notifications:", error);
    }
  }, []);

  useEffect(() => {
    const handleUpdate = () => loadNotifications(true);
    window.addEventListener("club-data-updated", handleUpdate);
    window.addEventListener("notifications-updated", handleUpdate);
    return () => {
      window.removeEventListener("club-data-updated", handleUpdate);
      window.removeEventListener("notifications-updated", handleUpdate);
    };
  }, [loadNotifications]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadNotifications();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [loadNotifications]);

  useEffect(() => {
    if (!showNotifications) return;
    const timer = window.setTimeout(() => {
      loadNotifications();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadNotifications, showNotifications]);

  // Close panel on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowNotifications(false);
      }
    }
    if (showNotifications) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showNotifications]);

  const markAsRead = async (id: number) => {
    if (!isAdmin) return;
    try {
      const response = await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
      const data = await response.json().catch(() => ({})) as NotificationMutationResponse;
      if (!response.ok) {
        throw new Error(data.error || "Failed to mark notification as read");
      }
      invalidateJsonCache("/api/notifications");
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, is_read: true } : n))
      );
      setUnreadCount((c) =>
        typeof data.unreadCount === "number" ? data.unreadCount : Math.max(0, c - 1)
      );
      window.dispatchEvent(new CustomEvent("notifications-updated"));
    } catch (error) {
      console.error("Error marking notification as read:", error);
    }
  };

  const markAllAsRead = async () => {
    if (!isAdmin) return;
    try {
      const response = await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      const data = await response.json().catch(() => ({})) as NotificationMutationResponse;
      if (!response.ok) {
        throw new Error(data.error || "Failed to mark all notifications as read");
      }
      invalidateJsonCache("/api/notifications");
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      setUnreadCount(typeof data.unreadCount === "number" ? data.unreadCount : 0);
      window.dispatchEvent(new CustomEvent("notifications-updated"));
    } catch (error) {
      console.error("Error marking all as read:", error);
    }
  };

  const getNotifIcon = (type: string) => {
    switch (type) {
      case "join":
        return { icon: UserPlus, label: "Joined", color: "text-green-500" };
      case "leave":
        return { icon: UserMinus, label: "Left", color: "text-red-500" };
      case "inactive":
        return { icon: Clock3, label: "Inactive", color: "text-amber-500" };
      case "promotion":
        return { icon: ChevronUp, label: "Promoted", color: "text-emerald-500" };
      case "demotion":
        return { icon: ChevronDown, label: "Demoted", color: "text-orange-500" };
      case "name_change":
        return { icon: Pencil, label: "Name changed", color: "text-cyan-500" };
      default:
        return { icon: Bell, label: type, color: "text-blue-500" };
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

  return (
    <header className="h-16 border-b bg-card flex items-center justify-between px-4 md:px-6 gap-4">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          className="h-9 w-9"
        >
          <PanelLeft className="h-5 w-5" />
          <span className="sr-only">Toggle Sidebar</span>
        </Button>
        <h1 className="text-lg md:text-xl font-semibold truncate">{clubName || "Brawl Stars Club Manager"}</h1>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? (
            <span className="h-5 w-5">☀️</span>
          ) : (
            <span className="h-5 w-5">🌙</span>
          )}
        </Button>
        
        {/* Notification Bell */}
        <div className="relative" ref={panelRef}>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowNotifications(!showNotifications)}
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </Button>

          {showNotifications && (
            <Card className="absolute right-0 top-12 w-96 z-50 shadow-lg">
              <CardContent className="p-0">
                <div className="p-3 border-b flex items-center justify-between">
                  <h3 className="font-semibold">Notifications</h3>
                  {unreadCount > 0 && isAdmin && (
                    <button
                      onClick={markAllAsRead}
                      className="text-xs text-primary hover:underline"
                    >
                      Mark all as read
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <p className="p-6 text-sm text-muted-foreground text-center">
                    No notifications yet
                  </p>
                ) : (
                  <div className="max-h-80 overflow-y-auto">
                    {notifications.map((notif) => {
                      const style = getNotifIcon(notif.type);
                      const Icon = style.icon;
                      return (
                        <div
                          key={notif.id}
                          onClick={() => isAdmin && !notif.is_read && markAsRead(notif.id)}
                          className={cn(
                            "p-3 border-b last:border-b-0 transition-colors",
                            isAdmin && "cursor-pointer",
                            notif.is_read
                              ? "hover:bg-muted/30 opacity-60"
                              : "bg-primary/5 hover:bg-primary/10"
                          )}
                        >
                          <div className="flex items-start gap-2">
                            <span className={cn("mt-1 shrink-0", style.color)}>
                              <Icon className="h-3.5 w-3.5" />
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={cn("text-xs font-semibold", style.color)}>
                                  {notif.title}
                                </span>
                                {!notif.is_read && (
                                  <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground mt-0.5 break-words">
                                {renderMessageWithMemberLinks(notif.message)}
                              </p>
                              <p className="text-xs text-muted-foreground/70 mt-1">
                                {formatDateTime(notif.created_at)}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <Link
                  href="/notifications"
                  onClick={() => setShowNotifications(false)}
                  className="block p-3 border-t text-center text-sm text-primary hover:bg-muted/50 transition-colors"
                >
                  View all notifications
                </Link>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </header>
  );
}

export function LayoutWrapper({ children }: { children: ReactNode }) {
  const { sidebarOpen, toggleSidebar, setSidebarOpen } = useAppStore();
  
  const close = useCallback(() => setSidebarOpen(false), [setSidebarOpen]);

  return (
    <SidebarContext.Provider value={{ isOpen: sidebarOpen, toggle: toggleSidebar, close }}>
      <div className="min-h-screen bg-background">
        <SimpleSidebar />
        
        {/* Main content */}
        <div 
          className={cn(
            "min-h-screen transition-all duration-200",
            sidebarOpen ? "md:ml-64" : "md:ml-0"
          )}
        >
          <SimpleHeader />
          <main className="p-4 md:p-6">
            {children}
          </main>
        </div>
      </div>
    </SidebarContext.Provider>
  );
}
