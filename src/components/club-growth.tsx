"use client";

import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ClubTrophyChange } from "@/lib/club-trophy-change";

export function ClubGrowth({ data, onRetry }: { data: ClubTrophyChange | null; onRetry: () => void }) {
  const { t, number, dateTime, date, delta } = useI18n();
  const comparable = data && data.status !== "insufficient_history" && data.totalChange != null && data.startAt && data.endAt;
  const firstRecord = data?.points[0]?.observedAt;

  return <Card className="min-w-0">
    <CardHeader className="p-4 pb-3"><CardTitle className="text-base">{t("Club trophy changes")}</CardTitle></CardHeader>
    <CardContent className="space-y-3 p-4 pt-0">
      {!data ? <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <p>{t("Club trophy changes are temporarily unavailable.")}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>{t("Retry")}</Button>
      </div> : <>
        {comparable ? <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-2xl font-bold tabular-nums"><bdi>{delta(data.totalChange)}</bdi></p>
            <p className={`text-sm ${data.status === "partial_period" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>{t(data.status === "partial_period" ? "Partial period — since first record" : "Change between recorded totals")}</p>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <p>{t("From")}: <bdi>{dateTime(data.startAt)}</bdi></p>
            <p>{t("To")}: <bdi>{dateTime(data.endAt)}</bdi></p>
          </div>
          <dl className="grid grid-cols-3 gap-2 border-t pt-3 text-sm">
            {[
              { label: "Same members", change: data.commonProgress, members: data.commonMembers },
              { label: "Members added", change: data.addedTrophies, members: data.addedMembers },
              { label: "Members left", change: data.removedTrophies == null ? null : -data.removedTrophies, members: data.removedMembers },
            ].map(item => <div key={item.label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{t(item.label)}</dt>
              <dd className="mt-1 font-semibold tabular-nums"><bdi>{delta(item.change)}</bdi></dd>
              <dd className="text-xs text-muted-foreground">{item.members == null ? "—" : t("{count} members", { count: number(item.members) })}</dd>
            </div>)}
          </dl>
        </> : <div className="space-y-2 text-sm text-muted-foreground">
          <p>{t(firstRecord ? "Waiting for a second complete roster record." : "Not enough complete roster history yet.")}</p>
          {firstRecord && <p className="text-xs">{t("First complete record")}: <bdi>{dateTime(firstRecord)}</bdi></p>}
        </div>}
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-primary">{t("Details")}</summary>
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">{t("Requested period")}: <bdi>{dateTime(data.requestedStart)}</bdi> — <bdi>{dateTime(data.requestedEnd)}</bdi></p>
            {comparable && <div className="space-y-2 text-xs text-muted-foreground">
              <p>{t("Same members compares the accounts present in both records. Added and left show the trophies of members present in only the last or first record.")}</p>
              <p>{t("This compares two rosters, not every join or departure between them. Account changes can include play outside the club and are not a participation score.")}</p>
            </div>}
            {data.points.length > 0 && <div className="max-h-56 max-w-full overflow-auto rounded-md border" tabIndex={0} role="region" aria-label={t("Recorded daily roster totals")}>
              <table className="w-full min-w-[34rem] text-start text-xs">
                <caption className="p-2 text-start text-muted-foreground">{t("Recorded daily roster totals")}</caption>
                <thead><tr>
                  <th scope="col" className="p-2 text-start">{t("Day (UTC)")}</th>
                  <th scope="col" className="p-2 text-start">{t("Last observed (local time)")}</th>
                  <th scope="col" className="p-2 text-end">{t("Trophies")}</th>
                  <th scope="col" className="p-2 text-end">{t("Members")}</th>
                </tr></thead>
                <tbody>{data.points.map(point => <tr key={point.day} className="border-t">
                  <td className="whitespace-nowrap p-2"><bdi>{date(`${point.day}T00:00:00Z`, { dateStyle: "medium", timeZone: "UTC" })}</bdi></td>
                  <td className="whitespace-nowrap p-2"><bdi>{dateTime(point.observedAt)}</bdi></td>
                  <td className="p-2 text-end tabular-nums"><bdi>{number(point.totalTrophies)}</bdi></td>
                  <td className="p-2 text-end tabular-nums">{number(point.members)}</td>
                </tr>)}</tbody>
              </table>
            </div>}
          </div>
        </details>
      </>}
    </CardContent>
  </Card>;
}
