"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useI18n } from "@/components/locale-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AnalysisResponse } from "@/lib/club-analysis-types";
import { selectTeammatePairs, teammateDataKey, teammateDecidedResults, teammatePairKey, teammateWinRate,
  TEAMMATE_COMPARISON_MINIMUM, TEAMMATE_PAGE_SIZE, type TeammateSort } from "@/lib/analysis-teammates";

export function AnalysisTeammates({ data }: { data: AnalysisResponse }) {
  const { t, number } = useI18n();
  const [query, setQuery] = useState("");
  const [minimumMatches, setMinimumMatches] = useState(0);
  const [sort, setSort] = useState<TeammateSort>("matches");
  const [pagination, setPagination] = useState({ key: "", page: 0 });
  const filtered = useMemo(() => selectTeammatePairs(data.pairs, { query, minimumMatches, sort }), [data.pairs, query, minimumMatches, sort]);
  const key = `${teammateDataKey(data)}:${query.trim().toLocaleLowerCase()}:${minimumMatches}:${sort}`;
  // Forget the old page at the boundary, including when a filter is later cleared.
  if (pagination.key !== key) setPagination({ key, page: 0 });
  const pages = Math.max(1, Math.ceil(filtered.length / TEAMMATE_PAGE_SIZE));
  const page = Math.min(pagination.key === key ? pagination.page : 0, pages - 1);
  const visible = filtered.slice(page * TEAMMATE_PAGE_SIZE, (page + 1) * TEAMMATE_PAGE_SIZE);
  const filteredLocally = query.trim().length > 0 || minimumMatches > 0;

  return <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_auto_auto]">
      <label className="block min-w-0 space-y-1 text-sm"><span>{t("Find a teammate")}</span><Input value={query} onChange={event => setQuery(event.target.value)} aria-label={t("Find a teammate")} placeholder={t("Name or player tag")} /></label>
      <label className="block min-w-0 space-y-1 text-sm"><span>{t("Minimum shared matches")}</span><select aria-label={t("Minimum shared matches")} value={minimumMatches} onChange={event => setMinimumMatches(Number(event.target.value))} className="h-10 w-full rounded-md border bg-background px-2">
        <option value={0}>{t("All")}</option><option value={5}>{t("5+ shared matches")}</option><option value={10}>{t("10+ shared matches")}</option>
      </select></label>
      <label className="block min-w-0 space-y-1 text-sm sm:col-span-2 xl:col-span-1"><span>{t("Sort teammates")}</span><select aria-label={t("Sort teammates")} value={sort} onChange={event => setSort(event.target.value as TeammateSort)} className="h-10 w-full rounded-md border bg-background px-2">
        <option value="matches">{t("Most shared matches")}</option><option value="win_rate">{t("Win rate (10+ decided first)")}</option>
      </select></label>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-medium">{t("{count} matching teammate records", { count: number(filtered.length) })}</p>
      {filteredLocally && <Button variant="ghost" size="sm" onClick={() => { setQuery(""); setMinimumMatches(0); }}>{t("Clear teammate filters")}</Button>}
    </div>
    <p className="text-xs text-muted-foreground">{t("One row per teammate pair and battle type. The same pair can appear in several battle types.")}</p>
    {data.limits.groupCounts.pairs > data.pairs.length && <p role="status" className="text-sm text-amber-600 dark:text-amber-400">{t("Loaded {shown} of {total} teammate records. Search and sorting use this subset.", { shown: number(data.pairs.length), total: number(data.limits.groupCounts.pairs) })}</p>}
    {sort === "win_rate" && <p className="text-xs text-muted-foreground">{t("Pairs with 10+ decided results come first. Smaller samples follow by shared matches; unknown rates come last.")} {t("Ten results is a browsing threshold, not proof of stronger teamwork.")}</p>}
    {visible.length === 0 ? <div className="rounded-lg border p-5 text-sm text-muted-foreground">
      <p>{t(data.pairs.length ? "No teammate records match these filters." : "No confirmed teammate pairs in these records.")}</p>
    </div> : <ul className="divide-y rounded-lg border">{visible.map(pair => {
      const winRate = teammateWinRate(pair);
      return <li key={teammatePairKey(pair)} className="grid min-w-0 gap-3 p-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)] md:items-center">
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 items-start gap-3">
            {[pair.player1, pair.player2].map((player, index) => <div key={player.tag} className="flex min-w-0 flex-1 items-start gap-3">
              {index === 1 && <span aria-hidden="true" className="text-muted-foreground">+</span>}
              <Link href={`/members/${encodeURIComponent(player.tag)}`} className="min-w-0 hover:underline"><bdi className="block break-words font-semibold">{player.name || player.tag}</bdi><bdi dir="ltr" className="block break-all text-xs text-muted-foreground">{player.tag}</bdi></Link>
            </div>)}
          </div>
          <Badge variant="outline">{t(pair.context.label)}</Badge>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-muted-foreground">{t("Shared matches")}</dt><dd className="mt-1 font-semibold tabular-nums">{number(pair.matches)}</dd><dd className="mt-1 text-xs text-muted-foreground">{t("{wins} wins · {losses} losses", { wins: number(pair.wins), losses: number(pair.losses) })}</dd>
            {pair.draws > 0 && <dd className="text-xs text-muted-foreground">{t("{count} draws", { count: number(pair.draws) })}</dd>}
            {pair.unknownResults > 0 && <dd className="text-xs text-muted-foreground">{t("{count} unknown results", { count: number(pair.unknownResults) })}</dd>}
          </div>
          <div><dt className="text-xs text-muted-foreground">{t("Win rate")}</dt><dd className="mt-1 font-semibold tabular-nums">{winRate == null ? t("Unknown") : <bdi>{number(Math.round(winRate * 10) / 10)}%</bdi>}</dd>
            {teammateDecidedResults(pair) < TEAMMATE_COMPARISON_MINIMUM && <dd className="mt-1"><Badge variant="outline">{t("Small sample")}</Badge></dd>}
          </div>
        </dl>
      </li>;
    })}</ul>}
    {filtered.length > TEAMMATE_PAGE_SIZE && <nav aria-label={t("Teammate pages")} className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className="text-xs text-muted-foreground">{t("Showing {start}–{end} of {total} teammate records", { start: number(page * TEAMMATE_PAGE_SIZE + 1), end: number(Math.min((page + 1) * TEAMMATE_PAGE_SIZE, filtered.length)), total: number(filtered.length) })}</p>
      <div className="flex gap-2"><Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPagination({ key, page: Math.max(0, page - 1) })}>{t("Previous")}</Button><Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => setPagination({ key, page: Math.min(pages - 1, page + 1) })}>{t("Next")}</Button></div>
    </nav>}
    <details className="rounded-lg border p-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium text-foreground">{t("Reading teammate results")}</summary><div className="mt-2 space-y-2">
      <p>{t("Pairs count only players explicitly recorded on the same team. They do not prove a premade party.")}</p>
      <p>{t("Win rate uses wins and losses only. Small sample means fewer than 10 decided results.")}</p>
      <p>{t("One match can create several teammate records. Adding rows does not give a distinct match total.")}</p>
    </div></details>
  </div>;
}
