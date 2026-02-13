"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils";
import { Trophy, Users, TrendingUp, Activity } from "lucide-react";

interface StatsCardsProps {
  totalMembers: number;
  totalTrophies: number;
  activeMembers: number;
  avgTrophies: number;
}

export function StatsCards({
  totalMembers,
  totalTrophies,
  activeMembers,
  avgTrophies,
}: StatsCardsProps) {
  const cards = [
    {
      title: "Total Members",
      value: totalMembers,
      icon: Users,
      description: "Club members",
      color: "text-blue-500",
    },
    {
      title: "Total Trophies",
      value: formatNumber(totalTrophies),
      icon: Trophy,
      description: "Combined trophies",
      color: "text-yellow-500",
    },
    {
      title: "Active Players",
      value: activeMembers,
      icon: Activity,
      description: `${totalMembers > 0 ? Math.round((activeMembers / totalMembers) * 100) : 0}% active`,
      color: "text-green-500",
    },
    {
      title: "Avg Trophies",
      value: formatNumber(avgTrophies),
      icon: TrendingUp,
      description: "Per member",
      color: "text-purple-500",
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            <card.icon className={`h-5 w-5 ${card.color}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{card.value}</div>
            <p className="text-xs text-muted-foreground">{card.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
