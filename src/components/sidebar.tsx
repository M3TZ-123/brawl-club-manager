"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import {
  LayoutDashboard,
  Users,
  Activity,
  FileText,
  History,
  Settings,
  RefreshCw,
  Trophy,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Members", href: "/members", icon: Users },
  { name: "Activity", href: "/activity", icon: Activity },
  { name: "Reports", href: "/reports", icon: FileText },
  { name: "History", href: "/history", icon: History },
  { name: "Settings", href: "/settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const { clubName, clubTag, apiKey, lastSyncTime, isSyncing, refreshInterval } = useAppStore();
  const autoSyncRef = useRef<NodeJS.Timeout | null>(null);

  const handleSync = async (silent = false) => {
    if (!clubTag || !apiKey) return;
    
    // Trigger sync via API
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
        if (!silent) alert(`Sync failed: ${data.error}`);
      } else {
        useAppStore.getState().setLastSyncTime(new Date().toISOString());
        // Reload the page to fetch new data
        if (!silent) window.location.reload();
      }
    } catch (error) {
      console.error("Sync failed:", error);
      if (!silent) alert("Sync failed. Check the console for details.");
    } finally {
      useAppStore.getState().setIsSyncing(false);
    }
  };

  // Auto-sync effect
  useEffect(() => {
    if (!clubTag || !apiKey) return;

    const intervalMs = refreshInterval * 60 * 1000; // Convert minutes to ms
    
    // Check if we should sync on mount (if last sync was too long ago)
    if (lastSyncTime) {
      const timeSinceLastSync = Date.now() - new Date(lastSyncTime).getTime();
      if (timeSinceLastSync >= intervalMs) {
        console.log("Auto-sync: Syncing because interval has passed");
        handleSync(true);
      }
    }

    // Set up interval for auto-sync
    autoSyncRef.current = setInterval(() => {
      console.log("Auto-sync: Running scheduled sync");
      handleSync(true);
    }, intervalMs);

    return () => {
      if (autoSyncRef.current) {
        clearInterval(autoSyncRef.current);
      }
    };
  }, [clubTag, apiKey, refreshInterval, lastSyncTime]);

  // Fetch last sync time from database on mount
  useEffect(() => {
    const fetchSyncStatus = async () => {
      try {
        const response = await fetch("/api/sync/status");
        const data = await response.json();
        if (data.lastSyncTime) {
          useAppStore.getState().setLastSyncTime(data.lastSyncTime);
        }
      } catch (error) {
        console.error("Failed to fetch sync status:", error);
      }
    };
    fetchSyncStatus();
    
    // Poll every 5 minutes to check if GitHub Actions synced
    const pollInterval = setInterval(fetchSyncStatus, 5 * 60 * 1000);
    return () => clearInterval(pollInterval);
  }, []);

  return (
    <div className="flex h-full w-64 flex-col bg-card border-r">
      {/* Logo */}
      <div className="flex h-16 items-center gap-2 px-6 border-b">
        <Trophy className="h-8 w-8 text-yellow-500" />
        <div className="flex flex-col">
          <span className="font-bold text-lg">Club Manager</span>
          {clubName && (
            <span className="text-xs text-muted-foreground truncate max-w-[150px]">
              {clubName}
            </span>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navigation.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* Sync Status */}
      <div className="border-t p-4 space-y-3">
        <Button
          onClick={() => handleSync(false)}
          disabled={isSyncing}
          className="w-full"
          variant="outline"
        >
          <RefreshCw className={cn("h-4 w-4 mr-2", isSyncing && "animate-spin")} />
          {isSyncing ? "Syncing..." : "Sync Now"}
        </Button>
        {lastSyncTime && (
          <p className="text-xs text-muted-foreground text-center">
            Last sync: {new Date(lastSyncTime).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}
