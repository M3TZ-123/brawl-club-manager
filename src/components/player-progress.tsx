"use client";

import { useRef, useState } from "react";
import { BrawlImage } from "@/components/brawl-image";
import { LocalDate, useI18n } from "@/components/locale-provider";
import { EquipmentList, ReportedEquipmentDetails } from "@/components/reported-equipment";
import { useFeatureResource } from "@/components/use-feature-resource";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { fetchJsonCached } from "@/lib/client-data-cache";
import type { PlayerProgressResponse } from "@/lib/player-progress";
import { TIME_RANGES, type TimeRangeKey } from "@/lib/time-range";

type Brawler = PlayerProgressResponse["collection"]["items"][number];
type RankObservation = PlayerProgressResponse["rankedHistory"]["items"][number];

export function rankHistorySeasons(items: RankObservation[]) {
  const groups = new Map<number | null, RankObservation[]>();
  for (const item of items) groups.set(item.seasonId, [...(groups.get(item.seasonId) || []), item]);
  return [...groups.entries()];
}

export function PlayerProgress({ playerTag, range }: { playerTag: string; range: TimeRangeKey }) {
  const { t, number, direction } = useI18n();
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [rankedOpen, setRankedOpen] = useState(false);
  const [selectedChoice, setSelected] = useState<Brawler | null>(null);
  const [paging, setPaging] = useState<"collection" | "ranked" | null>(null);
  const [pageError, setPageError] = useState<"collection" | "ranked" | null>(null);
  const pagingRequest = useRef(0);
  const pagingBusy = useRef(false);
  const params = new URLSearchParams({ range, collectionLimit: "24", rankLimit: "50" });
  if (appliedSearch) params.set("collectionSearch", appliedSearch);
  const endpoint = `/api/members/${encodeURIComponent(playerTag)}/progress`;
  const url = `${endpoint}?${params}`;
  const resource = useFeatureResource<PlayerProgressResponse>(url, "roster,ranked");
  const dataRef = useRef(resource.data);
  dataRef.current = resource.data;
  const historyParams = new URLSearchParams({ range, collectionLimit: "1", rankLimit: "1" });
  if (selectedChoice) { historyParams.set("brawlerId", String(selectedChoice.id)); historyParams.set("collectionSearch", String(selectedChoice.id)); }
  const history = useFeatureResource<PlayerProgressResponse>(selectedChoice ? `${endpoint}?${historyParams}` : null, "roster");
  const data = resource.data;
  const selected = [
    history.data?.collection.items.find(item => item.id === selectedChoice?.id),
    data?.collection.items.find(item => item.id === selectedChoice?.id),
    selectedChoice,
  ].reduce<Brawler | null>((latest, item) => {
    if (!item) return latest;
    return !latest || (Date.parse(item.lastCheckedAt) || 0) > (Date.parse(latest.lastCheckedAt) || 0) ? item : latest;
  }, null);
  const unknownNumber = (value: number | null | undefined) => value == null ? t("Unknown") : number(value);
  const more = async (section: "collection" | "ranked") => {
    if (!data || pagingBusy.current) return;
    const cursor = section === "collection" ? data.collection.nextCursor : data.rankedHistory.nextCursor;
    if (cursor == null) return;
    const original = data;
    const request = ++pagingRequest.current;
    pagingBusy.current = true;
    setPaging(section); setPageError(null);
    const next = new URLSearchParams(params);
    if (section === "collection") { next.set("collectionCursor", String(cursor)); next.set("rankLimit", "1"); }
    else { next.set("rankCursor", String(cursor)); next.set("collectionLimit", "1"); }
    try {
      const page = await fetchJsonCached<PlayerProgressResponse>(`${endpoint}?${next}`);
      if (request !== pagingRequest.current || dataRef.current !== original) return;
      resource.updateData(current => section === "collection" ? {
        ...current, collection: { ...page.collection, items: [...new Map([...current.collection.items, ...page.collection.items].map(item => [item.id, item])).values()] },
      } : {
        ...current, rankedHistory: { ...page.rankedHistory, items: [...new Map([...current.rankedHistory.items, ...page.rankedHistory.items].map(item => [item.id, item])).values()] },
      });
    } catch { if (dataRef.current === original) setPageError(section); }
    finally { if (request === pagingRequest.current) { pagingBusy.current = false; setPaging(null); } }
  };

  return <section aria-label={t("Player progress and collection")} className="space-y-4">
    <div><h2 className="text-xl font-semibold">{t("Player progress and collection")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("Current profile details and changes recorded by this club tracker.")}</p></div>
    {resource.error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">{t("Player progress could not be loaded.")} <Button variant="outline" size="sm" onClick={resource.reload}>{t("Retry")}</Button></div>}
    {resource.loading && !data && <p role="status" className="text-sm text-muted-foreground">{t("Loading player progress…")}</p>}
    {data && <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {([
          ["Official highest trophies", data.profile.highestTrophies, "highestTrophies"],
          ["Prestige", data.profile.totalPrestigeLevel, "totalPrestigeLevel"],
          ["Fame", data.profile.fame, "fame"],
          ["Experience points", data.profile.expPoints, "expPoints"],
        ] as const).map(([label, value, field]) => <Card key={field}><CardContent className="p-3 sm:p-4"><p className="text-xs text-muted-foreground">{t(label)}</p><p className="mt-1 break-words text-xl font-bold">{unknownNumber(value)}</p>{field === "fame" && data.profile.fameTierName && <p className="text-xs">{data.profile.fameTierName}</p>}{data.profile.fieldCheckedAt[field] && <p className="mt-1 text-xs text-muted-foreground"><LocalDate value={data.profile.fieldCheckedAt[field]} time /></p>}</CardContent></Card>)}
      </div>
      <p className="text-xs text-muted-foreground">{t("Profile checked")}: <LocalDate value={data.profile.lastCheckedAt} time /> · {t("Missing fields remain unknown until reported.")}</p>

      <details open={collectionOpen} onToggle={event => setCollectionOpen(event.currentTarget.open)} className="rounded-xl border bg-card">
        <summary className="cursor-pointer p-4 font-semibold">{t("Brawler collection")} <span className="text-sm font-normal text-muted-foreground">· {number(data.collection.total)} {t("matching brawlers")}</span></summary>
        <div className="space-y-4 border-t p-4">
          <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); setAppliedSearch(search.trim()); setSelected(null); setPageError(null); }}>
            <div className="min-w-0 flex-1"><label htmlFor="collection-search" className="mb-1 block text-sm">{t("Search brawler name or ID")}</label><Input id="collection-search" value={search} maxLength={80} onChange={event => setSearch(event.target.value)} /></div>
            <Button type="submit" variant="outline">{t("Search")}</Button>
          </form>
          <p className="text-xs text-muted-foreground">{t("Current collection. Choose a brawler for equipment and recorded daily progress.")}</p>
          <p className="text-xs text-muted-foreground">{t("Profile checked")}: <LocalDate value={data.collection.lastCheckedAt} time /></p>
          {!data.collection.items.length && <p className="py-4 text-sm text-muted-foreground">{t("No brawlers match this search.")}</p>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {data.collection.items.map(brawler => <button key={brawler.id} type="button" onClick={() => setSelected(brawler)} className="flex min-w-0 flex-col items-center gap-2 rounded-lg border p-3 text-center hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
              <BrawlImage src={`https://cdn.brawlify.com/brawlers/borderless/${brawler.id}.png`} alt="" width={48} height={48} />
              <span className="max-w-full break-words text-sm font-semibold">{brawler.name}</span>
              <span className="text-xs text-muted-foreground">{t("Power {level}", { level: unknownNumber(brawler.power) })} · {number(brawler.trophies)} 🏆</span>
            </button>)}
          </div>
          {pageError === "collection" && <p role="alert" className="text-sm text-destructive">{t("More brawlers could not be loaded. Try again.")}</p>}
          {data.collection.nextCursor != null && <Button variant="outline" disabled={!!paging} onClick={() => more("collection")}>{paging === "collection" ? t("Loading…") : t("Load more brawlers")}</Button>}
        </div>
      </details>

      <details open={rankedOpen} onToggle={event => setRankedOpen(event.currentTarget.open)} className="rounded-xl border bg-card">
        <summary className="cursor-pointer p-4 font-semibold">{t("Ranked progress history")}</summary>
        <div className="space-y-4 border-t p-4">
          <p className="text-sm text-muted-foreground">{t("Initial observations, rank changes and season resets only. Earlier progress cannot be reconstructed.")}</p>
          {data.rankedHistory.retention && <p className="text-xs text-muted-foreground">{t("Rank changes are kept in detail for {days} days; older history shows the last observation per UTC day and season.", { days: data.rankedHistory.retention.detailedDays })}</p>}
          <p className="text-xs text-muted-foreground">{t(range === "24h" ? "Today (UTC)" : TIME_RANGES[range].label)} · {t("Recorded coverage")}: <LocalDate value={data.rankedHistory.coverageStart} time /> — <LocalDate value={data.rankedHistory.coverageEnd} time /></p>
          {!data.rankedHistory.items.length && <p className="text-sm text-muted-foreground">{t("No ranked changes recorded in this period. This does not mean the player did not play.")}</p>}
          {rankHistorySeasons(data.rankedHistory.items).map(([season, items]) => <section key={season ?? "unknown"} className="space-y-2">
            <h3 className="text-sm font-semibold">{season == null ? t("Unknown season") : t("Season {season}", { season: number(season) })}</h3>
            <ol className="space-y-2">{items.map(item => <li key={item.id} className="rounded-lg bg-muted/40 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{t(item.kind === "initial" ? "First ranked observation" : item.kind === "season_reset" ? "Season reset observed" : "Ranked change observed")}</span><span className="text-xs text-muted-foreground"><LocalDate value={item.observedAt} time /></span></div>
              <p className="mt-1">{item.currentRank ? t(item.currentRank) : t("Unknown")} · {t("Ranked points")}: {unknownNumber(item.points)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("Season best")}: {item.seasonBest ? t(item.seasonBest) : t("Unknown")} ({unknownNumber(item.seasonBestPoints)}) · {t("All-time best")}: {item.allTimeBest ? t(item.allTimeBest) : t("Unknown")} ({unknownNumber(item.allTimeBestPoints)})</p>
            </li>)}</ol>
          </section>)}
          {pageError === "ranked" && <p role="alert" className="text-sm text-destructive">{t("More ranked history could not be loaded. Try again.")}</p>}
          {data.rankedHistory.nextCursor && <Button variant="outline" disabled={!!paging} onClick={() => more("ranked")}>{paging === "ranked" ? t("Loading…") : t("Load more ranked history")}</Button>}
        </div>
      </details>
    </>}
    <Sheet open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}>
      <SheetContent side={direction === "rtl" ? "left" : "right"} className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader><SheetTitle>{selected?.name || t("Brawler collection")}</SheetTitle><SheetDescription>{t("Reported profile details and observed daily snapshots.")}</SheetDescription></SheetHeader>
        {selected && <div className="space-y-5 p-4">
          <bdi dir="ltr" className="text-xs text-muted-foreground">#{selected.id}</bdi>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {([["Power", selected.power], ["Trophies", selected.trophies], ["Official highest trophies", selected.highestTrophies], ["Brawler rank", selected.rank], ["Prestige", selected.prestigeLevel], ["Current win streak", selected.currentWinStreak], ["Best win streak", selected.maxWinStreak]] as const).map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{t(label)}</dt><dd className="font-semibold">{unknownNumber(value)}</dd></div>)}
          </dl>
          <p className="text-xs text-muted-foreground">{t("Last observed")}: <LocalDate value={selected.lastCheckedAt} time /></p>
          <EquipmentList label="Reported skin" items={selected.skin ? [selected.skin] : null} checkedAt={selected.fieldCheckedAt.skin} />
          <ReportedEquipmentDetails {...selected} />
          <section className="space-y-3 border-t pt-4"><h3 className="font-semibold">{t("Daily brawler history")}</h3><p className="text-xs text-muted-foreground">{t("Daily snapshots use UTC dates. Missing dates are not filled in.")}</p>
            {history.loading && !history.data && <p role="status" className="text-sm">{t("Loading history…")}</p>}
            {history.error && <div role="alert" className="text-sm">{t("Brawler history could not be loaded.")} <Button variant="outline" size="sm" onClick={history.reload}>{t("Retry")}</Button></div>}
            {history.data && <>
              <p className="text-xs text-muted-foreground">{t("Recorded coverage")}: <LocalDate value={history.data.brawlerHistory.coverageStart} utc /> — <LocalDate value={history.data.brawlerHistory.coverageEnd} utc /></p>
              {!history.data.brawlerHistory.items.length ? <p className="text-sm text-muted-foreground">{t("No daily snapshots recorded for this brawler in this period.")}</p> : <div className="max-h-80 overflow-auto rounded-lg border"><table className="w-full text-start text-xs"><caption className="sr-only">{t("Daily brawler history")}</caption><thead className="sticky top-0 bg-card"><tr>{["Date (UTC)", "Trophies", "Power", "Brawler rank"].map(label => <th key={label} className="p-2 text-start">{t(label)}</th>)}</tr></thead><tbody>{history.data.brawlerHistory.items.map(row => <tr key={row.recordedAt} className="border-t"><td className="whitespace-nowrap p-2"><LocalDate value={row.recordedAt} utc /></td><td className="p-2">{number(row.trophies)}</td><td className="p-2">{number(row.power)}</td><td className="p-2">{unknownNumber(row.rank)}</td></tr>)}</tbody></table></div>}
            </>}
          </section>
        </div>}
      </SheetContent>
    </Sheet>
  </section>;
}
