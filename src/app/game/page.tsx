"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Globe2, MapPinned, Trophy } from "lucide-react";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { fetchJsonCached } from "@/lib/client-data-cache";
import { getBattleModeInfo } from "@/lib/battle-catalog";
import { BattleModeIcon } from "@/components/battle-mode-icon";
import { GameMapImage, GameMapPicks } from "@/components/game-map-detail";
import { matchEventMap, type MapPickOrder } from "@/lib/map-recommendations";
import type { MapSnapshot, MapTrophyRange } from "@/lib/map-data";
import { formatBrawlName } from "@/lib/brawl-text";
import { gameRegions, type GameEvent, type GameRanking, type GameRegion, type GameRankingKind, type GameSnapshot } from "@/lib/game-data";

const regionNames: Record<GameRegion,string> = { global: "Global", TN: "Tunisia", DZ: "Algeria", MA: "Morocco", FR: "France", EG: "Egypt", SA: "Saudi Arabia", US: "United States" };
export default function GamePage() {
  const { t, number, dateTime } = useI18n();
  const [view, setView] = useState<"maps" | "rankings">("maps");
  const [events, setEvents] = useState<GameSnapshot<GameEvent[]> | null>(null);
  const [rankings, setRankings] = useState<GameSnapshot<GameRanking[]> | null>(null);
  const [region,setRegion] = useState<GameRegion>("global"), [kind,setKind] = useState<GameRankingKind>("clubs");
  const [eventError,setEventError] = useState(""), [rankError,setRankError] = useState("");
  const [rankLoading,setRankLoading] = useState(false);
  const [clock,setClock] = useState<number | null>(null);
  const [maps, setMaps] = useState<MapSnapshot | null>(null);
  const [mapError, setMapError] = useState("");
  const [pickOrder, setPickOrder] = useState<MapPickOrder>("pickRate");
  const [trophyRange, setTrophyRange] = useState<MapTrophyRange>("1000");
  const mapRequests = useRef(0);
  const eventRequests = useRef(0);
  const rankRequests = useRef(0);
  const loadEvents = useCallback((force = false) => {
    const request = ++eventRequests.current;
    return fetchJsonCached<GameSnapshot<GameEvent[]>>("/api/game?kind=events", { staleMs: 60_000, force })
      .then(value => { if (request === eventRequests.current) { setEvents(value); setClock(Date.now()); setEventError(""); } })
      .catch(() => { if (request === eventRequests.current) setEventError("Game data temporarily unavailable"); });
  }, []);
  const loadRankings = useCallback((force = false) => {
    const request = ++rankRequests.current;
    return fetchJsonCached<GameSnapshot<GameRanking[]>>(`/api/game?kind=${kind}&region=${region}`, { staleMs: 300_000, force })
      .then(value => { if (request === rankRequests.current) { setRankings(value); setRankError(""); } })
      .catch(() => { if (request === rankRequests.current) setRankError("Game data temporarily unavailable"); })
      .finally(() => { if (request === rankRequests.current) setRankLoading(false); });
  }, [kind,region]);
  const loadMaps = useCallback((force = false) => {
    const request = ++mapRequests.current;
    return fetchJsonCached<MapSnapshot>(`/api/game-maps?trophies=${trophyRange}`, { staleMs: 600_000, force, timeoutMs: 25_000 })
      .then(value => { if (request === mapRequests.current && value.trophyRange === trophyRange) { setMaps(value); setMapError(""); } })
      .catch(() => { if (request === mapRequests.current) setMapError("Map images and recommendations are temporarily unavailable."); });
  }, [trophyRange]);
  useEffect(() => {
    if (view !== "rankings") return;
    const requests = rankRequests;
    void loadRankings();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void loadRankings(); }, 300_000);
    const visible = () => { if (document.visibilityState === "visible") void loadRankings(); };
    document.addEventListener("visibilitychange", visible);
    return () => { requests.current++; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [loadRankings, view]);
  useEffect(() => {
    if (view !== "maps") return;
    void loadEvents();
    void loadMaps();
    const requests = eventRequests;
    const detailsRequests = mapRequests;
    const tick = () => { if (document.visibilityState === "visible") setClock(Date.now()); };
    const timer = setInterval(tick, 30_000);
    const refresh = () => { if (document.visibilityState === "visible") { tick(); void loadEvents(); void loadMaps(); } };
    const reload = setInterval(refresh,60_000);
    document.addEventListener("visibilitychange",refresh);
    return () => { requests.current++; detailsRequests.current++; clearInterval(timer); clearInterval(reload); document.removeEventListener("visibilitychange",refresh); };
  }, [loadEvents, loadMaps, view]);
  const rows = events?.data || [];
  const matchingScope = maps?.trophyRange === trophyRange;
  return <LayoutWrapper><div className="space-y-8">
    <header><h1 className="text-2xl font-bold flex items-center gap-3"><Globe2 className="text-primary" />{t("Maps and rankings")}</h1></header>
    <div role="group" aria-label={t("Maps and rankings")} className="flex flex-wrap gap-2"><Button variant={view === "maps" ? "default" : "outline"} aria-pressed={view === "maps"} onClick={() => { setClock(Date.now()); setView("maps"); }}>{t("Current maps")}</Button><Button variant={view === "rankings" ? "default" : "outline"} aria-pressed={view === "rankings"} onClick={() => setView("rankings")}>{t("Trophy rankings")}</Button></div>
    <section hidden={view !== "maps"} className="space-y-4" aria-labelledby="rotation-heading">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="rotation-heading" className="text-xl font-semibold flex items-center gap-2"><MapPinned className="w-5" />{t("Current events")}</h2><Button variant="outline" onClick={() => { void loadEvents(true); void loadMaps(true); }}>{t("Refresh")}</Button></div>
      {eventError && <p role="alert" className="text-amber-500">{t(eventError)}</p>}
      {!events && !eventError && <p role="status">{t("Loading...")}</p>}
      {events?.stale && <p className="text-amber-500">{t("Showing the last available update")}</p>}
      {events?.fetchedAt && <p className="text-sm text-muted-foreground">{t("Rotation updated")}: {dateTime(events.fetchedAt)}</p>}
      {mapError && <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">{t(mapError)}</p>}
      {matchingScope && maps?.stale && <p role="status" className="text-sm text-amber-600 dark:text-amber-400">{t("Map recommendations may be out of date.")}</p>}
      {!!rows.length && <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2" role="group" aria-label={t("Brawler recommendations")}><Button size="sm" variant={pickOrder === "winRate" ? "default" : "outline"} aria-pressed={pickOrder === "winRate"} onClick={() => setPickOrder("winRate")}>{t("Highest win rates")}</Button><Button size="sm" variant={pickOrder === "pickRate" ? "default" : "outline"} aria-pressed={pickOrder === "pickRate"} onClick={() => setPickOrder("pickRate")}>{t("Most played")}</Button></div><label className="flex flex-wrap items-center gap-2 text-sm"><span>{t("Brawler trophies")}</span><select value={trophyRange} onChange={e => { setMapError(""); setTrophyRange(e.target.value as MapTrophyRange); }} className="rounded-md border bg-background px-2 py-2"><option value="1000">{t("1,000+ trophies")}</option><option value="600">{t("600+ trophies")}</option><option value="all">{t("All trophy levels")}</option></select></label><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("Data sources")}</summary><div className="mt-2 max-w-md space-y-1"><p>{t("Map rotation: official Brawl Stars API. Map art: Brawlify.")}</p><p>{t("Recommendations use community battle statistics for the same map and mode.")}</p><a href="https://brawlapi.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">BrawlAPI / Brawlify</a></div></details></div>}
      {events?.data && !rows.length && <p>{t("No events reported by the game")}</p>}
      <div className="grid xl:grid-cols-2 gap-5">{rows.map(event => {
        const mode = getBattleModeInfo(event.mode), now = clock ?? Date.parse(events!.fetchedAt!);
        const map = matchEventMap(event, maps?.data ?? []);
        const upcoming = Date.parse(event.startTime) > now, expired = Date.parse(event.endTime) <= now;
        const seconds = Math.max(0, Math.ceil((Date.parse(upcoming ? event.startTime : event.endTime)-now)/1000));
        const hours = Math.floor(seconds/3600), minutes = Math.floor(seconds%3600/60);
        return <article key={`${event.slotId}:${event.startTime}`} className="min-w-0 rounded-xl border bg-card p-4 sm:p-5 space-y-3">
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><BattleModeIcon mode={mode} size={22} />{t(mode.label)}</p><h3 className="font-bold text-lg break-words">{event.map}</h3>
          <p className={expired ? "text-muted-foreground text-sm" : "text-primary text-sm"}>{expired ? t("Event ended") : t(upcoming ? "Starts in {hours}h {minutes}m" : "Ends in {hours}h {minutes}m", {hours,minutes})}</p>
          <div className="grid grid-cols-1 sm:grid-cols-[minmax(100px,0.75fr)_minmax(0,1.5fr)] gap-3 sm:gap-4"><GameMapImage map={map} name={event.map} loading={!maps && !mapError} /><GameMapPicks map={matchingScope ? map : null} order={pickOrder} loading={!matchingScope && !mapError} /></div>
          <Link href={`/analysis?map=${encodeURIComponent(event.map)}&mode=${encodeURIComponent(event.mode)}`} className="text-sm text-primary underline underline-offset-4">{t("Teammates on this map")}</Link>
        </article>;
      })}</div>
      <Link href="/readiness" className="text-primary inline-block underline underline-offset-4">{t("Find club brawlers for these maps")}</Link>
    </section>
    <section hidden={view !== "rankings"} className="space-y-4" aria-labelledby="rankings-heading">
      <div className="flex flex-wrap items-end gap-4"><h2 id="rankings-heading" className="text-xl font-semibold flex items-center gap-2 me-auto"><Trophy className="w-5" />{t("Trophy rankings")}</h2>
        <label className="text-sm space-y-1"><span className="block">{t("Region")}</span><select value={region} onChange={e => {setRankings(null);setRankError("");setRegion(e.target.value as GameRegion);}} className="bg-background border rounded-md p-2">{gameRegions.map(r => <option key={r} value={r}>{t(regionNames[r])}</option>)}</select></label>
        <label className="text-sm space-y-1"><span className="block">{t("Ranking")}</span><select value={kind} onChange={e => {setRankings(null);setRankError("");setKind(e.target.value as GameRankingKind);}} className="bg-background border rounded-md p-2"><option value="players">{t("Players")}</option><option value="clubs">{t("Clubs")}</option></select></label>
      </div>
      <p className="text-sm text-muted-foreground">{t("Top 50")}</p>
      {rankError && <div role="alert" className="flex flex-wrap items-center gap-3 text-amber-500"><p>{t(rankError)}</p><Button variant="outline" disabled={rankLoading} onClick={() => { setRankLoading(true); void loadRankings(true); }}>{t("Retry")}</Button></div>}
      {!rankings && !rankError && <p role="status">{t("Loading...")}</p>}
      {rankings?.stale && <p className="text-amber-500">{t("Showing the last available update")}</p>}
      {rankings?.fetchedAt && <p className="text-sm text-muted-foreground">{t("Updated")}: {dateTime(rankings.fetchedAt)}</p>}
      <div className="rounded-lg border overflow-x-auto"><table className="w-full text-sm text-start"><thead className="bg-muted/40"><tr><th className="p-3 text-start">{t("Rank")}</th><th className="p-3 text-start">{t("Name")}</th><th className="p-3 text-end">{t("Trophies")}</th></tr></thead><tbody>{rankings?.data?.map(row => <tr key={row.tag} className="border-t"><td className="p-3">{number(row.rank)}</td><td className="p-3"><span className="font-medium break-words">{formatBrawlName(row.name, t(kind === "clubs" ? "Club" : "Player"))}</span><div dir="ltr" className="text-xs text-muted-foreground text-start">{row.tag}</div>{row.clubName && <div className="text-xs text-muted-foreground">{formatBrawlName(row.clubName, t("Club"))}</div>}{row.memberCount !== null && <div className="text-xs text-muted-foreground">{t("{count} members",{count:row.memberCount})}</div>}</td><td className="p-3 text-end tabular-nums">{number(row.trophies)}</td></tr>)}</tbody></table></div>
      {rankings?.data?.length === 0 && <p>{t("No rankings available for this region")}</p>}
    </section>
  </div></LayoutWrapper>;
}
