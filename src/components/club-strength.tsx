"use client";
import { useI18n } from "@/components/locale-provider";
import { ClubIntelligencePanel, useClubIntelligence } from "@/components/club-intelligence-panel";

export function ClubStrength() {
  const resource = useClubIntelligence(), data = resource.data?.strength;
  const { t, number, dateTime } = useI18n();
  return <ClubIntelligencePanel title="Roster strength" resource={resource}>{data && <>
    <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-muted-foreground">{t("Median trophies")}</dt><dd className="text-xl font-semibold">{data.medianTrophies === null ? t("Unknown") : number(data.medianTrophies)}</dd></div><div><dt className="text-muted-foreground">{t("Average of top {count}", { count: number(data.topCount) })}</dt><dd className="text-xl font-semibold">{data.top10Average === null ? t("Unknown") : number(data.top10Average)}</dd></div></dl>
    <p className="text-xs text-muted-foreground">{t("Collection data: {known} of {total} members", { known: number(data.inventoryMembers), total: number(data.members) })}</p>
    {data.unknownPower > 0 && <p className="text-xs text-muted-foreground">{t("Power unknown for {count} brawlers.", { count: number(data.unknownPower) })}</p>}
    <details className="text-sm"><summary className="cursor-pointer font-medium text-primary">{t("Trophies, Ranked and brawler power")}</summary><div className="mt-3 space-y-4">
    <div className="space-y-2"><p className="font-medium">{t("Trophy distribution")}</p>{data.trophyBands.map(band => <div key={band.min} className="grid grid-cols-[7rem_1fr_2rem] items-center gap-2 text-xs"><span dir="ltr">{number(band.min)}{band.max === null ? "+" : `–${number(band.max - 1)}`}</span><div className="h-3 overflow-hidden rounded bg-muted"><div className="h-full bg-primary/60" style={{ width: `${data.members ? band.members / data.members * 100 : 0}%` }} /></div><span className="text-end">{number(band.members)}</span></div>)}</div>
    <div><p className="font-medium">{t("Current Ranked distribution")}</p><dl className="mt-2 grid grid-cols-2 gap-2">{data.ranks.map(row => <div key={row.rank || "unknown"} className="flex justify-between gap-2"><dt>{t(row.rank || "Unknown")}</dt><dd>{number(row.members)}</dd></div>)}</dl></div>
    <div className="border-t pt-3"><p className="mb-2 text-sm font-medium">{t("Reported brawler power")}</p><div className="grid grid-cols-3 gap-2">{data.power.map(row => <div key={row.minimum} className="rounded bg-muted/40 p-2 text-sm"><p>{t("Power {level}+", { level: number(row.minimum) })}</p><p className="font-semibold">{number(row.brawlers)}</p><p className="text-xs text-muted-foreground">{t("{count} members", { count: number(row.members) })}</p></div>)}</div>
      <p className="mt-2 text-xs text-muted-foreground">{t("{count} brawlers observed", { count: number(data.brawlersObserved) })}</p>
    </div>
    {data.observedAt && <p className="text-xs text-muted-foreground">{t("Oldest member snapshot")}: {dateTime(data.observedAt)}</p>}
    </div></details>
  </>}</ClubIntelligencePanel>;
}
