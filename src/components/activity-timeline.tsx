"use client";

import { ClubEvent } from "@/types/database";
import { formatDateTime } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { UserPlus, UserMinus, ArrowUp, ArrowDown } from "lucide-react";

interface ActivityTimelineProps {
  events: ClubEvent[];
}

export function ActivityTimeline({ events }: ActivityTimelineProps) {
  const getEventIcon = (type: string) => {
    switch (type) {
      case "join":
        return <UserPlus className="h-4 w-4 text-green-500" />;
      case "leave":
        return <UserMinus className="h-4 w-4 text-red-500" />;
      case "promotion":
        return <ArrowUp className="h-4 w-4 text-blue-500" />;
      case "demotion":
        return <ArrowDown className="h-4 w-4 text-orange-500" />;
      default:
        return null;
    }
  };

  const getEventBadge = (type: string) => {
    switch (type) {
      case "join":
        return <Badge variant="success">Joined</Badge>;
      case "leave":
        return <Badge variant="destructive">Left</Badge>;
      case "promotion":
        return <Badge variant="default">Promoted</Badge>;
      case "demotion":
        return <Badge variant="warning">Demoted</Badge>;
      default:
        return <Badge>{type}</Badge>;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {events.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">
              No recent activity
            </p>
          ) : (
            events.map((event) => (
              <div
                key={event.id}
                className="flex items-center gap-4 p-3 rounded-lg bg-muted/50"
              >
                <div className="flex-shrink-0">
                  {getEventIcon(event.event_type)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{event.player_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {event.player_tag}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {getEventBadge(event.event_type)}
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(event.event_time)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
