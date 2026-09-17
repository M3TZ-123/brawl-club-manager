"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/locale-provider";
import { rankingTimestamp, summarizeClubRanking } from "@/lib/club-ranking";
import type { ClubRankObservation } from "@/lib/club-rivals-data";
import type { GameRegion } from "@/lib/game-data";

export type ClubRankingSummaryProps = {
  tag: string;
  region: GameRegion;
  observations: ClubRankObservation[];
  rankingAt: string | null;
  rankingStale: boolean;
  title?: string;
};

export function ClubRankingSummary({ tag, region, observations, rankingAt, rankingStale, title = "Your club's ranking" }: ClubRankingSummaryProps) {
  const { t, number, date, dateTime } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Recheck the clock after receiving new data. A mounted summary must not
    // reject later genuine observations against its original mount time.
    const timer = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(timer);
  }, [tag, region, observations, rankingAt]);
  const { history, latest, previous, placesGained, hasChart } = summarizeClubRanking(tag, region, observations, now);
  const sourceAt = rankingTimestamp(rankingAt, now);
  const known = history.filter(row => row.state === "ranked");
  const best = known.length ? Math.min(...known.map(row => row.rank!)) : 1;
  const worst = known.length ? Math.max(...known.map(row => row.rank!)) : 50;
  const start = history.length ? Date.parse(history[0].at) : 0;
  const end = history.length ? Date.parse(history[history.length - 1].at) : 0;
  const points = history.map(row => ({ ...row,
    x: 12 + 376 * (Date.parse(row.at) - start) / (end - start || 1),
    y: row.rank === null ? null : best === worst ? 50 : 12 + 76 * (row.rank - best) / (worst - best),
  }));
  const segments: string[] = [];
  let segment: string[] = [];
  for (const point of points) {
    if (point.y === null) { if (segment.length) segments.push(segment.join(" ")); segment = []; }
    else segment.push(`${point.x},${point.y}`);
  }
  if (segment.length) segments.push(segment.join(" "));
  const movementLabel = placesGained === 1 ? "Up 1 place" : placesGained === -1 ? "Down 1 place"
    : placesGained !== null && placesGained > 0 ? "Up {count} places" : placesGained !== null && placesGained < 0 ? "Down {count} places" : "Rank unchanged";

  return <section className="min-w-0 space-y-2" aria-label={t(title)}>
    <h3 className="font-semibold">{t(title)}</h3>
    {!latest ? <p className="text-sm text-muted-foreground">{t("No ranking recorded for this club in this region yet.")}</p> : <>
      <p className="text-sm">{latest.state === "ranked" ? <><span className="text-muted-foreground">{t("Latest recorded rank")}: </span><strong className="text-lg tabular-nums"><bdi>#{number(latest.rank!)}</bdi></strong></> : t(latest.state === "outside_top50" ? "Not listed in the recorded top 50" : "An exact rank could not be established for this observation.")}</p>
      <p className="text-xs text-muted-foreground">{t("Rank observed")}: <time dateTime={latest.at}>{dateTime(latest.at)}</time></p>
      {placesGained !== null && previous && <div className="text-sm">
        <p className={placesGained > 0 ? "text-emerald-700 dark:text-emerald-400" : placesGained < 0 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>{t(movementLabel, { count: Math.abs(placesGained) })}</p>
        <p className="text-xs text-muted-foreground">{t("Compared with the previous recorded observation")}: <time dateTime={previous.at}>{dateTime(previous.at)}</time></p>
      </div>}
      {latest.state === "ranked" && previous && placesGained === null && <p className="text-xs text-muted-foreground">{t("The previous recorded observation has no exact rank to compare.")}</p>}
    </>}
    {!latest && sourceAt && <p className="text-xs text-muted-foreground">{t("Ranking list last checked")}: <time dateTime={sourceAt}>{dateTime(sourceAt)}</time></p>}
    {rankingStale && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{t("Ranking data may be out of date.")}</p>}
    <p className="text-xs text-muted-foreground">{t("Only the recorded top 50 is available; a missing entry does not give an exact rank.")}</p>
    {hasChart && <details className="text-sm">
      <summary className="cursor-pointer font-medium text-primary">{t("Recorded ranking history")}</summary>
      <figure className="mt-3 space-y-2">
        <figcaption className="text-xs text-muted-foreground">{t("Recorded ranks: {best}–{worst}. Lower is better.", { best, worst })}</figcaption>
        <svg viewBox="0 0 400 100" role="img" aria-label={t("Recorded ranking history")} className="h-28 w-full text-primary">
          <path d="M12 90H388" stroke="currentColor" opacity="0.2" />
          {segments.map((line, index) => <polyline key={index} points={line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
          {points.filter(point => point.y !== null).map(point => <circle key={point.day} cx={point.x} cy={point.y!} r="3" fill="currentColor"><title>{t("Rank {rank} observed {date}", { rank: point.rank!, date: dateTime(point.at) })}</title></circle>)}
        </svg>
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{date(history[0].at)}</span><span>{date(history[history.length - 1].at)}</span></div>
        <p className="text-xs text-muted-foreground">{t("Last observation per recorded UTC day. Lines break where an observation has no exact rank.")}</p>
      </figure>
    </details>}
  </section>;
}
