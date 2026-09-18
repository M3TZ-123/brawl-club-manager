"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClubTrendLine } from "@/components/club-trend-line";
import { ClubRankingSummary } from "@/components/club-ranking-summary";
import { formatBrawlName, stripBrawlColorTags } from "@/lib/brawl-text";
import type { ClubRivalsResponse, RivalSnapshot } from "@/lib/club-rivals-data";
import type { ClubIntelligenceResponse } from "@/lib/club-intelligence-types";

type Props = {
  data: ClubRivalsResponse;
  own: ClubIntelligenceResponse | null;
  ownLoading: boolean;
  ownError: boolean;
  onRetryOwn: () => void;
  isAdmin: boolean;
  saving: boolean;
  onUnfollow: (tag: string) => void;
};
const validDate = (value: string | null, now: number) => !!value && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now;

export function ClubRivalsComparison({ data, own, ownLoading, ownError, onRetryOwn, isAdmin, saving, onUnfollow }: Props) {
  const { t, number, dateTime } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<{ club: string; rival: string } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(timer);
  }, [data, own]);
  const current = own?.club.tag === data.clubTag ? own : null;
  const rivals = [...new Map(data.rivals.filter(rival => rival.tag !== data.clubTag).map(rival => [rival.tag, rival])).values()];
  if (expanded && (expanded.club !== data.clubTag || !rivals.some(rival => rival.tag === expanded.rival))) setExpanded(null);
  const visibleDetails = expanded?.club === data.clubTag ? expanded.rival : null;
  const metric = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? <span aria-label={t("Unknown")}>—</span> : number(value);
  const ownName = formatBrawlName(current?.club.metadata?.name, t("Your club"));
  const profile = (rival: RivalSnapshot) => rival.profile?.tag === rival.tag ? rival.profile : null;
  const points = (rival: RivalSnapshot) => rival.history.filter(point => validDate(point.at, now)).map(point => ({ at: point.at, value: Number.isFinite(point.trophies) && point.trophies >= 0 ? point.trophies : null }));
  const rows = [{ tag: data.clubTag, name: ownName, trophies: current?.club.rosterTrophies, count: current?.club.memberCount,
    median: current?.strength.medianTrophies, at: current?.club.observedAt ?? null, rival: null as RivalSnapshot | null },
  ...rivals.map(rival => {
    const saved = profile(rival);
    return { tag: rival.tag, name: formatBrawlName(saved?.name, t("Club")), trophies: saved?.rosterTrophies, count: saved?.memberCount,
      median: saved?.medianTrophies, at: saved ? rival.fetchedAt : null, rival };
  })];

  return <section className="min-w-0 space-y-3">
    <div role="region" aria-label={t("Club roster comparison")} tabIndex={0} className="max-w-full overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[39rem] text-sm">
        <caption className="sr-only">{t("Club roster comparison")}</caption>
        <thead className="bg-muted/40"><tr>{["Club", "Roster trophies", "Members", "Median trophies"].map((label, index) => <th key={label} scope="col" className={`whitespace-nowrap p-3 ${index === 0 ? "text-start" : "text-end"}`}>{t(label)}</th>)}</tr></thead>
        <tbody>{rows.flatMap(row => {
          const rival = row.rival, saved = rival ? profile(rival) : null, open = rival != null && visibleDetails === row.tag;
          const chartPoints = rival ? points(rival) : [];
          const hasTrend = new Set(chartPoints.filter(point => point.value != null).map(point => new Date(point.at).toISOString().slice(0, 10))).size >= 2;
          const detailsId = `rival-details-${encodeURIComponent(row.tag)}`;
          return [<tr key={row.tag} className={`border-t ${rival ? "" : "bg-primary/5"}`} data-current-club={!rival || undefined}>
            <th scope="row" className="p-3 text-start font-normal"><div className="max-w-64 space-y-1.5">
              <p className="break-words font-semibold"><bdi>{row.name}</bdi></p>
              <p className="text-xs text-muted-foreground"><bdi dir="ltr">{row.tag}</bdi></p>
              {!rival && current?.club.metadata?.name && <Badge variant="outline">{t("Your club")}</Badge>}
              {validDate(row.at, now) ? <p className="text-xs text-muted-foreground">{t("Observed")}: <bdi>{dateTime(row.at)}</bdi></p> : (current || rival) && <p className="text-xs text-muted-foreground">{t("Observation time unavailable")}</p>}
              {!rival && !current && <div className="text-xs text-muted-foreground" role="status">
                <p>{t(ownLoading ? "Loading your club comparison…" : "Your club comparison is unavailable.")}</p>
                {!ownLoading && <Button variant="ghost" size="sm" onClick={onRetryOwn}>{t("Retry")}</Button>}
              </div>}
              {!rival && current && ownError && <div className="text-xs text-amber-700 dark:text-amber-400"><p>{t("Showing the last available update")}</p><Button variant="ghost" size="sm" onClick={onRetryOwn}>{t("Retry")}</Button></div>}
              {rival && <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={open ? detailsId : undefined} aria-label={t("Details for {club}", { club: row.name })} onClick={() => setExpanded(open ? null : { club: data.clubTag, rival: row.tag })}>{t(open ? "Hide details" : "Details")}</Button>}
            </div></th>
            <td className="p-3 text-end tabular-nums"><span className="font-medium">{metric(row.trophies)}</span>{rival && (!saved || rival.stale || !validDate(row.at, now)) && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t(saved ? "Stale" : "No saved club data")}</p>}</td>
            <td className="p-3 text-end tabular-nums">{metric(row.count)}</td>
            <td className="p-3 text-end tabular-nums">{metric(row.median)}</td>
          </tr>, open && rival && <tr key={`${row.tag}:details`} id={detailsId} className="border-t bg-muted/10"><td colSpan={4} className="p-4">
            <div className="space-y-4 [max-inline-size:calc(100vw_-_5rem)] sm:[max-inline-size:48rem]">
              <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{saved ? stripBrawlColorTags(saved.description) || t("No club description") : t("Club data not available yet. Check the tag or retry later.")}</p>
              <dl className="text-sm"><div className="flex flex-wrap gap-x-3 gap-y-1"><dt className="text-muted-foreground">{t("Required trophies")}</dt><dd className="font-medium tabular-nums">{metric(saved?.requiredTrophies)}</dd></div></dl>
              {hasTrend ? <><ClubTrendLine points={chartPoints} label={t("Reported club trophies")} /><p className="text-xs text-muted-foreground">{t("Chart: official club score. Table: summed member trophies.")}</p></> : <p className="text-xs text-muted-foreground">{t("Not enough trophy history yet.")}</p>}
              <ClubRankingSummary tag={rival.tag} region={data.region} observations={data.ranks} rankingAt={data.rankingAt} rankingStale={data.rankingStale} title="Recorded rank" />
              {isAdmin && <Button variant="outline" size="sm" disabled={saving} aria-label={t("Stop following {name}", { name: row.name })} onClick={() => { if (!saving) onUnfollow(rival.tag); }}>{t("Stop following club")}</Button>}
            </div>
          </td></tr>];
        })}</tbody>
      </table>
    </div>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">{t("About this comparison")}</summary><div className="mt-2 space-y-2">
      <p>{t("Median trophies shows the middle of the roster, averaging the two middle values when needed.")}</p>
      <p>{t("Roster trophies sum member balances. Snapshots may have different update times.")}</p>
      <p>{t("Club profiles refresh when viewed after six hours.")} {t("Recent daily observations are kept for about 90 days.")}</p>
    </div></details>
  </section>;
}
