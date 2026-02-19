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
  const chartData = data.map((item) => ({
    ...item,
    shortDate: new Date(`${item.date}T00:00:00`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
  }));

  const trophyValues = data.map((item) => item.trophies);
  const dataMin = trophyValues.length > 0 ? Math.min(...trophyValues) : 0;
  const dataMax = trophyValues.length > 0 ? Math.max(...trophyValues) : 0;
  const range = Math.max(dataMax - dataMin, 1);
  const padding = Math.max(Math.ceil(range * 0.1), 500);
  const minDomain = Math.max(0, dataMin - padding);
  const maxDomain = dataMax + padding;

  const formatExact = (value: number) => {
    if (!Number.isFinite(value)) return "0";
    return formatNumber(Math.round(value));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trophy Progression</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={chartData} margin={{ top: 10, right: 16, left: 8, bottom: 18 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              dataKey="shortDate"
              className="text-xs"
              height={42}
              tickMargin={12}
              axisLine={false}
              tickLine={false}
              tick={{ dy: 4 }}
              interval="preserveStartEnd"
            />
            <YAxis
              className="text-xs"
              domain={[minDomain, maxDomain]}
              tickCount={5}
              width={110}
              tickMargin={10}
              tickFormatter={(value) => formatExact(Number(value))}
              axisLine={false}
              tickLine={false}
              tick={{ dx: -6 }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
              }}
              formatter={(value) => [formatNumber(Number(value)), "Trophies"]}
              labelFormatter={(value) => `Date: ${value}`}
            />
            <Line
              type="monotone"
              dataKey="trophies"
              stroke="hsl(var(--primary))"
              strokeWidth={2.5}
              dot={{ r: 3.5, fill: "hsl(var(--primary))" }}
              activeDot={{ r: 5 }}
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

  // Build grouped day map (latest trophy value per day)
  const groupedByDay = new Map<string, number>();
  const orderedByTime = [...data].sort(
    (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
  );
  for (const log of orderedByTime) {
    const dayKey = log.recorded_at.slice(0, 10);
    groupedByDay.set(dayKey, log.trophies);
  }

  // Ensure at least a 7-day timeline on X axis
  const minTimelineDays = 7;
  const today = new Date();
  const timelineKeys: string[] = [];
  for (let offset = minTimelineDays - 1; offset >= 0; offset--) {
    const day = new Date(today);
    day.setDate(day.getDate() - offset);
    timelineKeys.push(day.toISOString().slice(0, 10));
  }

  // Merge timeline with real data keys if we have longer history
  const allDayKeys = Array.from(new Set([...timelineKeys, ...Array.from(groupedByDay.keys())])).sort();

  const chartData = allDayKeys.map((dayKey) => {
    const dateObj = new Date(`${dayKey}T00:00:00`);
    return {
      dayKey,
      date: dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      trophies: groupedByDay.has(dayKey) ? groupedByDay.get(dayKey)! : null,
    };
  });

  const knownTrophyValues = chartData
    .map((point) => point.trophies)
    .filter((value): value is number => typeof value === "number");
  const yMin = knownTrophyValues.length > 0 ? Math.min(...knownTrophyValues) : currentTrophies;
  const yMax = knownTrophyValues.length > 0 ? Math.max(...knownTrophyValues) : currentTrophies;
  const yPadding = Math.max(Math.ceil((yMax - yMin || 1) * 0.08), 150);
  const onlyOneTrackedDay = groupedByDay.size <= 1;

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
          <AreaChart data={chartData} margin={{ left: 10, right: 10, bottom: 15 }}>
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
              tick={{ fill: 'hsl(var(--muted-foreground))', dy: 10 }}
              interval="preserveStartEnd"
            />
            <YAxis 
              className="text-xs" 
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(var(--muted-foreground))' }}
              width={55}
              tickFormatter={(value) => {
                if (value >= 1000) {
                  const k = value / 1000;
                  return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
                }
                return formatNumber(value);
              }}
              domain={[Math.max(0, yMin - yPadding), yMax + yPadding]}
              tickCount={5}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
              }}
              formatter={(value) => {
                if (value == null) return ["No data", "Trophies"];
                return [formatNumber(value as number), "Trophies"];
              }}
            />
            <Area
              type="monotone"
              dataKey="trophies"
              stroke="#f59e0b"
              strokeWidth={2}
              fill="url(#trophyGradient)"
              connectNulls={false}
            />
          </AreaChart>
        </ResponsiveContainer>
        <div className="text-center text-xs text-muted-foreground mt-2">Day</div>
        {onlyOneTrackedDay && (
          <p className="text-center text-xs text-muted-foreground mt-1">Tracking starts today</p>
        )}
      </CardContent>
    </Card>
  );
}

interface ActivityChartProps {
  data: { name: string; value: number; color: string }[];
}

export function ActivityPieChart({ data }: ActivityChartProps) {
  const total = data.reduce((sum, entry) => sum + (entry.value || 0), 0);

  const getColorLabel = (color: string) => {
    const normalized = color.toLowerCase();
    if (normalized === "#22c55e") return "Green";
    if (normalized === "#ef4444") return "Red";
    return "Color";
  };

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
        <div className="mt-3 flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
          {data.map((entry) => (
            <div key={entry.name} className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: entry.color }}
                aria-hidden
              />
              <span>
                {getColorLabel(entry.color)} = {entry.name} ({entry.value}
                {total > 0 ? `, ${Math.round((entry.value / total) * 100)}%` : ""})
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface MemberBarChartProps {
  data: { name: string; trophies: number }[];
}

export function MemberBarChart({ data }: MemberBarChartProps) {
  // Calculate a smart minimum so the chart doesn't waste space showing 0 to min
  const minTrophies = data.length > 0 ? Math.min(...data.map((d) => d.trophies)) : 0;
  const domainMin = Math.max(0, Math.floor(minTrophies * 0.9 / 1000) * 1000); // Round down to nearest 1000, 90% of min

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Members by Trophies</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={380}>
          <BarChart data={data} layout="vertical" margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              type="number"
              className="text-xs"
              domain={[domainMin, "auto"]}
              tickFormatter={(v: number) => formatNumber(v)}
            />
            <YAxis dataKey="name" type="category" className="text-xs" width={150} tick={{ fontSize: 13 }} />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
              }}
              formatter={(value: number | undefined) => [formatNumber(value ?? 0), "Trophies"]}
            />
            <Bar dataKey="trophies" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// Activity Calendar Component
interface ActivityCalendarProps {
  battlesByDay: Record<string, number>;
}

export function ActivityCalendar({ battlesByDay }: ActivityCalendarProps) {
  // Generate calendar for current month
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  
  // Get first day of month and number of days
  const firstDay = new Date(currentYear, currentMonth, 1);
  const lastDay = new Date(currentYear, currentMonth + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startingDay = firstDay.getDay(); // 0 = Sunday
  
  // Calculate days until season reset (assumed every 2 weeks on Monday)
  const dayOfWeek = now.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const hoursUntilReset = daysUntilMonday * 24 - now.getHours();
  const daysToReset = Math.floor(hoursUntilReset / 24);
  const hoursToReset = hoursUntilReset % 24;

  // Get color based on battles count
  const getColor = (battles: number | undefined) => {
    if (!battles || battles === 0) return "bg-muted/30 text-muted-foreground";
    if (battles < 5) return "bg-orange-500/80 text-white";
    if (battles < 10) return "bg-orange-400 text-white";
    if (battles < 20) return "bg-green-600 text-white";
    return "bg-green-500 text-white";
  };

  const weekDays = ["S", "M", "T", "W", "T", "F", "S"];
  const monthName = now.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // Build calendar grid
  const calendarDays: (number | null)[] = [];
  for (let i = 0; i < startingDay; i++) {
    calendarDays.push(null);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    calendarDays.push(day);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">📊</span>
          <CardTitle className="text-sm font-medium">ACTIVITY</CardTitle>
        </div>
        <div className="flex items-center gap-2 text-xs bg-orange-500/20 text-orange-400 px-3 py-1 rounded-full">
          {daysToReset}d {hoursToReset}h to reset
          <span>→</span>
        </div>
      </CardHeader>
      <CardContent>
        {/* Week day headers */}
        <div className="grid grid-cols-7 gap-1 mb-1">
          {weekDays.map((day, i) => (
            <div key={i} className="text-center text-xs text-muted-foreground py-1">
              {day}
            </div>
          ))}
        </div>
        
        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-1">
          {calendarDays.map((day, i) => {
            if (day === null) {
              return <div key={i} className="aspect-square" />;
            }
            
            const dateKey = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const battles = battlesByDay[dateKey];
            const isToday = day === now.getDate();
            
            return (
              <div
                key={i}
                className={`aspect-square flex items-center justify-center text-xs font-medium rounded ${getColor(battles)} ${isToday ? 'ring-2 ring-yellow-400' : ''}`}
                title={battles ? `${dateKey}: ${battles} battles` : dateKey}
              >
                {day}
              </div>
            );
          })}
        </div>
        
        {/* Legend */}
        <div className="flex items-center gap-3 mt-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-muted/30" />
            <span>Not tracked</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded border-2 border-orange-400" />
            <span>Season</span>
          </div>
          <span>Less</span>
          <div className="flex gap-0.5">
            <div className="w-3 h-3 rounded bg-orange-500/80" />
            <div className="w-3 h-3 rounded bg-orange-400" />
            <div className="w-3 h-3 rounded bg-green-600" />
            <div className="w-3 h-3 rounded bg-green-500" />
          </div>
          <span>More</span>
        </div>
      </CardContent>
    </Card>
  );
}

// Power Level Distribution Chart
interface PowerLevelChartProps {
  distribution: number[];
  avgPower: number;
  maxedCount: number;
}

export function PowerLevelChart({ distribution, avgPower, maxedCount }: PowerLevelChartProps) {
  const data = distribution
    .map((count, index) => ({ level: index + 1, count }))
    .filter((d) => d.count > 0);

  const getBarColor = (level: number) => {
    if (level <= 6) return "#6b7280"; // Gray
    if (level <= 9) return "#22c55e"; // Green
    if (level === 10) return "#3b82f6"; // Blue
    return "#a855f7"; // Purple for level 11
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <span className="text-yellow-500">⚡</span>
          <CardTitle className="text-sm font-medium">BY POWER LEVEL</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} barCategoryGap="20%" margin={{ top: 20 }}>
            <XAxis 
              dataKey="level" 
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
            />
            <YAxis hide />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
              }}
              formatter={(value) => [`${value} brawlers`, "Count"]}
            />
            <Bar 
              dataKey="count" 
              radius={[4, 4, 0, 0]}
              label={{ position: 'top', fill: '#22c55e', fontSize: 12 }}
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={getBarColor(entry.level)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div className="flex justify-between mt-2 text-sm">
          <span className="text-muted-foreground">
            Avg: <span className="text-green-400 font-bold">{avgPower.toFixed(1)}</span>
          </span>
          <span className="text-muted-foreground">
            Maxed: <span className="text-purple-400 font-bold">{maxedCount}</span>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// Battle Tracking Stats Component (Basic - last 25 battles)
interface TrackingStatsProps {
  battles: number;
  wins: number;
  losses: number;
  winRate: number;
  starPlayer: number;
  trophyChange: number;
  activeDays: number;
}

export function TrackingStats({ 
  battles, 
  wins, 
  losses, 
  winRate, 
  starPlayer, 
  trophyChange, 
  activeDays 
}: TrackingStatsProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-green-400">☑</span>
            <CardTitle className="text-sm font-medium">TRACKING</CardTitle>
            <span className="text-xs bg-muted px-2 py-0.5 rounded">Last 25 battles</span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Battles</span>
            <span className="font-bold">{battles}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Active Days</span>
            <span className="font-bold">{activeDays}/7</span>
          </div>
          
          <div className="flex justify-between">
            <span className="text-muted-foreground">Wins</span>
            <span className="font-bold text-green-400">{wins}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Losses</span>
            <span className="font-bold text-red-400">{losses}</span>
          </div>
          
          <div className="flex justify-between">
            <span className="text-muted-foreground">Win Rate</span>
            <span className={`font-bold ${winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>{winRate}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Star Player</span>
            <span className="font-bold text-yellow-400">{starPlayer}</span>
          </div>
          
          <div className="flex justify-between col-span-2 pt-2 border-t border-border">
            <div className="flex items-center gap-1">
              <span className="text-yellow-500">🏆</span>
              <span className="text-muted-foreground">Trophies</span>
            </div>
            <span className={`font-bold ${trophyChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {trophyChange >= 0 ? '+' : ''}{formatNumber(trophyChange)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Enhanced Tracking Stats Component (brawltime.ninja style - last 28 days)
interface EnhancedTrackingStatsProps {
  totalBattles: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  starPlayerCount: number;
  trophiesGained: number;
  trophiesLost: number;
  activeDays: number;
  totalDays: number;
  currentStreak: number;
  bestStreak: number;
  peakDayBattles: number;
  powerUps: number;
  unlocks: number;
  trackedDays: number;
}

export function EnhancedTrackingStats({
  totalBattles,
  totalWins,
  totalLosses,
  winRate,
  starPlayerCount,
  trophiesGained,
  trophiesLost,
  activeDays,
  totalDays,
  currentStreak,
  bestStreak,
  peakDayBattles,
  powerUps,
  unlocks,
  trackedDays,
}: EnhancedTrackingStatsProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-green-400">☑</span>
            <CardTitle className="text-sm font-medium">TRACKING</CardTitle>
            <span className="text-xs bg-muted px-2 py-0.5 rounded">Last {totalDays} days</span>
          </div>
          <span className="text-muted-foreground text-xs">→</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          {/* Row 1 */}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Battles</span>
            <span className="font-bold">{formatNumber(totalBattles)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Active Days</span>
            <span className="font-bold">{activeDays}/{totalDays}</span>
          </div>
          
          {/* Row 2 */}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Wins</span>
            <span className="font-bold text-green-400">{formatNumber(totalWins)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Losses</span>
            <span className="font-bold text-red-400">{formatNumber(totalLosses)}</span>
          </div>
          
          {/* Row 3 */}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Win Rate</span>
            <span className={`font-bold ${winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>{winRate}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Star Player</span>
            <span className="font-bold text-yellow-400">{starPlayerCount}</span>
          </div>
          
          {/* Row 4 */}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Peak Day</span>
            <span className="font-bold">{peakDayBattles}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Streak</span>
            <span className="font-bold text-cyan-400">{currentStreak}d</span>
          </div>
          
          {/* Row 5 - Brawler changes */}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Power Ups</span>
            <span className="font-bold text-purple-400">+{powerUps}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Unlocks</span>
            <span className="font-bold text-green-400">+{unlocks}</span>
          </div>
          
          {/* Row 6 - Trophy breakdown */}
          <div className="flex justify-between">
            <div className="flex items-center gap-1">
              <span className="text-yellow-500">🏆</span>
              <span className="text-muted-foreground">Gained</span>
            </div>
            <span className="font-bold text-green-400">+{formatNumber(trophiesGained)}</span>
          </div>
          <div className="flex justify-between">
            <div className="flex items-center gap-1">
              <span className="text-yellow-500">🏆</span>
              <span className="text-muted-foreground">Lost</span>
            </div>
            <span className="font-bold text-red-400">-{formatNumber(trophiesLost)}</span>
          </div>
          
          {/* Row 7 - Tracking info */}
          <div className="flex justify-between pt-2 border-t border-border">
            <span className="text-muted-foreground">Tracked</span>
            <span className="font-bold">{trackedDays}d</span>
          </div>
          <div className="flex justify-between pt-2 border-t border-border">
            <span className="text-muted-foreground">Best Streak</span>
            <span className="font-bold">
              <span className="text-orange-500">🔥</span> {bestStreak}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
