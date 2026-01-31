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
  type: "join" | "leave";
  playerName: string;
  time: string;
}

function SimpleHeader() {
  const { clubName, theme, setTheme } = useAppStore();
  const { toggle } = useSidebarContext();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    loadNotifications();
    
    // Listen for data updates to refresh notifications
    const handleUpdate = () => loadNotifications();
    window.addEventListener("club-data-updated", handleUpdate);
    return () => window.removeEventListener("club-data-updated", handleUpdate);
  }, []);

  const loadNotifications = async () => {
    try {
      const response = await fetch("/api/events?limit=10");
      if (response.ok) {
        const data = await response.json();
        const events = data.events || [];
        setNotifications(
          events.slice(0, 5).map((e: { id: number; event_type: string; player_name: string; event_time: string }) => ({
            id: e.id,
            type: e.event_type as "join" | "leave",
            playerName: e.player_name,
            time: e.event_time,
          }))
        );
        // Count events from last 24 hours as "unread"
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentCount = events.filter(
          (e: { event_time: string }) => new Date(e.event_time) > dayAgo
        ).length;
        setUnreadCount(Math.min(recentCount, 9));
      }
    } catch (error) {
      console.error("Error loading notifications:", error);
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
        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setShowNotifications(!showNotifications);
              if (!showNotifications) {
                // Clear unread count when opening notifications
                setUnreadCount(0);
              }
            }}
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center">
                {unreadCount}
              </span>
            )}
          </Button>

          {showNotifications && (
            <Card className="absolute right-0 top-12 w-80 z-50 shadow-lg">
              <CardContent className="p-0">
                <div className="p-3 border-b">
                  <h3 className="font-semibold">Club Events</h3>
                </div>
                {notifications.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground text-center">
                    No recent events
                  </p>
                ) : (
                  <div className="max-h-80 overflow-y-auto">
                    {notifications.map((notif) => (
                      <div
                        key={notif.id}
                        className="p-3 border-b last:border-b-0 hover:bg-muted/50"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              notif.type === "join" ? "bg-green-500" : "bg-red-500"
                            }`}
                          />
                          <span className="font-medium text-sm">
                            {notif.playerName}
                          </span>
                          <span
                            className={`text-xs ${
                              notif.type === "join"
                                ? "text-green-500"
                                : "text-red-500"
                            }`}
                          >
                            {notif.type === "join" ? "joined" : "left"}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {formatDateTime(notif.time)}
                        </p>
                      </div>
                    ))}
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
