"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Swords,
  Trophy,
  Star,
  ChevronDown,
  Clock,
  Shield,
  ShieldAlert,
  Search,
  Radio,
  X,
} from "lucide-react";

interface TeamPlayer {
  tag: string;
  name: string;
  brawler: string | null;
  power: number | null;
}

interface ClubPlayer {
  tag: string;
  name: string;
  brawler: string | null;
  power: number | null;
  result: string;
  trophy_change: number;
  is_star_player: boolean;
}

interface Match {
  battle_time: string;
  mode: string;
  map: string;
  clubPlayers: ClubPlayer[];
  ourTeam: TeamPlayer[] | null;
  theirTeam: TeamPlayer[] | null;
  isShowdown?: boolean;
}

const RESULT_STYLES: Record<string, { bg: string; text: string; border: string; label: string }> = {
  victory: { bg: "bg-green-500/10", text: "text-green-500", border: "border-green-500/30", label: "Victory" },
  defeat: { bg: "bg-red-500/10", text: "text-red-500", border: "border-red-500/30", label: "Defeat" },
  draw: { bg: "bg-yellow-500/10", text: "text-yellow-500", border: "border-yellow-500/30", label: "Draw" },
};

const MODE_ICONS: Record<string, string> = {
  gemGrab: "\uD83D\uDC8E",
  brawlBall: "\u26BD",
  heist: "\uD83D\uDD13",
  bounty: "\u2B50",
  siege: "\uD83D\uDD27",
  hotZone: "\uD83D\uDD25",
  knockout: "\uD83D\uDC80",
  showdown: "\uD83C\uDFDC\uFE0F",
  duoShowdown: "\uD83D\uDC65",
  soloShowdown: "\uD83C\uDFDC\uFE0F",
  wipeout: "\uD83D\uDCA5",
  payload: "\uD83D\uDCE6",
  trophyThieves: "\uD83C\uDFC6",
  duels: "\u2694\uFE0F",
  paintBrawl: "\uD83C\uDFA8",
  brawlBall5V5: "\u26BD",
  unknown: "\u2694\uFE0F",
};

interface MemberOption {
  tag: string;
  name: string;
}

function formatMode(mode: string | null): string {
  if (!mode || mode === "unknown") return "Friendly/Custom";
  return mode.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).replace(/5 V 5/, "5v5").trim();
}

function getModeIcon(mode: string | null): string {
  if (!mode) return "\u2694\uFE0F";
  return MODE_ICONS[mode] || "\u2694\uFE0F";
}

// Compute time-ago using a server-relative clock to avoid client timezone/clock issues.
// clockDelta = clientNow - serverNow at the moment the API responded.
// adjustedNow = Date.now() - clockDelta ≈ current server time.
function timeAgo(dateStr: string, clockDelta = 0): string {
  const now = Date.now() - clockDelta;
  const date = new Date(dateStr).getTime();
  const seconds = Math.floor((now - date) / 1000);
  // Handle small future values (clock skew / remaining offset)
  if (seconds < 0) {
    if (seconds > -120) return "just now";
    // Larger future gap: show absolute value as approximate relative time
    const absSec = Math.abs(seconds);
    const m = Math.floor(absSec / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return new Date(dateStr).toLocaleDateString();
  }
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function PlayerRow({ tag, name, brawler, power, isClub, trophyChange, isStar, result }: {
  tag: string;
  name: string;
  brawler: string | null;
  power: number | null;
  isClub: boolean;
  trophyChange?: number;
  isStar?: boolean;
  result?: string;
}) {
  const inner = (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-2 min-w-0">
        {isClub && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />}
        <span className={`text-sm truncate ${isClub ? "font-semibold" : "text-muted-foreground"}`}>
          {name}
        </span>
        {isStar && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 flex-shrink-0" />}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
        {brawler && (
          <span className="text-xs text-muted-foreground">
            {brawler}{power ? ` Lv${power}` : ""}
          </span>
        )}
        {trophyChange !== undefined && trophyChange !== 0 && (
          <span className={`text-xs font-bold min-w-[32px] text-right ${trophyChange > 0 ? "text-green-500" : "text-red-500"}`}>
            {trophyChange > 0 ? `+${trophyChange}` : trophyChange}
          </span>
        )}
      </div>
    </div>
  );

  if (isClub) {
    return (
      <Link href={`/members/${encodeURIComponent(tag)}`} className="hover:bg-accent/50 rounded px-1 -mx-1 block">
        {inner}
      </Link>
    );
  }
  return <div className="px-1 -mx-1">{inner}</div>;
}

function MatchCard({ match, clubTags, clockDelta }: { match: Match; clubTags: Set<string>; clockDelta: number }) {
  const mainResult = match.clubPlayers[0]?.result || "unknown";
  const style = RESULT_STYLES[mainResult] || RESULT_STYLES.draw;
  const totalTrophyChange = match.clubPlayers.reduce((s, p) => s + p.trophy_change, 0);

  return (
    <div className={`rounded-xl border ${style.border} ${style.bg} overflow-hidden`}>
      {/* Match header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50">
        <div className="flex items-center gap-2">
          <span className="text-lg">{getModeIcon(match.mode)}</span>
          <div>
            <span className="text-sm font-semibold">{formatMode(match.mode)}</span>
            <span className="text-xs text-muted-foreground ml-2">{match.map !== "unknown" ? match.map : ""}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className={`${style.text} border-current text-xs`}>
            {style.label}
          </Badge>
          {totalTrophyChange !== 0 && (
            <span className={`text-sm font-bold ${totalTrophyChange > 0 ? "text-green-500" : "text-red-500"}`}>
              {totalTrophyChange > 0 ? `+${totalTrophyChange}` : totalTrophyChange}
            </span>
          )}
          <span className="text-xs text-muted-foreground">{timeAgo(match.battle_time, clockDelta)}</span>
        </div>
      </div>

      {/* Teams */}
      {match.isShowdown ? (
        /* Showdown layout: single column with club player(s) */
        <div className="px-4 py-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Shield className="h-3.5 w-3.5 text-blue-500" />
            <span className="text-xs font-semibold text-blue-500 uppercase tracking-wide">Players</span>
          </div>
          <div className="space-y-0.5">
            {(match.ourTeam || match.clubPlayers).map((p) => {
              const clubPlayer = match.clubPlayers.find((cp) => cp.tag === p.tag);
              const isClub = clubTags.has(p.tag) || !!clubPlayer;
              return (
                <PlayerRow
                  key={p.tag}
                  tag={p.tag}
                  name={isClub ? (clubPlayer?.name || p.name) : p.name}
                  brawler={clubPlayer?.brawler || p.brawler}
                  power={clubPlayer?.power || p.power}
                  isClub={isClub}
                  trophyChange={clubPlayer?.trophy_change}
                  isStar={clubPlayer?.is_star_player}
                />
              );
            })}
          </div>
          {match.theirTeam && match.theirTeam.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 mb-2 mt-3">
                <ShieldAlert className="h-3.5 w-3.5 text-red-500" />
                <span className="text-xs font-semibold text-red-500 uppercase tracking-wide">Other Players</span>
              </div>
              <div className="space-y-0.5">
                {match.theirTeam.map((p) => (
                  <PlayerRow
                    key={p.tag}
                    tag={p.tag}
                    name={p.name}
                    brawler={p.brawler}
                    power={p.power}
                    isClub={clubTags.has(p.tag)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border/50">
          {/* Our team */}
          <div className="px-4 py-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Shield className="h-3.5 w-3.5 text-blue-500" />
              <span className="text-xs font-semibold text-blue-500 uppercase tracking-wide">Your Team</span>
            </div>
            <div className="space-y-0.5">
              {match.ourTeam ? (
                match.ourTeam.map((p) => {
                  const clubPlayer = match.clubPlayers.find((cp) => cp.tag === p.tag);
                  const isClub = clubTags.has(p.tag) || !!clubPlayer;
                  return (
                    <PlayerRow
                      key={p.tag}
                      tag={p.tag}
                      name={isClub ? (clubPlayer?.name || p.name) : p.name}
                      brawler={clubPlayer?.brawler || p.brawler}
                      power={clubPlayer?.power || p.power}
                      isClub={isClub}
                      trophyChange={clubPlayer?.trophy_change}
                      isStar={clubPlayer?.is_star_player}
                    />
                  );
                })
              ) : (
                match.clubPlayers.map((p) => (
                  <PlayerRow
                    key={p.tag}
                    tag={p.tag}
                    name={p.name}
                    brawler={p.brawler}
                    power={p.power}
                    isClub={true}
                    trophyChange={p.trophy_change}
                    isStar={p.is_star_player}
                  />
                ))
              )}
            </div>
          </div>

          {/* Opponent team */}
          <div className="px-4 py-3">
            <div className="flex items-center gap-1.5 mb-2">
              <ShieldAlert className="h-3.5 w-3.5 text-red-500" />
              <span className="text-xs font-semibold text-red-500 uppercase tracking-wide">Opponents</span>
            </div>
            <div className="space-y-0.5">
              {match.theirTeam ? (
                match.theirTeam.map((p) => (
                  <PlayerRow
                    key={p.tag}
                    tag={p.tag}
                    name={p.name}
                    brawler={p.brawler}
                    power={p.power}
                    isClub={clubTags.has(p.tag)}
                  />
                ))
              ) : (
                <p className="text-xs text-muted-foreground italic py-2">
                  No opponent data available
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BattleFeedPage() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [total, setTotal] = useState(0);
  const [modes, setModes] = useState<string[]>([]);
  const [memberList, setMemberList] = useState<MemberOption[]>([]);
  const [clubTags, setClubTags] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filterMode, setFilterMode] = useState<string>("");
  const [filterPlayer, setFilterPlayer] = useState<string>("");
  const [filterDate, setFilterDate] = useState<string>("");
  const [memberSearch, setMemberSearch] = useState<string>("");
  const [showMemberDropdown, setShowMemberDropdown] = useState(false);
  const [rawOffset, setRawOffset] = useState(0);
  const [isLive, setIsLive] = useState(false);
  const [clockDelta, setClockDelta] = useState(0);
  const memberDropdownRef = useRef<HTMLDivElement>(null);

  const PAGE_SIZE = 50;

  const loadMatches = useCallback(
    async (offset = 0, append = false) => {
      try {
        if (!append) setIsLoading(true);
        else setIsLoadingMore(true);

        const params = new URLSearchParams({
          limit: PAGE_SIZE.toString(),
          offset: offset.toString(),
        });
        if (filterMode) params.set("mode", filterMode);
        if (filterPlayer) params.set("player", filterPlayer);
        if (filterDate) params.set("date", filterDate);

        const [feedRes, membersRes] = await Promise.all([
          fetch(`/api/battles/feed?${params}`),
          !append ? fetch("/api/members") : Promise.resolve(null),
        ]);

        if (feedRes.ok) {
          const data = await feedRes.json();
          // Compute clock delta: difference between client clock and server clock.
          // This corrects any timezone or clock discrepancy.
          if (data.serverTime) {
            const delta = Date.now() - new Date(data.serverTime).getTime();
            setClockDelta(delta);
          }
          if (append) {
            setMatches((prev) => [...prev, ...(data.matches || [])]);
          } else {
            setMatches(data.matches || []);
            setModes(data.modes || []);
            if (data.members) setMemberList(data.members);
          }
          setTotal(data.total || 0);
          setRawOffset(offset + PAGE_SIZE);
        }

        if (membersRes && (membersRes as Response).ok) {
          const data = await (membersRes as Response).json();
          const tags = new Set<string>((data.members || []).map((m: { player_tag: string }) => m.player_tag));
          setClubTags(tags);
        }
      } catch (err) {
        console.error("Error loading matches:", err);
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [filterMode, filterPlayer, filterDate]
  );

  useEffect(() => {
    setRawOffset(0);
    loadMatches(0, false);
  }, [loadMatches]);

  // Supabase Realtime: listen for new battle_history inserts
  const loadMatchesRef = useRef(loadMatches);
  loadMatchesRef.current = loadMatches;

  useEffect(() => {
    const channel = supabase
      .channel("battle-feed-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "battle_history" },
        () => {
          // Reload from the top when new battles arrive
          loadMatchesRef.current(0, false);
        }
      )
      .subscribe((status) => {
        setIsLive(status === "SUBSCRIBED");
      });

    return () => {
      supabase.removeChannel(channel);
      setIsLive(false);
    };
  }, []);

  // Close member dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (memberDropdownRef.current && !memberDropdownRef.current.contains(e.target as Node)) {
        setShowMemberDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredMembers = memberList.filter(
    (m) =>
      m.name.toLowerCase().includes(memberSearch.toLowerCase()) ||
      m.tag.toLowerCase().includes(memberSearch.toLowerCase())
  );

  const selectedMemberName = memberList.find((m) => m.tag === filterPlayer)?.name || "";

  return (
    <LayoutWrapper>
      <div className="space-y-4">
        {/* Header + Filters */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Swords className="h-6 w-6 text-blue-500" />
              Battle Feed
            </h1>
            <div className="flex items-center gap-3">
              <p className="text-sm text-muted-foreground">
                {total.toLocaleString()} battles tracked
              </p>
              {isLive && (
                <span className="flex items-center gap-1.5 text-xs font-medium text-green-500">
                  <Radio className="h-3 w-3 animate-pulse" />
                  Live
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={filterMode}
              onChange={(e) => setFilterMode(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="">All Modes</option>
              {modes.map((m) => (
                <option key={m} value={m}>
                  {getModeIcon(m)} {formatMode(m)}
                </option>
              ))}
            </select>
            <div className="relative" ref={memberDropdownRef}>
              <div className="relative">
                <input
                  type="text"
                  value={filterPlayer ? selectedMemberName : memberSearch}
                  onChange={(e) => {
                    setMemberSearch(e.target.value);
                    setFilterPlayer("");
                    setShowMemberDropdown(true);
                  }}
                  onFocus={() => setShowMemberDropdown(true)}
                  placeholder="Search member..."
                  className="h-9 w-44 rounded-md border border-border bg-background px-2 text-sm placeholder:text-muted-foreground/50 pr-7"
                />
                {filterPlayer && (
                  <button
                    onClick={() => { setFilterPlayer(""); setMemberSearch(""); }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                {showMemberDropdown && !filterPlayer && (
                  <div className="absolute right-0 z-50 mt-1 w-56 max-h-52 overflow-y-auto rounded-md border border-border bg-background shadow-lg">
                    {filteredMembers.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">No members found</div>
                    ) : (
                      filteredMembers.map((m) => (
                        <button
                          key={m.tag}
                          onClick={() => {
                            setFilterPlayer(m.tag);
                            setMemberSearch("");
                            setShowMemberDropdown(false);
                          }}
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 flex justify-between items-center"
                        >
                          <span>{m.name}</span>
                          <span className="text-xs text-muted-foreground">{m.tag}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
            <select
              value={filterDate}
              onChange={(e) => setFilterDate(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="">All Days</option>
              {(() => {
                const days: { label: string; value: string }[] = [];
                const now = new Date();
                for (let i = 0; i < 14; i++) {
                  const d = new Date(now);
                  d.setDate(d.getDate() - i);
                  const value = d.toISOString().slice(0, 10);
                  let label: string;
                  if (i === 0) label = "Today";
                  else if (i === 1) label = "Yesterday";
                  else label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  days.push({ label, value });
                }
                return days.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ));
              })()}
            </select>
            {(filterMode || filterPlayer || filterDate) && (
              <Button variant="ghost" size="sm" className="h-9 px-2" onClick={() => { setFilterMode(""); setFilterPlayer(""); setFilterDate(""); setMemberSearch(""); }}>
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Matches */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : matches.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <Swords className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No matches recorded yet</p>
              <p className="text-sm mt-1">Matches will appear here after syncing your club.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {matches.map((match, i) => (
              <MatchCard
                key={`${match.battle_time}-${match.mode}-${i}`}
                match={match}
                clubTags={clubTags}
                clockDelta={clockDelta}
              />
            ))}

            {rawOffset < total && (
              <div className="pt-2 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => loadMatches(rawOffset, true)}
                  disabled={isLoadingMore}
                  className="gap-1.5"
                >
                  {isLoadingMore ? (
                    <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-primary" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  Load More
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </LayoutWrapper>
  );
}
