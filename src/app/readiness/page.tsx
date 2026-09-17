"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { BrawlImage } from "@/components/brawl-image";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { LocalDate, useI18n } from "@/components/locale-provider";
import { ReportedEquipmentDetails } from "@/components/reported-equipment";
import { useFeatureResource } from "@/components/use-feature-resource";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { fetchJsonCached } from "@/lib/client-data-cache";
import type { ReadinessResponse } from "@/lib/club-analysis-types";

export default function ReadinessPage() {
  const { t, number } = useI18n();
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [brawler, setBrawler] = useState("");
  const [minPower, setMinPower] = useState("");
  const [paging, setPaging] = useState(false);
  const [pageError, setPageError] = useState<ReadinessResponse | null>(null);
  const pagingBusy = useRef(false);
  const params = new URLSearchParams({ limit: "24" });
  if (brawler) params.set("brawler", brawler);
  if (minPower) params.set("minPower", minPower);
  if (appliedSearch) params.set("search", appliedSearch);
  const resource = useFeatureResource<ReadinessResponse>(`/api/readiness?${params}`, "roster");
  const data = resource.data;
  const dataRef = useRef(data);
  dataRef.current = data;
  const unknownNumber = (value: number | null) => value == null ? t("Unknown") : number(value);
  const loadMore = async () => {
    if (!data || data.nextOffset == null || pagingBusy.current) return;
    const original = data;
    pagingBusy.current = true; setPaging(true); setPageError(null);
    const next = new URLSearchParams(params); next.set("offset", String(data.nextOffset));
    try {
      const page = await fetchJsonCached<ReadinessResponse>(`/api/readiness?${next}`);
      if (dataRef.current !== original) return;
      resource.updateData(current => ({ ...page, rows: [...new Map([...current.rows, ...page.rows].map(row => [`${row.player.tag}:${row.brawler.id}`, row])).values()] }));
    } catch { if (dataRef.current === original) setPageError(original); }
    finally { pagingBusy.current = false; setPaging(false); }
  };
  return <LayoutWrapper><div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-bold">{t("Brawler readiness")}</h1><p className="mt-1 text-sm text-muted-foreground">{t("Find club players with the brawlers and power levels you need.")}</p></div><Button variant="outline" onClick={resource.reload} disabled={resource.loading}>{t("Refresh")}</Button></header>
    <section className="space-y-3 rounded-lg border bg-card p-3" aria-label={t("Find brawlers")}>
    <form onSubmit={event => { event.preventDefault(); setAppliedSearch(search.trim()); setPageError(null); }} className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1"><label htmlFor="readiness-search" className="mb-1 block text-sm">{t("Search player or brawler")}</label><Input id="readiness-search" value={search} onChange={event => setSearch(event.target.value)} /></div><Button type="submit" variant="outline">{t("Search")}</Button></form>
    <div className="grid grid-cols-2 gap-3">
      <div className="min-w-0"><label htmlFor="readiness-brawler" className="mb-1 block text-sm">{t("Brawler")}</label><select id="readiness-brawler" value={brawler} onChange={event => { setBrawler(event.target.value); setPageError(null); }} className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm"><option value="">{t("All brawlers")}</option>{brawler && !data?.brawlers.some(item => String(item.id) === brawler) && <option value={brawler}>{t("Selected brawler")}</option>}{data?.brawlers.map(item => <option key={item.id} value={item.id}>{item.name} ({number(item.playersObserved)})</option>)}</select></div>
      <div><label htmlFor="readiness-power" className="mb-1 block text-sm">{t("Minimum power")}</label><select id="readiness-power" value={minPower} onChange={event => { setMinPower(event.target.value); setPageError(null); }} className="h-10 w-full rounded-md border bg-background px-2 text-sm"><option value="">{t("Any reported power")}</option>{[9, 10, 11].map(power => <option key={power} value={power}>{t("Power {level}+", { level: number(power) })}</option>)}</select></div>
    </div>
    {(appliedSearch || brawler || minPower) && <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setAppliedSearch(""); setBrawler(""); setMinPower(""); setPageError(null); }}>{t("Clear filters")}</Button>}
    </section>
    <p className="text-xs text-muted-foreground">{t("Latest saved collection; missing data stays unknown.")}</p>
    {resource.loading && !data && <p role="status" className="py-8 text-center text-muted-foreground">{t("Loading brawler readiness…")}</p>}
    {resource.error && <div role="alert" className="rounded-lg border p-4 text-sm">{t("Brawler readiness could not be loaded.")} <Button variant="outline" size="sm" onClick={resource.reload}>{t("Retry")}</Button></div>}
    {data && <>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm"><p><strong>{number(data.total)}</strong> {t("Results")}</p><p className="text-muted-foreground">{t("{count} current players have saved collection data.", { count: data.members.filter(member => member.brawlersObserved > 0).length })}</p></div>
      {!data.rows.length && <p className="rounded-lg border p-6 text-sm text-muted-foreground">{t("No saved brawlers match these filters. Missing profiles are not assumed unprepared.")}</p>}
      <div className="grid gap-3 lg:grid-cols-2">{data.rows.map(row => <Card key={`${row.player.tag}:${row.brawler.id}`}><CardContent className="space-y-3 p-4">
        <div className="flex min-w-0 items-center gap-3"><BrawlImage src={`https://cdn.brawlify.com/brawlers/borderless/${row.brawler.id}.png`} alt="" width={48} height={48} /><div className="min-w-0 flex-1"><h2 className="break-words font-semibold">{row.brawler.name}</h2><Link className="break-words text-sm text-primary hover:underline" href={`/members/${encodeURIComponent(row.player.tag)}`}>{row.player.name}</Link> <bdi dir="ltr" className="text-xs text-muted-foreground">{row.player.tag}</bdi></div><p className="shrink-0 rounded-md bg-muted px-2 py-1 text-sm">{t("Power {level}", { level: unknownNumber(row.powerLevel) })}</p></div>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm">{t("Trophies")}: <strong>{unknownNumber(row.trophies)}</strong></p><p className="text-xs text-muted-foreground">{t("Last observed")}: <LocalDate value={row.observedAt} time /></p></div>
        <details className="border-t pt-3"><summary className="cursor-pointer text-sm font-medium">{t("Reported equipment and progress")}</summary><div className="mt-3 space-y-4"><dl className="grid grid-cols-2 gap-2 text-xs">{([["Official highest trophies", row.highestTrophies], ["Prestige", row.prestigeLevel], ["Current win streak", row.currentWinStreak], ["Best win streak", row.maxWinStreak]] as const).map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{t(label)}</dt><dd className="mt-1">{unknownNumber(value)}</dd></div>)}</dl><ReportedEquipmentDetails {...row} /></div></details>
      </CardContent></Card>)}</div>
      {pageError === data && <p role="alert" className="text-sm text-destructive">{t("More readiness results could not be loaded. Try again.")}</p>}
      {data.nextOffset != null && <Button variant="outline" onClick={loadMore} disabled={paging}>{paging ? t("Loading…") : t("Load more results")}</Button>}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">{t("About collection data")}</summary><p className="mt-2">{t("Latest saved profiles, not a historical period. Power and equipment are facts, not a readiness score.")}</p></details>
    </>}
  </div></LayoutWrapper>;
}
