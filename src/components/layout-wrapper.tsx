"use client";

import { ReactNode, createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAppStore } from "@/lib/store";
import { cn, formatDateTime } from "@/lib/utils";
import {
  LayoutDashboard,
  Users,
  Activity,
  FileText,
  History,
  Settings,
  RefreshCw,
  Trophy,
  PanelLeft,
  X,
  Bell,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Members", href: "/members", icon: Users },
  { name: "Activity", href: "/activity", icon: Activity },
  { name: "Reports", href: "/reports", icon: FileText },
  { name: "History", href: "/history", icon: History },
  { name: "Settings", href: "/settings", icon: Settings },
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
  const { clubName, lastSyncTime, isSyncing, clubTag, apiKey, refreshInterval } = useAppStore();
  const { isOpen, close } = useSidebarContext();
  const autoSyncIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const handleSync = async (isAutoSync = false) => {
    if (!clubTag || !apiKey) return;
    
    try {
      useAppStore.getState().setIsSyncing(true);
      const response = await fetch("/api/sync", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clubTag, apiKey }),
      });
      const data = await response.json();
      if (!response.ok) {
        console.error("Sync error:", data.error);
        if (!isAutoSync) {
          alert(`Sync failed: ${data.error}`);
        }
      } else {
        useAppStore.getState().setLastSyncTime(new Date().toISOString());
        // Check if there were any member changes (joins/leaves)
        const hasChanges = data.changes?.joins?.length > 0 || data.changes?.leaves?.length > 0;
        if (hasChanges) {
          // Dispatch custom event so all components can refresh their data
          window.dispatchEvent(new CustomEvent("club-data-updated", { detail: data.changes }));
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
        if (!isAutoSync) {
          window.location.reload();
        } else if (hasChanges) {
          // Refresh page data when member changes detected during auto-sync
          window.location.reload();
        }
      }
    } catch (error) {
      console.error("Sync failed:", error);
      if (!isAutoSync) {
        alert("Sync failed. Check the console for details.");
      }
    } finally {
      useAppStore.getState().setIsSyncing(false);
    }
  };

  // Auto-sync based on refresh interval
  useEffect(() => {
    if (!clubTag || !apiKey || refreshInterval <= 0) return;

    const checkAndSync = () => {
      const lastSync = useAppStore.getState().lastSyncTime;
      const intervalMs = refreshInterval * 60 * 1000; // Convert minutes to ms
      
      if (lastSync) {
        const timeSinceLastSync = Date.now() - new Date(lastSync).getTime();
        if (timeSinceLastSync >= intervalMs) {
          console.log(`Auto-sync triggered (${refreshInterval} min interval)`);
          handleSync(true);
        }
      }
    };

    // Check immediately on mount
    checkAndSync();

    // Set up interval to check every minute
    autoSyncIntervalRef.current = setInterval(checkAndSync, 60 * 1000);

    return () => {
      if (autoSyncIntervalRef.current) {
        clearInterval(autoSyncIntervalRef.current);
      }
    };
  }, [clubTag, apiKey, refreshInterval]);

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
            {navigation.map((item) => {
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
              onClick={() => handleSync(false)}
              disabled={isSyncing}
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

function SimpleHeader() {
  const { clubName, theme, setTheme } = useAppStore();
  const { toggle } = useSidebarContext();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadNotifications();
    const handleUpdate = () => loadNotifications();
    window.addEventListener("club-data-updated", handleUpdate);
    return () => window.removeEventListener("club-data-updated", handleUpdate);
  }, []);

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

  const loadNotifications = async () => {
    try {
      const response = await fetch("/api/notifications?limit=30");
      if (response.ok) {
        const data = await response.json();
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      }
    } catch (error) {
      console.error("Error loading notifications:", error);
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
      console.error("Error marking notification as read:", error);
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

  const getNotifIcon = (type: string) => {
    switch (type) {
      case "join": return { dot: "bg-green-500", label: "Joined", color: "text-green-500" };
      case "leave": return { dot: "bg-red-500", label: "Left", color: "text-red-500" };
      case "inactive": return { dot: "bg-amber-500", label: "Inactive", color: "text-amber-500" };
      default: return { dot: "bg-blue-500", label: type, color: "text-blue-500" };
    }
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
                  {unreadCount > 0 && (
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
                  <div className="max-h-96 overflow-y-auto">
                    {notifications.map((notif) => {
                      const style = getNotifIcon(notif.type);
                      return (
                        <div
                          key={notif.id}
                          onClick={() => !notif.is_read && markAsRead(notif.id)}
                          className={cn(
                            "p-3 border-b last:border-b-0 cursor-pointer transition-colors",
                            notif.is_read
                              ? "hover:bg-muted/30 opacity-60"
                              : "bg-primary/5 hover:bg-primary/10"
                          )}
                        >
                          <div className="flex items-start gap-2">
                            <span className={cn("w-2 h-2 rounded-full mt-1.5 shrink-0", style.dot)} />
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
                                {notif.message}
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
