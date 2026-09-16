"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Globe2, MapPinned, Trophy } from "lucide-react";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { fetchJsonCached } from "@/lib/client-data-cache";
import { getBattleModeInfo } from "@/lib/battle-catalog";
import { gameRegions, type GameEvent, type GameRanking, type GameRegion, type GameRankingKind, type GameSnapshot } from "@/lib/game-data";

const regionNames: Record<GameRegion,string> = { global: "Global", TN: "Tunisia", DZ: "Algeria", MA: "Morocco", FR: "France", EG: "Egypt", SA: "Saudi Arabia", US: "United States" };
export default function GamePage() {
  const { t, number, dateTime } = useI18n();
  const [events, setEvents] = useState<GameSnapshot<GameEvent[]> | null>(null);
  const [rankings, setRankings] = useState<GameSnapshot<GameRanking[]> | null>(null);
  const [region,setRegion] = useState<GameRegion>("global"), [kind,setKind] = useState<GameRankingKind>("players");
  const [eventError,setEventError] = useState(""), [rankError,setRankError] = useState("");
  const [clock,setClock] = useState<number | null>(null);
  const eventRequests = useRef(0);
  const loadEvents = useCallback((force = false) => {
    const request = ++eventRequests.current;
    return fetchJsonCached<GameSnapshot<GameEvent[]>>("/api/game?kind=events", { staleMs: 60_000, force })
      .then(value => { if (request === eventRequests.current) { setEvents(value); setClock(Date.now()); setEventError(""); } })
      .catch(() => { if (request === eventRequests.current) setEventError("Game data temporarily unavailable"); });
  }, []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try { const value = await fetchJsonCached<GameSnapshot<GameRanking[]>>(`/api/game?kind=${kind}&region=${region}`, { staleMs: 300_000 }); if (active) { setRankings(value); setRankError(""); } }
      catch { if (active) setRankError("Game data temporarily unavailable"); }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 300_000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [region,kind]);
  useEffect(() => {
    void loadEvents();
    const requests = eventRequests;
    const tick = () => { if (document.visibilityState === "visible") setClock(Date.now()); };
    const timer = setInterval(tick, 30_000);
    const refresh = () => { if (document.visibilityState === "visible") { tick(); void loadEvents(); } };
    const reload = setInterval(refresh,60_000);
    document.addEventListener("visibilitychange",refresh);
    return () => { requests.current++; clearInterval(timer); clearInterval(reload); document.removeEventListener("visibilitychange",refresh); };
  }, [loadEvents]);
  const rows = events?.data || [];
  return <LayoutWrapper><div className="space-y-8">
    <header><h1 className="text-3xl font-bold flex items-center gap-3"><Globe2 className="text-primary" />{t("Game")}</h1><p className="text-muted-foreground mt-2">{t("Official map rotation and trophy rankings")}</p></header>
    <section className="space-y-4" aria-labelledby="rotation-heading">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="rotation-heading" className="text-xl font-semibold flex items-center gap-2"><MapPinned className="w-5" />{t("Current events")}</h2><Button variant="outline" onClick={() => void loadEvents(true)}>{t("Refresh")}</Button></div>
      {eventError && <p role="alert" className="text-amber-500">{t(eventError)}</p>}
      {!events && !eventError && <p role="status">{t("Loading...")}</p>}
      {events?.stale && <p className="text-amber-500">{t("Showing the last available update")}</p>}
      {events?.fetchedAt && <p className="text-sm text-muted-foreground">{t("Updated")}: {dateTime(events.fetchedAt)}</p>}
      {events?.data && !rows.length && <p>{t("No events reported by the game")}</p>}
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">{rows.map(event => {
        const mode = getBattleModeInfo(event.mode), now = clock ?? Date.parse(events!.fetchedAt!);
        const upcoming = Date.parse(event.startTime) > now, expired = Date.parse(event.endTime) <= now;
        const seconds = Math.max(0, Math.ceil((Date.parse(upcoming ? event.startTime : event.endTime)-now)/1000));
        const hours = Math.floor(seconds/3600), minutes = Math.floor(seconds%3600/60);
        return <article key={`${event.slotId}:${event.startTime}`} className="rounded-lg border bg-card p-5 space-y-3">
          <p className="text-sm text-muted-foreground">{mode.icon} {t(mode.label)}</p><h3 className="font-bold text-lg break-words">{event.map}</h3>
          <p className={expired ? "text-muted-foreground text-sm" : "text-primary text-sm"}>{expired ? t("Event ended") : t(upcoming ? "Starts in {hours}h {minutes}m" : "Ends in {hours}h {minutes}m", {hours,minutes})}</p>
          <p className="text-xs text-muted-foreground">{t("Ends")}: {dateTime(event.endTime)}</p>
          <Link href={`/analysis?map=${encodeURIComponent(event.map)}&mode=${encodeURIComponent(event.mode)}`} className="text-sm text-primary underline underline-offset-4">{t("Club results on this map")}</Link>
        </article>;
      })}</div>
      <Link href="/readiness" className="text-primary inline-block underline underline-offset-4">{t("Find club brawlers for these maps")}</Link>
    </section>
    <section className="space-y-4" aria-labelledby="rankings-heading">
      <div className="flex flex-wrap items-end gap-4"><h2 id="rankings-heading" className="text-xl font-semibold flex items-center gap-2 me-auto"><Trophy className="w-5" />{t("Trophy rankings")}</h2>
        <label className="text-sm space-y-1"><span className="block">{t("Region")}</span><select value={region} onChange={e => {setRankings(null);setRankError("");setRegion(e.target.value as GameRegion);}} className="bg-background border rounded-md p-2">{gameRegions.map(r => <option key={r} value={r}>{t(regionNames[r])}</option>)}</select></label>
        <label className="text-sm space-y-1"><span className="block">{t("Ranking")}</span><select value={kind} onChange={e => {setRankings(null);setRankError("");setKind(e.target.value as GameRankingKind);}} className="bg-background border rounded-md p-2"><option value="players">{t("Players")}</option><option value="clubs">{t("Clubs")}</option></select></label>
      </div>
      <p className="text-sm text-muted-foreground">{t("Top 50 · shared hourly update")}</p>
      {rankError && <p role="alert" className="text-amber-500">{t(rankError)}</p>}
      {!rankings && !rankError && <p role="status">{t("Loading...")}</p>}
      {rankings?.stale && <p className="text-amber-500">{t("Showing the last available update")}</p>}
      {rankings?.fetchedAt && <p className="text-sm text-muted-foreground">{t("Updated")}: {dateTime(rankings.fetchedAt)}</p>}
      <div className="rounded-lg border overflow-x-auto"><table className="w-full text-sm text-start"><thead className="bg-muted/40"><tr><th className="p-3 text-start">{t("Rank")}</th><th className="p-3 text-start">{t("Name")}</th><th className="p-3 text-end">{t("Trophies")}</th></tr></thead><tbody>{rankings?.data?.map(row => <tr key={row.tag} className="border-t"><td className="p-3">{number(row.rank)}</td><td className="p-3"><span className="font-medium break-words">{row.name}</span><div dir="ltr" className="text-xs text-muted-foreground text-start">{row.tag}</div>{row.clubName && <div className="text-xs text-muted-foreground">{row.clubName}</div>}{row.memberCount !== null && <div className="text-xs text-muted-foreground">{t("{count} members",{count:row.memberCount})}</div>}</td><td className="p-3 text-end tabular-nums">{number(row.trophies)}</td></tr>)}</tbody></table></div>
      {rankings?.data?.length === 0 && <p>{t("No rankings available for this region")}</p>}
    </section>
  </div></LayoutWrapper>;
}
