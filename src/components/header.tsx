"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { Bell, Moon, Sun, PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils";

interface Notification {
  id: number;
  type: "join" | "leave";
  playerName: string;
  time: string;
}

export function Header() {
  const { theme, setTheme, clubName } = useAppStore();
  const { toggleSidebar, state } = useSidebar();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    loadNotifications();
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
    <header className="h-16 border-b bg-card flex items-center justify-between px-6 gap-4">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          className="h-9 w-9"
          title={state === "expanded" ? "Collapse sidebar" : "Expand sidebar"}
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
            <Sun className="h-5 w-5" />
          ) : (
            <Moon className="h-5 w-5" />
          )}
        </Button>
        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowNotifications(!showNotifications)}
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
                  <h3 className="font-semibold">Notifications</h3>
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
