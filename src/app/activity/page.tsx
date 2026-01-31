"use client";

import { useEffect, useState } from "react";
import { LayoutWrapper } from "@/components/layout-wrapper";
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
import { ClubEvent } from "@/types/database";
import { formatDateTime } from "@/lib/utils";

interface ActivityCounts {
  active: number;
  minimal: number;
  inactive: number;
}

export default function ActivityPage() {
  const [events, setEvents] = useState<ClubEvent[]>([]);
  const [activityCounts, setActivityCounts] = useState<ActivityCounts>({ active: 0, minimal: 0, inactive: 0 });
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

      if (membersRes.ok) {
        const data = await membersRes.json();
        const members = data.members || [];
        
        // Calculate activity counts based on 24h trophy change
        const counts: ActivityCounts = { active: 0, minimal: 0, inactive: 0 };
        members.forEach((member: { trophy_change_24h?: number | null }) => {
          const change = member.trophy_change_24h;
          if (change === null || change === undefined || change === 0) {
            counts.inactive++;
          } else if (Math.abs(change) >= 20) {
            counts.active++;
          } else {
            counts.minimal++;
          }
        });
        setActivityCounts(counts);
      }
    } catch (error) {
      console.error("Error loading data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <LayoutWrapper>
      <Tabs defaultValue="events" className="space-y-4">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="events" className="flex-1 sm:flex-none">Club Events</TabsTrigger>
          <TabsTrigger value="activity" className="flex-1 sm:flex-none">Activity Log</TabsTrigger>
        </TabsList>

            <TabsContent value="events">
              <Card>
                <CardHeader>
                  <CardTitle>Club Events</CardTitle>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                  ) : events.length === 0 ? (
                    <p className="text-center text-muted-foreground py-8">
                      No club events recorded yet
                    </p>
                  ) : (
                    <div className="overflow-x-auto -mx-4 sm:mx-0">
                      <Table className="min-w-[400px] sm:min-w-full">
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
                                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                    event.event_type === "join"
                                      ? "bg-green-500/20 text-green-500"
                                      : "bg-red-500/20 text-red-500"
                                  }`}
                                >
                                  {event.event_type === "join" ? "Joined" : "Left"}
                                </span>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {formatDateTime(event.event_time)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="activity">
              <Card>
                <CardHeader>
                  <CardTitle>Daily Activity Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {isLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
                        <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/20">
                          <div className="text-2xl mb-1">🟢</div>
                          <p className="text-3xl font-bold text-green-500">{activityCounts.active}</p>
                          <p className="font-medium text-green-500">Active</p>
                          <p className="text-sm text-muted-foreground">
                            ±20+ trophies
                          </p>
                        </div>
                        <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                          <div className="text-2xl mb-1">🟡</div>
                          <p className="text-3xl font-bold text-yellow-500">{activityCounts.minimal}</p>
                          <p className="font-medium text-yellow-500">Minimal</p>
                          <p className="text-sm text-muted-foreground">
                            Small changes
                          </p>
                        </div>
                        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
                          <div className="text-2xl mb-1">🔴</div>
                          <p className="text-3xl font-bold text-red-500">{activityCounts.inactive}</p>
                          <p className="font-medium text-red-500">Inactive</p>
                          <p className="text-sm text-muted-foreground">
                            No changes in 24h
                          </p>
                        </div>
                      </div>
                    )}

                    <p className="text-sm text-muted-foreground text-center mt-4">
                      Activity is tracked by monitoring trophy changes every sync cycle.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
    </LayoutWrapper>
  );
}
