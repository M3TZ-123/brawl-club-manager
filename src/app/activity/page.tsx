"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";
import { ActivityTimeline } from "@/components/activity-timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ActivityLog, ClubEvent } from "@/types/database";
import { formatDateTime, formatNumber, getActivityEmoji } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";

export default function ActivityPage() {
  const [events, setEvents] = useState<ClubEvent[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [eventsRes, membersRes] = await Promise.all([
        fetch("/api/events"),
        fetch("/api/members"),
      ]);

      if (eventsRes.ok) {
        const data = await eventsRes.json();
        setEvents(data.events || []);
      }

      // For activity logs, we'd need a dedicated endpoint
      // For now, we'll show events
    } catch (error) {
      console.error("Error loading data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          <Tabs defaultValue="events" className="space-y-4">
            <TabsList>
              <TabsTrigger value="events">Club Events</TabsTrigger>
              <TabsTrigger value="activity">Activity Log</TabsTrigger>
            </TabsList>

            <TabsContent value="events">
              <div className="grid gap-6 lg:grid-cols-2">
                <ActivityTimeline events={events.slice(0, 15)} />
                
                <Card>
                  <CardHeader>
                    <CardTitle>All Events</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {isLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                      </div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Player</TableHead>
                            <TableHead>Event</TableHead>
                            <TableHead>Time</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {events.map((event) => (
                            <TableRow key={event.id}>
                              <TableCell>
                                <div>
                                  <p className="font-medium">{event.player_name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {event.player_tag}
                                  </p>
                                </div>
                              </TableCell>
                              <TableCell>
                                <span
                                  className={
                                    event.event_type === "join"
                                      ? "text-green-500"
                                      : event.event_type === "leave"
                                      ? "text-red-500"
                                      : "text-blue-500"
                                  }
                                >
                                  {event.event_type.charAt(0).toUpperCase() +
                                    event.event_type.slice(1)}
                                </span>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {formatDateTime(event.event_time)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="activity">
              <Card>
                <CardHeader>
                  <CardTitle>Daily Activity Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div className="p-4 rounded-lg bg-green-500/10">
                        <div className="text-2xl mb-1">🟢</div>
                        <p className="font-medium text-green-500">Active</p>
                        <p className="text-sm text-muted-foreground">
                          Significant trophy changes
                        </p>
                      </div>
                      <div className="p-4 rounded-lg bg-yellow-500/10">
                        <div className="text-2xl mb-1">🟡</div>
                        <p className="font-medium text-yellow-500">Minimal</p>
                        <p className="text-sm text-muted-foreground">
                          Opened game (streak keeper)
                        </p>
                      </div>
                      <div className="p-4 rounded-lg bg-red-500/10">
                        <div className="text-2xl mb-1">🔴</div>
                        <p className="font-medium text-red-500">Inactive</p>
                        <p className="text-sm text-muted-foreground">
                          No changes in 24+ hours
                        </p>
                      </div>
                    </div>

                    <p className="text-sm text-muted-foreground text-center mt-4">
                      Activity is tracked by monitoring trophy changes every sync cycle.
                      <br />
                      Active = ±20+ trophies | Minimal = small changes | Inactive = no changes
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  );
}
