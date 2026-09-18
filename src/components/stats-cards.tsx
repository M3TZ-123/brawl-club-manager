"use client";
import { T, useI18n } from "@/components/locale-provider";


import { memo, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { Trophy, Users, TrendingUp, Activity } from "lucide-react";

interface StatsCardsProps {
  totalMembers: number;
  totalTrophies: number;
  activeMembers: number;
  avgTrophies: number;
}

export const StatsCards = memo(function StatsCards({
  totalMembers,
  totalTrophies,
  activeMembers,
  avgTrophies,
}: StatsCardsProps) {
  const { number: formatNumber, t } = useI18n();
  const cards = useMemo(() => [
    {
      title: "Total Members",
      value: totalMembers,
      icon: Users,
      color: "text-blue-500",
    },
    {
      title: "Total Trophies",
      value: formatNumber(totalTrophies),
      icon: Trophy,
      color: "text-yellow-500",
    },
    {
      title: "Active in last 24h",
      value: activeMembers,
      icon: Activity,
      description: t("{percent}% active", {percent: totalMembers > 0 ? Math.round((activeMembers / totalMembers) * 100) : 0}),
      color: "text-green-500",
    },
    {
      title: "Avg Trophies",
      value: formatNumber(avgTrophies),
      icon: TrendingUp,
      color: "text-purple-500",
    },
  ], [activeMembers, avgTrophies, totalMembers, totalTrophies, formatNumber, t]);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 p-4 pb-2">
            <CardTitle className="text-sm font-medium">{<T text={card.title} />}</CardTitle>
            <card.icon className={`h-4 w-4 shrink-0 ${card.color}`} />
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-xl font-bold sm:text-2xl"><T text={card.value} /></div>
            {card.description && <p className="text-xs text-muted-foreground">{<T text={card.description} />}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
});
