"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  Area,
  AreaChart,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils";

interface TrophyChartProps {
  data: { date: string; trophies: number }[];
}

export function TrophyChart({ data }: TrophyChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Trophy Progression</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="date" className="text-xs" />
            <YAxis className="text-xs" />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
              }}
            />
            <Line
              type="monotone"
              dataKey="trophies"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={{ fill: "hsl(var(--primary))" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

interface TrophyStatisticsProps {
  data: { date: string; trophies: number; recorded_at: string }[];
  currentTrophies: number;
}

export function TrophyStatistics({ data, currentTrophies }: TrophyStatisticsProps) {
  // Calculate gains
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Find baseline trophies for each period
  const findBaseline = (cutoffDate: Date) => {
    // Get logs before the cutoff date
    const logsBefore = data.filter(log => new Date(log.recorded_at) <= cutoffDate);
    // Get logs after the cutoff date  
    const logsAfter = data.filter(log => new Date(log.recorded_at) > cutoffDate);
    
    if (logsAfter.length > 0) {
      // Use the oldest log after cutoff (first entry in the period)
      return logsAfter[0].trophies;
    } else if (logsBefore.length > 0) {
      // Fallback to most recent log before cutoff
      return logsBefore[logsBefore.length - 1].trophies;
    }
    return null;
  };

  const baseline24h = findBaseline(oneDayAgo);
  const baseline7d = findBaseline(oneWeekAgo);
  const baseline30d = findBaseline(oneMonthAgo);

  const todayGain = baseline24h !== null ? currentTrophies - baseline24h : null;
  const weekGain = baseline7d !== null ? currentTrophies - baseline7d : null;
  const monthGain = baseline30d !== null ? currentTrophies - baseline30d : null;

  // Format chart data - group by day for cleaner display
  const chartData = data.reduce((acc, log) => {
    const date = new Date(log.recorded_at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    // Keep only the last entry for each day
    const existing = acc.findIndex(d => d.date === date);
    if (existing >= 0) {
      acc[existing] = { date, trophies: log.trophies };
    } else {
      acc.push({ date, trophies: log.trophies });
    }
    return acc;
  }, [] as { date: string; trophies: number }[]);

  const formatGain = (gain: number | null) => {
    if (gain === null) return "-";
    return gain >= 0 ? `+${formatNumber(gain)}` : formatNumber(gain);
  };

  const getGainColor = (gain: number | null) => {
    if (gain === null) return "text-muted-foreground";
    return gain >= 0 ? "text-green-500" : "text-red-500";
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Trophy Statistics</CardTitle>
        <div className="flex gap-6 text-sm">
          <div className="text-right">
            <span className="text-muted-foreground mr-2">today</span>
            <span className={`font-bold ${getGainColor(todayGain)}`}>{formatGain(todayGain)}</span>
          </div>
          <div className="text-right">
            <span className="text-muted-foreground mr-2">week</span>
            <span className={`font-bold ${getGainColor(weekGain)}`}>{formatGain(weekGain)}</span>
          </div>
          <div className="text-right">
            <span className="text-muted-foreground mr-2">month</span>
            <span className={`font-bold ${getGainColor(monthGain)}`}>{formatGain(monthGain)}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="trophyGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
            <XAxis 
              dataKey="date" 
              className="text-xs" 
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(var(--muted-foreground))' }}
            />
            <YAxis 
              className="text-xs" 
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(var(--muted-foreground))' }}
              tickFormatter={(value) => `${Math.round(value / 1000)}k`}
              domain={['dataMin - 500', 'dataMax + 500']}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
              }}
              formatter={(value) => [formatNumber(value as number), "Trophies"]}
            />
            <Area
              type="monotone"
              dataKey="trophies"
              stroke="#f59e0b"
              strokeWidth={2}
              fill="url(#trophyGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
        <div className="text-center text-xs text-muted-foreground mt-2">Day</div>
      </CardContent>
    </Card>
  );
}

interface ActivityChartProps {
  data: { name: string; value: number; color: string }[];
}

export function ActivityPieChart({ data }: ActivityChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={({ name, percent }) =>
                `${name || ""} ${((percent as number) * 100).toFixed(0)}%`
              }
              outerRadius={100}
              fill="#8884d8"
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

interface MemberBarChartProps {
  data: { name: string; trophies: number }[];
}

export function MemberBarChart({ data }: MemberBarChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Members by Trophies</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis type="number" className="text-xs" />
            <YAxis dataKey="name" type="category" className="text-xs" width={100} />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
              }}
            />
            <Bar dataKey="trophies" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
