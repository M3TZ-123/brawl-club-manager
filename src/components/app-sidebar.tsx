"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Members", href: "/members", icon: Users },
  { name: "Activity", href: "/activity", icon: Activity },
  { name: "Reports", href: "/reports", icon: FileText },
  { name: "History", href: "/history", icon: History },
  { name: "Settings", href: "/settings", icon: Settings },
];

export function AppSidebar() {
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
    <Sidebar collapsible="offcanvas" className="border-r border-sidebar-border">
      {/* Logo */}
      <SidebarHeader className="border-b border-sidebar-border px-4 py-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="hover:bg-transparent">
              <Link href="/" className="flex items-center gap-3">
                <div className="flex aspect-square size-10 items-center justify-center rounded-xl bg-gradient-to-br from-yellow-400 to-orange-500 shadow-lg">
                  <Trophy className="size-6 text-white" />
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-bold text-base">Club Manager</span>
                  {clubName && (
                    <span className="text-xs text-sidebar-foreground/70 truncate max-w-[120px]">{clubName}</span>
                  )}
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      {/* Navigation */}
      <SidebarContent className="px-3 py-4">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-1">
              {navigation.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <SidebarMenuItem key={item.name}>
                    <SidebarMenuButton 
                      asChild 
                      isActive={isActive}
                      className={cn(
                        "w-full justify-start gap-3 px-3 py-2.5 rounded-lg font-medium transition-all duration-200",
                        isActive 
                          ? "bg-primary text-primary-foreground shadow-md" 
                          : "hover:bg-sidebar-accent text-sidebar-foreground/80 hover:text-sidebar-foreground"
                      )}
                    >
                      <Link href={item.href}>
                        <item.icon className="size-5" />
                        <span>{item.name}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Sync Status */}
      <SidebarFooter className="border-t border-sidebar-border px-3 py-4">
        <Button
          onClick={() => handleSync(false)}
          disabled={isSyncing}
          variant="outline"
          className="w-full justify-center gap-2 py-2.5 border-sidebar-border hover:bg-sidebar-accent"
        >
          <RefreshCw className={cn("size-4", isSyncing && "animate-spin")} />
          <span>{isSyncing ? "Syncing..." : "Sync Now"}</span>
        </Button>
        {lastSyncTime && (
          <p className="text-xs text-sidebar-foreground/60 text-center mt-2">
            Last: {new Date(lastSyncTime).toLocaleTimeString()}
          </p>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
