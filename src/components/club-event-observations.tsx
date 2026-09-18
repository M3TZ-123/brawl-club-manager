"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/components/locale-provider";
import { useAdminSession } from "@/hooks/use-admin-session";
import { Button } from "@/components/ui/button";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";
import type { ClubEventObservations } from "@/lib/club-event-observations-types";

export function ClubEventObservationsPanel({ eventId, version, draftChanged = false }: {
  eventId: string; version: number; draftChanged?: boolean;
}) {
  const { t, number, dateTime } = useI18n();
  const { isAdmin, isLoading: sessionLoading } = useAdminSession();
  const [snapshot, setSnapshot] = useState<{ key: string; value: ClubEventObservations } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const request = useRef<AbortController | null>(null), blocked = useRef(true);
  const key = `${eventId}:${version}`;
  const load = useCallback(() => {
    if (blocked.current || document.visibilityState === "hidden") return;
    request.current?.abort();
    const current = new AbortController(); request.current = current;
    setLoading(true); setError(false);
    return fetchJsonWithTimeout<ClubEventObservations>(`/api/club-event-observations?event=${encodeURIComponent(eventId)}&version=${version}`, {
      cache: "no-store", signal: current.signal,
    }).then(value => {
      if (current.signal.aborted || blocked.current) return;
      if (value.eventId !== eventId || value.eventVersion !== version || !Array.isArray(value.members) || value.members.length > 30) throw new Error("Invalid event observations");
      setSnapshot({ key, value });
    }).catch(() => {
      if (!current.signal.aborted && !blocked.current) { setSnapshot(null); setError(true); }
    }).finally(() => { if (!current.signal.aborted && !blocked.current) setLoading(false); });
  }, [eventId, version, key]);

  useEffect(() => {
    const clear = () => {
      blocked.current = true; request.current?.abort(); setSnapshot(null); setError(false);
      setSessionRevision(value => value + 1);
    };
    const clubChanged = (event: Event) => { if ((event as CustomEvent<{ clubChanged?: boolean }>).detail?.clubChanged) clear(); };
    window.addEventListener("admin-session-changed", clear);
    window.addEventListener("club-data-updated", clubChanged);
    return () => { blocked.current = true; request.current?.abort(); window.removeEventListener("admin-session-changed", clear); window.removeEventListener("club-data-updated", clubChanged); };
  }, []);
  useEffect(() => {
    blocked.current = !isAdmin || sessionLoading || draftChanged;
    if (blocked.current) return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) return load(); });
    const refresh = () => { void load(); };
    // Read already-synced observations. Never refresh or replace the editable form.
    const timer = setInterval(refresh, 120_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("club-data-updated", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true; blocked.current = true; request.current?.abort(); clearInterval(timer);
      window.removeEventListener("focus", refresh); window.removeEventListener("club-data-updated", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [isAdmin, sessionLoading, draftChanged, sessionRevision, load]);

  if (!isAdmin || sessionLoading) return null;
  const data = snapshot?.key === key && !draftChanged ? snapshot.value : null;
  const activeMembers = data?.members.filter(member => member.observedBattles > 0).length ?? 0;
  const identifiedMembers = data?.members.filter(member => member.explicitMegaPigBattles > 0).length ?? 0;
  return <section className="rounded-lg border p-3 space-y-3 min-w-0" aria-label={t("Automatic event observations")}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">{t("Automatic event observations")}</h3>
      {!draftChanged && <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>{t("Refresh")}</Button>}
    </div>
    {draftChanged ? <p className="text-sm text-muted-foreground">{t("Save the event dates and members to update automatic observations.")}</p> : <>
      {loading && !data && <p role="status" className="text-sm">{t("Loading...")}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{t("Event observations are unavailable. Refresh or reload the saved event.")}</p>}
      {data && <>
        {!data.hasStarted ? <p className="text-sm">{t("Observation starts at the saved event start time.")}</p> : <>
          <p className="text-sm">{t("Activity observed for {count} of {total} saved event members.", { count: number(activeMembers), total: number(data.members.length) })}</p>
          <p className="text-sm text-muted-foreground">{t(identifiedMembers ? "Recorded Mega Pig battles; official contribution totals unavailable." : "Mega Pig participation is not identified in the available battle logs.")}</p>
          {!!data.members.length && <details>
            <summary className="cursor-pointer text-sm text-primary">{t("View observed member activity")}</summary>
            <ul className="mt-3 divide-y">{data.members.map(member => <li key={member.playerTag} className="py-3 space-y-1 text-sm min-w-0">
              <p className="font-medium break-words">{member.playerName} <span dir="ltr" className="text-xs text-muted-foreground">{member.playerTag}</span></p>
              <p>{member.observedBattles ? t("{count} recorded player results during this event window", { count: number(member.observedBattles) }) : t("No battles observed; attendance is unknown.")}</p>
              {member.lastObservedBattleAt && <p className="text-xs text-muted-foreground">{t("Last observed battle")}: {dateTime(member.lastObservedBattleAt)}</p>}
              {member.explicitMegaPigBattles > 0 && <p className="text-xs">{t("{count} results explicitly labelled Mega Pig by the source", { count: number(member.explicitMegaPigBattles) })}</p>}
            </li>)}</ul>
          </details>}
        </>}
        <p className="text-xs text-muted-foreground">{t("Battle data checked")}: {data.sync.lastBattleSyncAt ? dateTime(data.sync.lastBattleSyncAt) : t("Unknown")}{data.sync.stale ? ` · ${t("Refresh delayed")}` : ""}</p>
      </>}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("How automatic observations work")}</summary>
        <p className="mt-2">{t("Missing battles do not prove absence or affect member comparisons. Wins and tickets must be confirmed separately.")}</p>
      </details>
    </>}
  </section>;
}
