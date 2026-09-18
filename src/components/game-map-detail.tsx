"use client";

import { useState } from "react";
import Image from "next/image";
import { ExternalLink, Map, Maximize2 } from "lucide-react";
import { BrawlImage } from "@/components/brawl-image";
import { useI18n } from "@/components/locale-provider";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { MapEnrichment } from "@/lib/map-data";
import { getBrawlerPortraitUrl } from "@/lib/brawl-assets";
import { MIN_MAP_PICK_SAMPLE, MIN_MAP_WIN_SAMPLE, rankMapPicks, type MapPickOrder } from "@/lib/map-recommendations";

export function GameMapImage({ map, name, loading }: { map: MapEnrichment | null; name: string; loading: boolean }) {
  const { t, direction } = useI18n();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const src = map?.imageUrl;
  if (!src || failed === src) return <div className={`flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg bg-muted/40 p-3 text-center text-xs text-muted-foreground ${loading ? "animate-pulse" : ""}`}>
    <Map aria-hidden="true" className="size-7" /><span>{t(loading ? "Loading map image..." : "Map image unavailable")}</span>
  </div>;
  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger asChild><button type="button" className="group relative flex min-h-40 w-full items-center justify-center overflow-hidden rounded-lg border bg-black/30 focus-visible:outline-2 focus-visible:outline-primary" aria-label={t("Enlarge {map}", { map: name })}>
      <Image src={src} alt={t("Map layout: {map}", { map: name })} width={240} height={320} sizes="(max-width: 640px) 35vw, 180px" className="h-48 w-full object-contain p-2 transition-transform group-hover:scale-105" onError={() => setFailed(src)} />
      <Maximize2 aria-hidden="true" className="absolute bottom-2 end-2 size-6 rounded bg-background/90 p-1" />
    </button></SheetTrigger>
    <SheetContent side={direction === "rtl" ? "left" : "right"} className="w-full overflow-y-auto sm:max-w-xl">
      <SheetHeader><SheetTitle>{name}</SheetTitle><SheetDescription>{t("Map layout")}</SheetDescription></SheetHeader>
      {open && <Image src={src} alt={t("Map layout: {map}", { map: name })} width={720} height={960} sizes="(max-width: 640px) 90vw, 520px" className="mx-auto mt-4 h-auto max-h-[78dvh] w-auto max-w-full object-contain" onError={() => setFailed(src)} />}
      {map?.sourceUrl && <a className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline" href={map.sourceUrl} target="_blank" rel="noopener noreferrer">Brawlify <ExternalLink aria-hidden="true" className="size-3" /></a>}
    </SheetContent>
  </Sheet>;
}

export function GameMapPicks({ map, order, loading }: { map: MapEnrichment | null; order: MapPickOrder; loading: boolean }) {
  const { t, number, dateTime, date } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const ranked = rankMapPicks(map?.brawlers ?? [], order);
  const rows = expanded ? ranked.slice(0, 10) : ranked.slice(0, 3);
  const winLabel = map?.winRateKind === "first_place" ? "1st place" : "win";
  const percent = (value: number | null) => value === null ? "—" : `${number(Math.round(value * 10) / 10)}%`;
  return <div className="min-w-0 space-y-3">
    <h4 className="text-sm font-semibold">{t(order === "pickRate" ? "Most played brawlers" : map?.winRateKind === "first_place" ? "Highest first-place rates" : "Highest win rates")}</h4>
    {map?.statsStatus === "stale" && <p className="text-xs text-amber-600 dark:text-amber-400">{t("Saved stats · update delayed")}</p>}
    {!rows.length ? <p role={loading ? "status" : undefined} className="text-sm text-muted-foreground">{t(loading ? "Loading map picks..." : map?.brawlers.length ? order === "winRate" && map.winRateKind === null ? "Win rates unavailable. Choose Most played." : "Not enough recorded results yet." : "No recent stats for this map and mode.")}</p> : <>
      <ol className="space-y-2">{rows.map((row, index) => {
        const portrait = getBrawlerPortraitUrl(row.id, "borders") ?? row.imageUrl;
        return <li key={row.id ?? row.name} className="flex min-w-0 items-center gap-2 rounded-md bg-muted/35 p-2">
        <span className="w-3 shrink-0 text-xs tabular-nums text-muted-foreground">{number(index + 1)}</span>
        {portrait && <BrawlImage src={portrait} alt="" width={36} height={36} className="size-9 shrink-0 object-contain" />}
        <div className="min-w-0 flex-1"><p className="break-words text-sm font-semibold">{row.name}</p><p className="text-[11px] text-muted-foreground">{t("{count} results", { count: number(row.sampleSize!) })}</p></div>
        <div className="shrink-0 text-end"><p className="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{percent(row[order])} <span className="text-[10px] font-normal">{t(order === "winRate" ? winLabel : "use")}</span></p>{(order === "winRate" || row.winRate !== null) && <p className="text-[11px] text-muted-foreground">{percent(order === "winRate" ? row.pickRate : row.winRate)} {t(order === "winRate" ? "use" : winLabel)}</p>}</div>
      </li>; })}</ol>
      {ranked.length > 3 && <button type="button" className="text-xs font-medium text-primary hover:underline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? "Show fewer brawlers" : "More brawlers")}</button>}
    </>}
    {map?.statsSource && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("Stats details")}</summary><div className="mt-2 space-y-2">
      <a className="inline-flex items-center gap-1 text-primary hover:underline" href={map.statsSource.url} target="_blank" rel="noopener noreferrer">{map.statsSource.name}<ExternalLink aria-hidden="true" className="size-3" /></a>
      {map.statsPeriod && <p>{t("Source period")}: {date(map.statsPeriod.start)} – {date(map.statsPeriod.end)}</p>}
      {map.sampleSize !== null && <p>{t("{count} recorded player results", { count: number(map.sampleSize) })}</p>}
      <p>{t("Based on Ninja visitors' recorded battles.")}</p>
      <p>{t("The source groups by map name and mode; map revisions may be combined.")}</p>
      {map.winRateKind === "first_place" ? <p>{t("First-place finishes, not the source's placement score.")}</p> : map.winRateKind === "victory" && <p>{t("The source win rate gives partial credit for draws.")}</p>}
      <p>{t("At least {count} results per brawler. These are observed rates, not a guarantee of winning.", { count: number(order === "winRate" ? MIN_MAP_WIN_SAMPLE : MIN_MAP_PICK_SAMPLE) })}</p>
      {map.statsUpdatedAt && <p>{t("Stats updated")}: {dateTime(map.statsUpdatedAt)}</p>}
      {map.statsFetchedAt && <p>{t("Stats checked")}: {dateTime(map.statsFetchedAt)}</p>}
    </div></details>}
  </div>;
}
