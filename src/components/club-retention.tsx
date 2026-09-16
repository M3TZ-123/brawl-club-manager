"use client";
import Link from "next/link";
import { useI18n } from "@/components/locale-provider";
import { ClubIntelligencePanel, useClubIntelligence } from "@/components/club-intelligence-panel";

export function ClubRetention() {
  const resource = useClubIntelligence(), data = resource.data?.retention;
  const { t, number, dateTime } = useI18n();
  return <ClubIntelligencePanel title="Observed member retention" resource={resource}>{data && <>
    <p className="text-xs text-muted-foreground">{t("Recorded joining spells in the last 90 days. Returns start a separate spell; first observations are excluded from join cohorts.")}</p>
    <div className="grid gap-3 sm:grid-cols-2">{data.cohorts.map(cohort => <div key={cohort.days} className="rounded-lg bg-muted/40 p-3"><p className="text-sm">{t("Still present after {days} days", { days: number(cohort.days) })}</p><p className="my-1 text-2xl font-semibold">{cohort.rate === null ? t("Not enough follow-up yet") : `${number(cohort.rate)}%`}</p><p className="text-xs text-muted-foreground">{t("{retained} retained / {eligible} eligible spells; {pending} awaiting follow-up; {excluded} uncertain or first-observed.", { retained: number(cohort.retained), eligible: number(cohort.eligible), pending: number(cohort.pending), excluded: number(cohort.excluded) })}</p></div>)}</div>
    {data.truncated && <p className="text-sm text-amber-600">{t("Only a bounded recent membership history is shown.")}</p>}
    <details className="text-sm"><summary className="cursor-pointer text-primary">{t("Observed membership spells")}</summary><ul className="mt-2 max-h-72 space-y-3 overflow-auto">{data.spells.map((spell, i) => <li key={`${spell.playerTag}:${spell.startedAt}:${i}`} className="border-b pb-2"><Link href={`/members/${encodeURIComponent(spell.playerTag)}`} className="font-medium hover:text-primary">{spell.playerName}</Link> · {t(spell.kind === "join" ? "Observed join" : "First observed")}{spell.returning && ` · ${t("Returning member")}`}<p className="text-xs text-muted-foreground">{dateTime(spell.startedAt)} → {spell.endedAt ? dateTime(spell.endedAt) : t(spell.uncertain ? "End unknown" : "No departure observed")}</p><p className="text-xs text-muted-foreground">{t(spell.source)}{spell.uncertain && ` · ${t("Uncertain membership spell")}`}</p></li>)}</ul>{data.spells.length === 0 && <p className="mt-2 text-muted-foreground">{t("No recorded membership spells yet.")}</p>}</details>
    <p className="text-xs text-muted-foreground">{t("Dates reflect observations. Changes between roster checks can be missed; first observed is not an exact joining date.")}</p>
  </>}</ClubIntelligencePanel>;
}
