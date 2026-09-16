"use client";
import { useState } from "react";
import Link from "next/link";
import { useI18n } from "@/components/locale-provider";
import { ClubIntelligencePanel, useClubIntelligence } from "@/components/club-intelligence-panel";
import type { ClubIntelligenceRange, ActivityCell } from "@/lib/club-intelligence-types";

const quality: Record<ActivityCell["coverage"], string> = { monitored: "Monitored day", partial: "Partial day or delayed check", possible_gap: "Possible history gap", before_tracking: "Before monitoring baseline", limited: "Older coverage is limited" };
export function ClubActivityCalendar({ range }: { range?: ClubIntelligenceRange }) {
  const [chosen, setChosen] = useState<ClubIntelligenceRange>("7d");
  const selected = range || chosen, resource = useClubIntelligence(selected), data = resource.data?.calendar;
  const { t, number } = useI18n();
  return <ClubIntelligencePanel title="Member activity calendar" resource={resource}>
    {!range && <label className="flex items-center gap-2 text-sm">{t("Period")}<select value={chosen} onChange={event => setChosen(event.target.value as ClubIntelligenceRange)} className="rounded-md border bg-background px-3 py-2">
      {(["7d", "30d", "90d"] as const).map(key => <option key={key} value={key}>{t("Last {days} days", { days: number(Number.parseInt(key, 10)) })}</option>)}
    </select></label>}
    {data && <>
      <p className="text-sm text-muted-foreground">{t("Current members' recorded battles; one battle can count for multiple members, including before they joined. Days use UTC.")}</p>
      <p className="text-sm">{t("{count} recorded participations across {days} days with recorded battles.", { count: number(data.observedParticipations), days: number(data.recordedDays) })}</p>
      {data.rows.length ? <div className="max-h-[36rem] overflow-auto rounded-md border" tabIndex={0} aria-label={t("Member activity calendar")}>
        <table className="w-full border-collapse text-xs"><caption className="sr-only">{t("Select a day to inspect its recorded battles.")}</caption>
          <thead><tr><th className="sticky start-0 top-0 z-20 min-w-32 bg-background p-2 text-start">{t("Member")}</th>{data.days.map(day => <th key={day} className="sticky top-0 z-10 min-w-12 bg-background p-2 font-normal"><time dateTime={day}>{day.slice(5)}</time></th>)}</tr></thead>
          <tbody>{data.rows.map(row => <tr key={row.playerTag} className="border-t"><th className="sticky start-0 z-10 max-w-40 bg-background p-2 text-start"><Link href={`/members/${encodeURIComponent(row.playerTag)}`} className="block truncate hover:text-primary">{row.playerName}</Link></th>
            {row.cells.map(cell => {
              const count = cell.battles;
              const shade = cell.coverage === "possible_gap" ? "ring-1 ring-inset ring-amber-500" : cell.coverage !== "monitored" ? "border border-dashed border-muted-foreground/30" : "";
              const fill = count === null ? "bg-muted/20 text-muted-foreground" : count === 0 ? "bg-muted/50" : count < 5 ? "bg-green-500/15" : count < 15 ? "bg-green-500/30" : "bg-green-500/50";
              const label = `${row.playerName} · ${cell.day} UTC · ${count === null ? t("Unknown") : t("{count} recorded battles", { count: number(count) })} · ${t(quality[cell.coverage])}`;
              return <td key={cell.day} className="p-1"><Link href={cell.href} title={label} aria-label={label} className={`flex h-9 min-w-10 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-primary ${fill} ${shade}`}>{count === null ? "—" : number(count)}</Link></td>;
            })}</tr>)}</tbody>
        </table>
      </div> : <p className="text-sm text-muted-foreground">{t("No current members found.")}</p>}
      <p className="text-xs text-muted-foreground">{t("Zero means no recorded battles, not proof of no play. Dashed cells have limited coverage; amber cells have a possible gap.")}</p>
      <p className="text-xs text-muted-foreground">{t("Gap checks cover 28 days. Older counts remain recorded observations, without a completeness guarantee.")}</p>
    </>}
  </ClubIntelligencePanel>;
}
