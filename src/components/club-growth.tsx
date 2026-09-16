"use client";
import { useI18n } from "@/components/locale-provider";
import { ClubIntelligencePanel, useClubIntelligence } from "@/components/club-intelligence-panel";
import type { ClubIntelligenceRange } from "@/lib/club-intelligence-types";

export function ClubGrowth({ range = "7d" }: { range?: ClubIntelligenceRange }) {
  const resource = useClubIntelligence(range), data = resource.data?.growth;
  const { t, number, dateTime, delta } = useI18n();
  return <ClubIntelligencePanel title="What changed the club trophies?" resource={resource}>{data && <>
    <p className="text-xs text-muted-foreground">{t("Last {days} days", { days: number(Number.parseInt(range, 10)) })}</p>
    {data.status === "observed" ? <>
      <p className="text-2xl font-bold tabular-nums">{delta(data.totalChange!)}</p>
      <p className="text-xs text-muted-foreground">{t("Includes changes in who belongs to the club.")}</p>
      <p className="text-xs text-muted-foreground">{dateTime(data.startAt)} → {dateTime(data.endAt)}</p>
      {data.returningMembers > 0 && <p className="text-sm text-amber-600">{t("{count} shared members left and returned between the snapshots.", { count: number(data.returningMembers) })}</p>}
      <details className="text-sm"><summary className="cursor-pointer font-medium text-primary">{t("How the total changed")}</summary><div className="mt-3 space-y-3">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-lg bg-muted/40 p-3"><dt>{t("Members in both snapshots")}</dt><dd className="mt-1 text-lg font-semibold">{delta(data.commonProgress!)}</dd><dd className="text-xs text-muted-foreground">{t("{count} members", { count: number(data.commonMembers) })}</dd></div>
        <div className="rounded-lg bg-muted/40 p-3"><dt>{t("Present only at the end")}</dt><dd className="mt-1 text-lg font-semibold">+{number(data.addedTrophies!)}</dd><dd className="text-xs text-muted-foreground">{t("{count} members", { count: number(data.addedMembers) })}</dd></div>
        <div className="rounded-lg bg-muted/40 p-3"><dt>{t("Present only at the start")}</dt><dd className="mt-1 text-lg font-semibold">−{number(data.removedTrophies!)}</dd><dd className="text-xs text-muted-foreground">{t("{count} members", { count: number(data.removedMembers) })}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">{t("This separates endpoint roster changes. It does not measure trophies earned only while a player belonged to the club.")}</p>
      </div></details>
    </> : <p className="text-sm text-muted-foreground">{t("A complete starting roster has not been recorded for this period yet.")}</p>}
    {data.availableFrom && <p className="text-xs text-muted-foreground">{t("Roster history begins")}: {dateTime(data.availableFrom)}</p>}
    {data.points.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-primary">{t("Recorded daily roster totals")}</summary><div className="mt-2 max-h-56 overflow-auto"><table className="w-full text-start text-xs"><thead><tr><th className="p-2 text-start">{t("Observed")}</th><th className="p-2 text-end">{t("Trophies")}</th><th className="p-2 text-end">{t("Members")}</th></tr></thead><tbody>{data.points.map(point => <tr key={point.observedAt} className="border-t"><td className="p-2">{dateTime(point.observedAt)}</td><td className="p-2 text-end">{number(point.totalTrophies)}</td><td className="p-2 text-end">{number(point.members)}</td></tr>)}</tbody></table></div></details>}
  </>}</ClubIntelligencePanel>;
}
