"use client";
import { T, useI18n } from "@/components/locale-provider";


import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { fetchJsonCached } from "@/lib/client-data-cache";
import { getBrawlerIconFromMap, normalizeBrawlerName } from "@/lib/brawl-assets";
import { battleContextOptions, describeBattleContext, getBattleModeInfo } from "@/lib/battle-catalog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { DataConfidenceNotice } from "@/components/sync-health";
import { TimeRangePicker } from "@/components/time-range-picker";
import { type TimeRangeKey } from "@/lib/time-range";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Swords,
  Star,
  ChevronDown,
  ChevronUp,
  Shield,
  ShieldAlert,
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
  result: string | null;
  trophy_change: number | null;
  pointData?: { change: number | null; unit: "trophies" | "unknown" };
  is_star_player: boolean;
}

interface Match {
  matchId?: string;
  battle_time: string;
  mode: string | null;
  map: string | null;
  context?: { key: string; label: string };
  battle_type?: string | null;
  event_id?: number | null;
  event_mode_id?: number | null;
  battle_mode?: string | null;
  event_mode?: string | null;
  placement_rank?: number | null;
  clubPlayers: ClubPlayer[];
  ourTeam: TeamPlayer[] | null;
  theirTeam: TeamPlayer[] | null;
  isShowdown?: boolean;
  teamCount?: number;
  teams?: TeamPlayer[][];
}

function matchKey(match: Match): string {
  return match.matchId || JSON.stringify([match.battle_time, match.mode, match.map,
    match.clubPlayers.map(player => normalizeTag(player.tag)).sort()]);
}

const RESULT_STYLES: Record<string, { bg: string; text: string; border: string; label: string }> = {
  victory: { bg: "bg-green-500/10", text: "text-green-500", border: "border-green-500/30", label: "Victory" },
  defeat: { bg: "bg-red-500/10", text: "text-red-500", border: "border-red-500/30", label: "Defeat" },
  draw: { bg: "bg-yellow-500/10", text: "text-yellow-500", border: "border-yellow-500/30", label: "Draw" },
  unknown: { bg: "bg-card", text: "text-muted-foreground", border: "border-border", label: "Unknown result" },
  mixed: { bg: "bg-card", text: "text-muted-foreground", border: "border-border", label: "Mixed results" },
};

interface MemberOption {
  tag: string;
  name: string;
}

interface BattleFeedResponse {
  serverTime?: string;
  matches?: Match[];
  modes?: string[];
  contexts?: { key: string; label: string; count: number }[];
  members?: MemberOption[];
  total?: number;
  nextOffset?: number | null;
}

function normalizeTag(tag: string | null | undefined): string {
  if (!tag) return "";
  const trimmed = tag.trim();
  const decoded = /^%23/i.test(trimmed) ? `#${trimmed.slice(3)}` : trimmed;
  const withHash = decoded.startsWith("#") ? decoded : `#${decoded}`;
  return withHash.toUpperCase();
}

// Compute time-ago using a server-relative clock to avoid client timezone/clock issues.
// clockDelta = clientNow - serverNow at the moment the API responded.
// adjustedNow = Date.now() - clockDelta ≈ current server time.


function BrawlerChip({ brawler, power, brawlerIconByName }: {
  brawler: string | null;
  power: number | null;
  brawlerIconByName: Record<string, string>;
}) {
  const [imgError, setImgError] = useState(false);

  if (!brawler) {
    return <span className="text-xs text-muted-foreground"><T text="Unknown Brawler" /></span>;
  }

  const iconUrl = getBrawlerIconFromMap(brawler, brawlerIconByName);

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative h-7 w-7 overflow-visible">
        <div className="h-7 w-7 rounded-md overflow-hidden bg-muted/30 border border-border/70 shadow-sm">
          {iconUrl && !imgError ? (
            <Image
              src={iconUrl}
              alt={brawler}
              width={28}
              height={28}
              className="h-full w-full object-cover"
              onError={() => setImgError(true)}
            />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-muted-foreground">
              {brawler.charAt(0)}
            </span>
          )}
        </div>
        {power ? (
          <span className="absolute end-0 bottom-0 translate-x-1/4 translate-y-1/4 min-w-[15px] h-[15px] rounded-full bg-black text-white border border-white/40 text-[9px] leading-[15px] text-center font-bold shadow">
            {power}
          </span>
        ) : null}
      </div>
      <span className="text-xs text-muted-foreground truncate max-w-[88px]">{brawler}</span>
    </div>
  );
}

function PlayerRow({ tag, name, brawler, power, isClub, trophyChange, pointData, isStar, result, brawlerIconByName }: {
  tag: string;
  name: string;
  brawler: string | null;
  power: number | null;
  isClub: boolean;
  trophyChange?: number | null;
  pointData?: ClubPlayer["pointData"];
  isStar?: boolean;
  result?: string | null;
  brawlerIconByName: Record<string, string>;
}) {
  const { delta, t } = useI18n();
  const change = pointData ? pointData.change : trophyChange;
  const inner = (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-2 min-w-0">
        {isClub && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />}
        <span className={`text-sm truncate ${isClub ? "font-semibold" : "text-muted-foreground"}`}>
          {name}
        </span>
        {isStar && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 flex-shrink-0" />}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 ms-2">
        <BrawlerChip brawler={brawler} power={power} brawlerIconByName={brawlerIconByName} />
        {(isClub || trophyChange !== undefined) && (
          <span title={t(pointData?.unit === "trophies" ? "Trophy change" : "Reported change")} className={`text-xs font-bold min-w-[34px] text-end ${
            change != null && change > 0 ? "text-green-500" : change != null && change < 0 ? "text-red-500" : "text-muted-foreground"
          }`}>
            <bdi>{delta(change)}</bdi>
          </span>
        )}
        {result !== undefined && (
          <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground border-border">
            {t((RESULT_STYLES[result || "unknown"] || RESULT_STYLES.unknown).label)}</Badge>
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

function MatchCard({ match, clubTags, clockDelta, brawlerIconByName }: {
  match: Match;
  clubTags: Set<string>;
  clockDelta: number;
  brawlerIconByName: Record<string, string>;
}) {
  const { relative, t, delta } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const results = new Set(match.clubPlayers.map(player => player.result || "unknown"));
  const mainResult = results.size > 1 ? "mixed" : match.clubPlayers[0]?.result || "unknown";
  const style = RESULT_STYLES[mainResult] || RESULT_STYLES.unknown;
  const changes = match.clubPlayers.map(player => player.pointData ? player.pointData.change : player.trophy_change);
  const pointUnits = new Set(match.clubPlayers.map(player => player.pointData?.unit || "unknown"));
  const totalChange = changes.length > 0 && changes.every(change => change != null) && pointUnits.size === 1
    ? changes.reduce<number>((sum, change) => sum + change!, 0) : null;
  const totalIsTrophies = pointUnits.size === 1 && pointUnits.has("trophies");
  const normalizedClubTags = new Set([...clubTags].map((tag) => normalizeTag(tag)));
  const matchType = match.context || describeBattleContext(match);
  const mode = getBattleModeInfo(match.mode, match.event_mode_id);
  const hasMultipleTeams = ((match.teams?.length || 0) > 2 && match.teams!.some(team => team.length > 1)) || mode.key === "trioShowdown" || mode.key === "duoShowdown";
  const usePlayerLayout = match.isShowdown || (match.teamCount || 0) > 2 || hasMultipleTeams || !match.ourTeam || !match.theirTeam;

  return (
    <div className={`rounded-xl border ${style.border} ${style.bg} overflow-hidden`}>
      {/* Match header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-border/50">
        <div className="flex items-center gap-2">
          {mode.imageUrl ? <Image src={mode.imageUrl} alt="" width={22} height={22} className="h-[22px] w-[22px] object-contain" /> : <span aria-hidden="true" className="text-lg">{mode.icon}</span>}
          <div>
            <span className="text-sm font-semibold">{t(mode.label)}</span>
            <span className="text-xs text-muted-foreground ms-2">{match.map !== "unknown" ? match.map : ""}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-xs text-muted-foreground">
            {<T text={matchType.label} />}
          </Badge>
          {hasMultipleTeams && (
            <Badge variant="outline" className="text-xs text-muted-foreground"><T text="Multiple teams" /></Badge>
          )}
          <Badge variant="outline" className={`${style.text} border-current text-xs`}>
            {<T text={style.label} />}
          </Badge>
            <span title={t(totalIsTrophies ? "Club trophy change" : "Reported change")} className={`text-sm font-bold ${
              totalChange != null && totalChange > 0 ? "text-green-500" : totalChange != null && totalChange < 0 ? "text-red-500" : "text-muted-foreground"
            }`}>
              <bdi>{delta(totalChange)}</bdi>
            </span>
          <span className="text-xs text-muted-foreground">{relative(new Date(new Date(match.battle_time).getTime() + clockDelta))}</span>
        </div>
      </div>

      <div className="px-4 py-2.5 border-b border-border/40">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold"><T text="Club Players" /></span>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {expanded ? <T text="Hide Teams" /> : <T text="Show Teams" />}
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="space-y-0.5">
          {match.clubPlayers.map((p) => (
            <PlayerRow
              key={`compact-${p.tag}`}
              tag={p.tag}
              name={p.name}
              brawler={p.brawler}
              power={p.power}
              isClub={true}
              trophyChange={p.trophy_change}
              pointData={p.pointData}
              isStar={p.is_star_player}
              result={results.size > 1 ? p.result : undefined}
              brawlerIconByName={brawlerIconByName}
            />
          ))}
        </div>
      </div>

      {/* Teams */}
      {expanded && (match.teams && match.teams.some(team => team.length > 1) ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-4 py-3">
          {match.teams.map((team, index) => (
            <div key={team.map(player => normalizeTag(player.tag)).sort().join("|")}>
              <p className="mb-2 text-xs font-semibold text-muted-foreground">{t("Team {number}", { number: index + 1 })}</p>
              {team.map(player => {
                const playerTag = normalizeTag(player.tag);
                const clubPlayer = match.clubPlayers.find(item => normalizeTag(item.tag) === playerTag);
                return <PlayerRow key={playerTag} tag={player.tag} name={clubPlayer?.name || player.name}
                  brawler={clubPlayer?.brawler || player.brawler} power={clubPlayer?.power ?? player.power}
                  isClub={normalizedClubTags.has(playerTag) || !!clubPlayer} trophyChange={clubPlayer?.trophy_change}
                  pointData={clubPlayer?.pointData}
                  isStar={clubPlayer?.is_star_player} brawlerIconByName={brawlerIconByName} />;
              })}
            </div>
          ))}
        </div>
      ) : usePlayerLayout ? (
        /* Showdown layout: single column with club player(s) */
        <div className="px-4 py-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Shield className="h-3.5 w-3.5 text-blue-500" />
            <span className="text-xs font-semibold text-blue-500 uppercase tracking-wide"><T text="Players" /></span>
          </div>
          <div className="space-y-0.5">
            {(match.ourTeam || match.clubPlayers).map((p) => {
              const playerTag = normalizeTag(p.tag);
              const clubPlayer = match.clubPlayers.find((cp) => normalizeTag(cp.tag) === playerTag);
              const isClub = normalizedClubTags.has(playerTag) || !!clubPlayer;
              return (
                <PlayerRow
                  key={p.tag}
                  tag={p.tag}
                  name={isClub ? (clubPlayer?.name || p.name) : p.name}
                  brawler={clubPlayer?.brawler || p.brawler}
                  power={clubPlayer?.power || p.power}
                  isClub={isClub}
                  trophyChange={clubPlayer?.trophy_change}
                  pointData={clubPlayer?.pointData}
                  isStar={clubPlayer?.is_star_player}
                  brawlerIconByName={brawlerIconByName}
                />
              );
            })}
          </div>
          {match.theirTeam && match.theirTeam.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 mb-2 mt-3">
                <ShieldAlert className="h-3.5 w-3.5 text-red-500" />
                <span className="text-xs font-semibold text-red-500 uppercase tracking-wide"><T text="Other Players" /></span>
              </div>
              <div className="space-y-0.5">
                {match.theirTeam.map((p) => (
                  <PlayerRow
                    key={p.tag}
                    tag={p.tag}
                    name={p.name}
                    brawler={p.brawler}
                    power={p.power}
                    isClub={normalizedClubTags.has(normalizeTag(p.tag))}
                    brawlerIconByName={brawlerIconByName}
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
              <span className="text-xs font-semibold text-blue-500 uppercase tracking-wide"><T text="Your Team" /></span>
            </div>
            <div className="space-y-0.5">
              {match.ourTeam ? (
                match.ourTeam.map((p) => {
                  const playerTag = normalizeTag(p.tag);
                  const clubPlayer = match.clubPlayers.find((cp) => normalizeTag(cp.tag) === playerTag);
                  const isClub = normalizedClubTags.has(playerTag) || !!clubPlayer;
                  return (
                    <PlayerRow
                      key={p.tag}
                      tag={p.tag}
                      name={isClub ? (clubPlayer?.name || p.name) : p.name}
                      brawler={clubPlayer?.brawler || p.brawler}
                      power={clubPlayer?.power || p.power}
                      isClub={isClub}
                      trophyChange={clubPlayer?.trophy_change}
                      pointData={clubPlayer?.pointData}
                      isStar={clubPlayer?.is_star_player}
                      brawlerIconByName={brawlerIconByName}
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
                    pointData={p.pointData}
                    isStar={p.is_star_player}
                    brawlerIconByName={brawlerIconByName}
                  />
                ))
              )}
            </div>
          </div>

          {/* Opponent team */}
          <div className="px-4 py-3">
            <div className="flex items-center gap-1.5 mb-2">
              <ShieldAlert className="h-3.5 w-3.5 text-red-500" />
              <span className="text-xs font-semibold text-red-500 uppercase tracking-wide"><T text="Opponents" /></span>
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
                    isClub={normalizedClubTags.has(normalizeTag(p.tag))}
                    brawlerIconByName={brawlerIconByName}
                  />
                ))
              ) : (
                <p className="text-xs text-muted-foreground italic py-2">
                  <T text=" No opponent data available " /></p>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function BattleFeedPage() {
  const { number } = useI18n();
  const { t } = useI18n();
  const [matches, setMatches] = useState<Match[]>([]);
  const [total, setTotal] = useState(0);
  const [modes, setModes] = useState<string[]>([]);
  const [contextCounts, setContextCounts] = useState<Record<string, number>>({});
  const [memberList, setMemberList] = useState<MemberOption[]>([]);
  const [clubTags, setClubTags] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterMode, setFilterMode] = useState<string>("");
  const [filterContext, setFilterContext] = useState<string>("");
  const [filterPlayer, setFilterPlayer] = useState<string>("");
  const [selectedRange, setSelectedRange] = useState<TimeRangeKey>("7d");
  const [memberSearch, setMemberSearch] = useState<string>("");
  const [showMemberDropdown, setShowMemberDropdown] = useState(false);
  const [rawOffset, setRawOffset] = useState<number | null>(0);
  const [loadError, setLoadError] = useState(false);
  const [clockDelta, setClockDelta] = useState(0);
  const [brawlerIconByName, setBrawlerIconByName] = useState<Record<string, string>>({});
  const loadSequence = useRef(0);

  const PAGE_SIZE = 50;

  const loadMatches = useCallback(
    async (offset = 0, append = false, force = false) => {
      const sequence = ++loadSequence.current;
      setLoadError(false);
      try {
        if (append || force) setIsLoadingMore(true);
        else if (!force) setIsLoading(true);

        const params = new URLSearchParams({
          limit: PAGE_SIZE.toString(),
          offset: offset.toString(),
          range: selectedRange,
        });
        if (filterMode) params.set("mode", filterMode);
        if (filterContext) params.set("context", filterContext);
        if (filterPlayer) params.set("player", filterPlayer);

        const [data, membersData] = await Promise.all([
          fetchJsonCached<BattleFeedResponse>(`/api/battles/feed?${params}`, {
            staleMs: 15_000,
            force,
          }),
          !append
            ? fetchJsonCached<{ members?: { player_tag: string }[] }>("/api/members", {
                staleMs: 30_000,
                force,
              })
            : Promise.resolve(null),
        ]);
        if (sequence !== loadSequence.current) return;

        // Compute clock delta: difference between client clock and server clock.
        // Relative ages use the server clock; battle timestamps remain unchanged.
        if (data.serverTime) {
          const delta = Date.now() - new Date(data.serverTime).getTime();
          setClockDelta(delta);
        }
        if (append) {
          setMatches((prev) => {
            const merged = new Map(prev.map((match) => [matchKey(match), match]));
            for (const match of data.matches || []) {
              const previous = merged.get(matchKey(match));
              merged.set(matchKey(match), previous ? {
                ...match,
                // Inserts can shift an offset onto a previously displayed squad.
                // Keep its known participants when the overlapping page starts mid-match.
                clubPlayers: Array.from(new Map(
                  [...previous.clubPlayers, ...match.clubPlayers].map((player) => [normalizeTag(player.tag), player])
                ).values()),
                ourTeam: match.ourTeam || previous.ourTeam,
                theirTeam: match.theirTeam || previous.theirTeam,
              } : match);
            }
            return Array.from(merged.values());
          });
        } else {
          setMatches(data.matches || []);
          setModes(data.modes || []);
          setContextCounts(Object.fromEntries((data.contexts || []).map(context => [context.key, context.count])));
          if (data.members) setMemberList(data.members);
        }
        setTotal(data.total || 0);
        setRawOffset(data.nextOffset ?? null);

        if (membersData) {
          const tags = new Set<string>((membersData.members || []).map((m) => normalizeTag(m.player_tag)));
          setClubTags(tags);
        }
      } catch (err) {
        if (sequence !== loadSequence.current) return;
        setLoadError(true);
        if (!append) setMatches([]);
        console.error("Error loading matches:", err);
      } finally {
        if (sequence === loadSequence.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [filterMode, filterContext, filterPlayer, selectedRange]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadBrawlerIcons() {
      try {
        const data = await fetchJsonCached<{
          list?: Array<{ name?: unknown; imageUrl2?: unknown }>;
        }>("https://api.brawlapi.com/v1/brawlers", {
          staleMs: 24 * 60 * 60 * 1000,
        });
        const list = Array.isArray(data?.list) ? data.list : [];
        const iconMap: Record<string, string> = {};
        for (const item of list) {
          if (!item?.name || !item?.imageUrl2) continue;
          const name = String(item.name);
          const url = String(item.imageUrl2);
          iconMap[name.toUpperCase()] = url;
          iconMap[normalizeBrawlerName(name)] = url;
        }
        if (!cancelled) {
          setBrawlerIconByName(iconMap);
        }
      } catch {
      }
    }

    loadBrawlerIcons();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setRawOffset(0);
    loadMatches(0, false);
  }, [loadMatches]);

  // Supabase Realtime: listen for new battle_history inserts
  const loadMatchesRef = useRef(loadMatches);
  loadMatchesRef.current = loadMatches;

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel("battle-feed-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "battle_history" },
        () => {
          // Coalesce a sync's inserts and bypass cached data after the last one.
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => loadMatchesRef.current(0, false, true), 250);
        }
      )
      .subscribe();

    return () => {
      clearTimeout(refreshTimer);
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    const handleClubDataUpdated = () => {
      loadMatchesRef.current(0, false, true);
    };
    window.addEventListener("club-data-updated", handleClubDataUpdated);
    return () => window.removeEventListener("club-data-updated", handleClubDataUpdated);
  }, []);

  // Close member dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (!(e.target instanceof Element) || !e.target.closest("[data-member-filter]")) {
        setShowMemberDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredMembers = useMemo(
    () => memberList.filter(
      (m) =>
        m.name.toLowerCase().includes(memberSearch.toLowerCase()) ||
        m.tag.toLowerCase().includes(memberSearch.toLowerCase())
    ),
    [memberList, memberSearch]
  );

  const selectedMemberName = useMemo(
    () => memberList.find((m) => m.tag === filterPlayer)?.name || "",
    [filterPlayer, memberList]
  );

  const availableModes = useMemo(() => Array.from(new Map(
    [...modes, ...(filterMode ? [filterMode] : [])].map(raw => {
      const mode = getBattleModeInfo(raw);
      return [mode.key, mode] as const;
    })
  ).values()).sort((left, right) => t(left.label).localeCompare(t(right.label))), [modes, filterMode, t]);

  const filterControls = (<div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
              <T text="Game mode" />
            <select
              aria-label={t("Game mode")} value={filterMode}
              onChange={(e) => setFilterMode(e.target.value)}
              className="h-9 max-w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
            >
              <option value=""><T text="All Modes" /></option>
              {availableModes.map((mode) => (
                <option key={mode.key} value={mode.key}>
                  {mode.icon} {t(mode.label)}
                </option>
              ))}
            </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
              <T text="Battle type / event" />
              <select aria-label={t("Battle type / event")} value={filterContext}
                onChange={event => setFilterContext(event.target.value)}
                className="h-9 max-w-full rounded-md border border-border bg-background px-2 text-sm text-foreground">
                <option value="">{t("All battle types")}</option>
                {battleContextOptions.map(context => <option key={context.key} value={context.key}>{t(context.label)}{contextCounts[context.key] !== undefined ? ` (${number(contextCounts[context.key])})` : ""}</option>)}
              </select>
            </label>
            <div className="relative" data-member-filter>
              <p className="mb-1 text-xs text-muted-foreground"><T text="Member" /></p>
              <div className="relative">
                <input
                  type="text"
                  aria-label={t("All Members / Search...")}
                  value={filterPlayer ? selectedMemberName : memberSearch}
                  onChange={(e) => {
                    setMemberSearch(e.target.value);
                    setFilterPlayer("");
                    setShowMemberDropdown(true);
                  }}
                  onFocus={() => setShowMemberDropdown(true)}
                  placeholder={t("All Members / Search...")}
                  className="h-9 w-full sm:w-44 rounded-md border border-border bg-background px-2 text-sm placeholder:text-muted-foreground/50 pe-7"
                />
                {filterPlayer && (
                  <button
                    aria-label={t("Clear member filter")}
                    onClick={() => { setFilterPlayer(""); setMemberSearch(""); }}
                    className="absolute end-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                {showMemberDropdown && !filterPlayer && (
                  <div className="absolute end-0 z-50 mt-1 w-56 max-h-52 overflow-y-auto rounded-md border border-border bg-background shadow-lg">
                    <button
                      onClick={() => {
                        setFilterPlayer("");
                        setMemberSearch("");
                        setShowMemberDropdown(false);
                      }}
                      className="w-full text-start px-3 py-1.5 text-sm hover:bg-accent/50 flex justify-between items-center border-b border-border/50"
                    >
                      <span><T text="All Members" /></span>
                      <span className="text-xs text-muted-foreground"><T text="Any" /></span>
                    </button>
                    {filteredMembers.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground"><T text="No members found" /></div>
                    ) : (
                      filteredMembers.map((m) => (
                        <button
                          key={m.tag}
                          onClick={() => {
                            setFilterPlayer(m.tag);
                            setMemberSearch("");
                            setShowMemberDropdown(false);
                          }}
                          className="w-full text-start px-3 py-1.5 text-sm hover:bg-accent/50 flex justify-between items-center"
                        >
                          <span>{m.name}</span>
                          <span className="text-xs text-muted-foreground"><bdi dir="ltr">{m.tag}</bdi></span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
            {(filterMode || filterContext || filterPlayer) && (
              <Button variant="ghost" size="sm" className="h-9 px-2" aria-label={t("Clear filters")} onClick={() => { setFilterMode(""); setFilterContext(""); setFilterPlayer(""); setMemberSearch(""); }}>
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>);

  return (
    <LayoutWrapper>
      <div className="space-y-4">
        {/* Header + Filters */}
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Swords className="h-6 w-6 text-blue-500" />
              <T text=" Battle Feed " /></h1>
            <div className="flex items-center gap-3">
              <p className="text-sm text-muted-foreground">
                {!loadError && !isLoading && <>{number(total)} <T text="recorded player results" /></>}</p>
            </div>
          </div>

          <div className="hidden sm:block">{filterControls}</div>
          <div className="sm:hidden"><Button variant="outline" onClick={() => setFiltersOpen(true)}>{t("Filters")}</Button><Sheet open={filtersOpen} onOpenChange={setFiltersOpen}><SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto"><SheetHeader><SheetTitle>{t("Filters")}</SheetTitle><SheetDescription>{t("Choose a mode, battle type or member.")}</SheetDescription></SheetHeader><div className="mt-5">{filterControls}</div><Button className="mt-5 w-full" onClick={() => setFiltersOpen(false)}>{t("Done")}</Button></SheetContent></Sheet></div>
        </div>

        <TimeRangePicker value={selectedRange} onChange={range => { if (range !== selectedRange) { setIsLoading(true); setSelectedRange(range); } }} />
        <p className="text-xs text-muted-foreground"><T text="Battle types use recorded API information. Mega Pig, tournaments and older records may be unclassified when the event is not identified." /></p>
        <DataConfidenceNotice />
        {loadError && <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm"><T text="Could not load the battles." /> <Button variant="ghost" onClick={() => loadMatches(rawOffset && matches.length ? rawOffset : 0, matches.length > 0, true)}><T text="Retry" /></Button></div>}

        {/* Matches */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : loadError && matches.length === 0 ? null : matches.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <Swords className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="font-medium"><T text={filterContext ? "No recorded battles match this battle type and period." : "No battles match this period."} /></p>
              <p className="text-sm mt-1"><T text="Try another period or clear the filters." /></p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {matches.map((match) => (
              <MatchCard
                key={matchKey(match)}
                match={match}
                clubTags={clubTags}
                clockDelta={clockDelta}
                brawlerIconByName={brawlerIconByName}
              />
            ))}

            {rawOffset !== null && rawOffset < total && (
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
                  <T text=" Load More " /></Button>
              </div>
            )}
          </div>
        )}
      </div>
    </LayoutWrapper>
  );
}
