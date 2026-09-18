"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminSession } from "@/hooks/use-admin-session";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import { useAppStore } from "@/lib/store";
import { formatBrawlName } from "@/lib/brawl-text";
import { megaPigReportedStage, MEGA_PIG_RULE_REFERENCE_URL } from "@/lib/mega-pig-progress";
import type { MegaPigSourceResponse } from "@/lib/mega-pig-source-types";

const tagKey = (value: string) => value.trim() ? `#${value.trim().replace(/^#/, "").toUpperCase()}` : "";
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const optionalCount = (value: unknown) => value === null || count(value);
function validResponse(value: MegaPigSourceResponse, clubTag: string) {
  return value && typeof value.clubTag === "string" && tagKey(value.clubTag) === clubTag
    && ["available", "stale", "pending", "unavailable"].includes(value.status)
    && optionalCount(value.totalWins) && optionalCount(value.reportedPlayersPlayed) && (value.reportedPlayersPlayed === null || value.reportedPlayersPlayed <= 30)
    && optionalCount(value.reportedBattlesPlayed)
    && count(value.matchedMembers) && count(value.sourceMembers) && count(value.rosterMembers)
    && Array.isArray(value.members) && value.members.length <= 30
    && new Set(value.members.map(member => member.playerTag)).size === value.members.length
    && value.members.every(member => typeof member.playerTag === "string" && typeof member.playerName === "string"
      && optionalCount(member.reportedWins) && optionalCount(member.reportedTicketsRemaining))
    && ["BrawlAce", "BrawlTools"].includes(value.source?.name) && value.source.official === false
    && value.source.cycleVerified === false && value.source.updatedAt === null;
}

export function MegaPigSourcePanel() {
  const { t, number, dateTime } = useI18n();
  const { isAdmin, isLoading: sessionLoading } = useAdminSession();
  const clubTag = tagKey(useAppStore(state => state.clubTag));
  const [revision, setRevision] = useState(0);
  const key = `${clubTag}:${revision}`;
  const [snapshot, setSnapshot] = useState<{ key: string; value: MegaPigSourceResponse } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null), blocked = useRef(true);

  const load = useCallback(() => {
    if (blocked.current || document.visibilityState === "hidden" || request.current) return;
    const current = new AbortController(); request.current = current;
    setLoading(true); setError(false);
    return fetchJsonWithTimeout<MegaPigSourceResponse>("/api/mega-pig-source", { cache: "no-store", signal: current.signal })
      .then(value => {
        if (current.signal.aborted || blocked.current || request.current !== current) return;
        if (!validResponse(value, clubTag)) throw new Error("Invalid Mega Pig counters");
        setSnapshot({ key, value });
      }).catch(() => {
        if (!current.signal.aborted && !blocked.current && request.current === current) { setSnapshot(null); setError(true); }
      }).finally(() => {
        if (request.current === current) { request.current = null; if (!current.signal.aborted && !blocked.current) setLoading(false); }
      });
  }, [clubTag, key]);

  useEffect(() => {
    const clear = () => {
      blocked.current = true; request.current?.abort(); request.current = null;
      setSnapshot(null); setError(false); setLoading(false); setRevision(value => value + 1);
    };
    const clubChanged = (event: Event) => { if ((event as CustomEvent<{ clubChanged?: boolean }>).detail?.clubChanged) clear(); };
    window.addEventListener("admin-session-changed", clear);
    window.addEventListener("club-data-updated", clubChanged);
    return () => {
      blocked.current = true; request.current?.abort(); request.current = null;
      window.removeEventListener("admin-session-changed", clear); window.removeEventListener("club-data-updated", clubChanged);
    };
  }, []);

  useEffect(() => {
    blocked.current = !isAdmin || sessionLoading || !clubTag;
    if (blocked.current) return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) return load(); });
    const refresh = () => { void load(); };
    // The app reads its server cache; provider refresh cadence stays server-owned.
    const timer = setInterval(refresh, 120_000);
    window.addEventListener("focus", refresh); window.addEventListener("club-data-updated", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true; blocked.current = true; request.current?.abort(); request.current = null;
      clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("club-data-updated", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [isAdmin, sessionLoading, clubTag, revision, load]);

  if (!isAdmin || sessionLoading) return null;
  const data = snapshot?.key === key ? snapshot.value : null;
  const counters = data && (data.status === "available" || data.status === "stale") ? data : null;
  const unknownNumber = (value: number | null) => value === null ? t("Unknown") : number(value);
  const sourceUrl = data?.source.name === "BrawlTools" ? "https://brawltools.net"
    : data?.source.name === "BrawlAce" ? `https://brawlace.com/clubs/${encodeURIComponent(clubTag)}` : null;
  const hasBattleCount = counters?.reportedBattlesPlayed != null;
  const rosterDiffers = counters && (counters.matchedMembers !== counters.rosterMembers || counters.sourceMembers !== counters.matchedMembers);
  const estimatedStage = counters?.totalWins == null ? null : megaPigReportedStage(counters.totalWins);

  return <section className="rounded-lg border bg-card p-4 space-y-3 min-w-0" aria-label={t("Mega Pig counters")}>
    <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{t("Mega Pig counters")}</h2>{data && <p className="text-xs text-muted-foreground">{t("Reported by {source} · third-party source", { source: data.source.name })}</p>}</div><Button type="button" variant="ghost" size="sm" disabled={loading || !clubTag} onClick={() => void load()}>{t("Refresh")}</Button></div>
    {(!data && !error) && <p role="status" className="text-sm text-muted-foreground">{t("Loading counters...")}</p>}
    {(error || data?.status === "unavailable") && <p role="alert" className="text-sm text-muted-foreground">{t("Mega Pig counters are unavailable. Try again later.")}</p>}
    {data?.status === "pending" && <p role="status" className="text-sm text-muted-foreground">{t("The source is being checked. Counters will appear when available.")}</p>}
    {counters && <>
      <dl className="grid grid-cols-2 gap-3"><div><dt className="text-xs text-muted-foreground">{t("Reported total wins")}</dt><dd className="mt-1 text-2xl font-semibold">{unknownNumber(counters.totalWins)}</dd></div><div><dt className="text-xs text-muted-foreground">{t(hasBattleCount ? "Reported battles" : "Players reported by source")}</dt><dd className="mt-1 text-2xl font-semibold">{unknownNumber(hasBattleCount ? counters.reportedBattlesPlayed : counters.reportedPlayersPlayed)}</dd></div></dl>
      <p className="text-xs text-muted-foreground">{t("Estimated stage")}: <bdi dir="ltr">{estimatedStage === null ? t("Unknown") : `${number(estimatedStage)}/${number(5)}`}</bdi> · {t("Based on 16 wins per stage")}{estimatedStage === 5 ? ` · ${t("Target reached by this estimate")}` : ""}</p>
      <p className="text-xs text-amber-600 dark:text-amber-400">{t("Cycle unconfirmed · reward unconfirmed")}</p>
      {counters.status === "stale" && <p role="status" className="text-sm text-amber-600 dark:text-amber-400">{t("Showing saved counters; the source refresh is delayed.")}</p>}
      {rosterDiffers && <p role="status" className="text-xs text-amber-600 dark:text-amber-400">{t("Matched {matched} of {total} current members. Missing members have unknown counters.", { matched: number(counters.matchedMembers), total: number(counters.rosterMembers) })}</p>}
      <details className="text-sm"><summary className="cursor-pointer text-primary">{t("Member counters")}</summary><div className="mt-3 space-y-3">
        {counters.members.length > 0 && <table className="w-full table-fixed text-sm"><caption className="sr-only">{t("Reported counters for current members")}</caption><thead><tr className="border-b text-start text-xs text-muted-foreground"><th scope="col" className="pb-2 text-start font-medium">{t("Member")}</th><th scope="col" className="w-16 pb-2 text-end font-medium">{t("Wins")}</th><th scope="col" className="w-24 pb-2 ps-2 text-end font-medium">{t("Tickets remaining")}</th></tr></thead><tbody>{counters.members.map(member => <tr key={member.playerTag} className="border-b last:border-0"><th scope="row" className="py-2 pe-2 text-start font-normal [overflow-wrap:anywhere]">{formatBrawlName(member.playerName, t("Player"))}<bdi dir="ltr" className="block text-xs text-muted-foreground">{member.playerTag}</bdi></th><td className="py-2 text-end">{unknownNumber(member.reportedWins)}</td><td className="py-2 ps-2 text-end">{unknownNumber(member.reportedTicketsRemaining)}</td></tr>)}</tbody></table>}
      </div></details>
    </>}
    {data?.fetchedAt && <p className="text-xs text-muted-foreground">{t("Last fetched from source")}: <time dateTime={data.fetchedAt}>{dateTime(data.fetchedAt)}</time>{data.updating ? ` · ${t("Checking source...")}` : ""}</p>}
    {counters && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{t("Source and rules")}</summary><div className="mt-2 space-y-2 text-muted-foreground">
      {rosterDiffers && <p>{t("The source lists {source} members; {matched} match the current roster.", { source: number(counters.sourceMembers), matched: number(counters.matchedMembers) })}</p>}
      <p>{t("The source does not date the cycle. These counters are not used for attendance or member comparisons.")}</p>
      <p>{t("Stage targets are community-reported estimates; confirm this edition's rules in the game.")}</p>
      <div className="flex flex-wrap gap-3">{sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">{t("Open {source} source", { source: counters.source.name })}</a>}<a className="text-primary underline" href={MEGA_PIG_RULE_REFERENCE_URL} target="_blank" rel="noopener noreferrer">{t("Rule reference")}</a></div>
    </div></details>}
  </section>;
}
