"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Swords,
  Trophy,
  Star,
  ChevronDown,
  Filter,
  Clock,
  User,
} from "lucide-react";

interface Battle {
  id: number;
  player_tag: string;
  player_name: string;
  battle_time: string;
  mode: string | null;
  map: string | null;
  result: string | null;
  trophy_change: number;
  is_star_player: boolean;
  brawler_name: string | null;
  brawler_power: number | null;
  brawler_trophies: number | null;
}

const RESULT_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  victory: { bg: "bg-green-500/15", text: "text-green-500", label: "Victory" },
  defeat: { bg: "bg-red-500/15", text: "text-red-500", label: "Defeat" },
  draw: { bg: "bg-yellow-500/15", text: "text-yellow-500", label: "Draw" },
};

const MODE_ICONS: Record<string, string> = {
  gemGrab: "💎",
  brawlBall: "⚽",
  heist: "🔓",
  bounty: "⭐",
  siege: "🔧",
  hotZone: "🔥",
  knockout: "💀",
  showdown: "🏜️",
  duoShowdown: "👥",
  soloShowdown: "🏜️",
  wipeout: "💥",
  payload: "📦",
  trophyThieves: "🏆",
  duels: "⚔️",
  paintBrawl: "🎨",
  brawlBall5V5: "⚽",
};

function formatMode(mode: string | null): string {
  if (!mode) return "Unknown";
  // Convert camelCase to Title Case
  return mode
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .replace(/5 V 5/, "5v5")
    .trim();
}

function getModeIcon(mode: string | null): string {
  if (!mode) return "⚔️";
  return MODE_ICONS[mode] || "⚔️";
}

function timeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function BattleCard({ battle }: { battle: Battle }) {
  const resultStyle = RESULT_STYLES[battle.result || ""] || {
    bg: "bg-muted",
    text: "text-muted-foreground",
    label: battle.result || "Unknown",
  };

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-accent/30 transition-colors">
      {/* Mode icon */}
      <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-accent flex items-center justify-center text-lg">
        {getModeIcon(battle.mode)}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href={`/members/${encodeURIComponent(battle.player_tag)}`}
            className="font-semibold text-sm hover:underline truncate"
          >
            {battle.player_name}
          </Link>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${resultStyle.bg} ${resultStyle.text}`}>
            {resultStyle.label}
          </span>
          {battle.is_star_player && (
            <span className="inline-flex items-center gap-0.5 text-yellow-500 text-[11px] font-medium">
              <Star className="h-3 w-3 fill-yellow-500" /> Star Player
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
          {battle.brawler_name && (
            <span className="font-medium text-foreground/80">
              {battle.brawler_name}
              {battle.brawler_power ? ` (Lv${battle.brawler_power})` : ""}
            </span>
          )}
          <span>·</span>
          <span>{formatMode(battle.mode)}</span>
          {battle.map && (
            <>
              <span>·</span>
              <span>{battle.map}</span>
            </>
          )}
        </div>
      </div>

      {/* Trophy change & time */}
      <div className="flex-shrink-0 text-right">
        {battle.trophy_change !== 0 && (
          <p className={`text-sm font-bold ${battle.trophy_change > 0 ? "text-green-500" : "text-red-500"}`}>
            {battle.trophy_change > 0 ? `+${battle.trophy_change}` : battle.trophy_change}
          </p>
        )}
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {timeAgo(battle.battle_time)}
        </p>
      </div>
    </div>
  );
}

export default function BattleFeedPage() {
  const [battles, setBattles] = useState<Battle[]>([]);
  const [total, setTotal] = useState(0);
  const [modes, setModes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filterMode, setFilterMode] = useState<string>("");
  const [filterResult, setFilterResult] = useState<string>("");
  const [showFilters, setShowFilters] = useState(false);

  const PAGE_SIZE = 50;

  const loadBattles = useCallback(
    async (offset = 0, append = false) => {
      try {
        if (!append) setIsLoading(true);
        else setIsLoadingMore(true);

        const params = new URLSearchParams({
          limit: PAGE_SIZE.toString(),
          offset: offset.toString(),
        });
        if (filterMode) params.set("mode", filterMode);
        if (filterResult) params.set("result", filterResult);

        const res = await fetch(`/api/battles/feed?${params}`);
        if (res.ok) {
          const data = await res.json();
          if (append) {
            setBattles((prev) => [...prev, ...data.battles]);
          } else {
            setBattles(data.battles);
            setModes(data.modes || []);
          }
          setTotal(data.total || 0);
        }
      } catch (err) {
        console.error("Error loading battle feed:", err);
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [filterMode, filterResult]
  );

  useEffect(() => {
    loadBattles(0, false);
  }, [loadBattles]);

  // Compute quick stats from loaded battles
  const stats = {
    total: total,
    victories: battles.filter((b) => b.result === "victory").length,
    defeats: battles.filter((b) => b.result === "defeat").length,
    starPlayers: battles.filter((b) => b.is_star_player).length,
  };

  return (
    <LayoutWrapper>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Swords className="h-6 w-6 text-blue-500" />
              Battle Feed
            </h1>
            <p className="text-sm text-muted-foreground">
              {total.toLocaleString()} battles tracked
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
            className="gap-1.5"
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
            {(filterMode || filterResult) && (
              <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px]">
                {(filterMode ? 1 : 0) + (filterResult ? 1 : 0)}
              </Badge>
            )}
          </Button>
        </div>

        {/* Filters */}
        {showFilters && (
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex flex-wrap gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Mode</label>
                  <select
                    value={filterMode}
                    onChange={(e) => setFilterMode(e.target.value)}
                    className="block w-40 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  >
                    <option value="">All Modes</option>
                    {modes.map((m) => (
                      <option key={m} value={m}>
                        {getModeIcon(m)} {formatMode(m)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Result</label>
                  <select
                    value={filterResult}
                    onChange={(e) => setFilterResult(e.target.value)}
                    className="block w-32 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  >
                    <option value="">All Results</option>
                    <option value="victory">Victory</option>
                    <option value="defeat">Defeat</option>
                    <option value="draw">Draw</option>
                  </select>
                </div>
                {(filterMode || filterResult) && (
                  <div className="flex items-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setFilterMode("");
                        setFilterResult("");
                      }}
                    >
                      Clear
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Quick Stats Bar */}
        {!isLoading && battles.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Total Battles", value: total.toLocaleString(), icon: Swords, color: "text-blue-500" },
              { label: "Victories", value: stats.victories, icon: Trophy, color: "text-green-500" },
              { label: "Defeats", value: stats.defeats, icon: Clock, color: "text-red-500" },
              { label: "Star Players", value: stats.starPlayers, icon: Star, color: "text-yellow-500" },
            ].map((s) => (
              <div key={s.label} className="flex items-center gap-2 p-3 rounded-lg border border-border bg-card">
                <s.icon className={`h-4 w-4 ${s.color}`} />
                <div>
                  <p className="text-lg font-bold leading-tight">{s.value}</p>
                  <p className="text-[11px] text-muted-foreground">{s.label}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Battle Feed */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              Recent Battles
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            ) : battles.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Swords className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p className="font-medium">No battles recorded yet</p>
                <p className="text-sm mt-1">Battles will appear here after syncing your club.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {battles.map((battle) => (
                  <BattleCard key={`${battle.player_tag}-${battle.battle_time}`} battle={battle} />
                ))}

                {/* Load More */}
                {battles.length < total && (
                  <div className="pt-3 text-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => loadBattles(battles.length, true)}
                      disabled={isLoadingMore}
                      className="gap-1.5"
                    >
                      {isLoadingMore ? (
                        <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-primary" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                      Load More ({total - battles.length} remaining)
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </LayoutWrapper>
  );
}
