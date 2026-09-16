"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJsonCached } from "@/lib/client-data-cache";
import { clubRoleLabel } from "@/lib/club-role";
import { useI18n, LocalDate } from "@/components/locale-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type MembershipEvent = { id: string; eventType: string; occurredAt: string; source: "recorded" | "reconstructed" | "unknown"; actor: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null };
export function MembershipTimeline({ playerTag }: { playerTag: string }) {
  const { t, number } = useI18n();
  const [events, setEvents] = useState<MembershipEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const failedCursor = useRef<string | null>(null);
  const load = useCallback(async (next: string | null = null, force = false) => {
    const request = ++generation.current;
    failedCursor.current = next;
    setLoading(true); setError(false);
    try {
      const query = new URLSearchParams({ playerTag, limit: "20" });
      if (next) query.set("cursor", next);
      const data = await fetchJsonCached<{ events?: MembershipEvent[]; nextCursor?: string | null }>(`/api/sync/events?${query}`, { staleMs: 30_000, force });
      if (request !== generation.current) return;
      setEvents(previous => next ? Array.from(new Map([...previous, ...(data.events || [])].map(event => [event.id, event])).values()) : data.events || []);
      setCursor(data.nextCursor || null);
    } catch { if (request === generation.current) setError(true); }
    finally { if (request === generation.current) setLoading(false); }
  }, [playerTag]);
  useEffect(() => {
    const requests = generation;
    setEvents([]); setCursor(null); void load();
    return () => { requests.current++; };
  }, [load]);
  useEffect(() => {
    let dirty = false;
    const changed = (event: Event) => {
      const datasets = (event as CustomEvent).detail?.datasets;
      if (Array.isArray(datasets) && !datasets.includes("roster")) return;
      if (document.visibilityState === "hidden") { dirty = true; return; }
      void load(null, true);
    };
    const wake = () => { if (dirty && document.visibilityState !== "hidden") { dirty = false; void load(null, true); } };
    window.addEventListener("club-data-updated", changed); document.addEventListener("visibilitychange", wake);
    return () => { window.removeEventListener("club-data-updated", changed); document.removeEventListener("visibilitychange", wake); };
  }, [load]);
  const snapshot = (value: Record<string, unknown> | null) => {
    if (!value) return t("No snapshot");
    const parts = [];
    if (typeof value.player_name === "string") parts.push(value.player_name);
    else if (typeof value.name === "string") parts.push(value.name);
    if (typeof value.role === "string") parts.push(t(clubRoleLabel(value.role)));
    if (typeof value.trophies === "number") parts.push(`${t("Trophies")}: ${number(value.trophies)}`);
    return parts.length ? parts.join(" · ") : t("No snapshot");
  };
  return <Card><CardHeader><CardTitle>{t("Membership timeline")}</CardTitle><p className="text-sm text-muted-foreground">{t("Historical events were reconstructed from retained records; missing snapshots are not assumed.")}</p></CardHeader><CardContent className="space-y-4">
    {events.map(event => <article key={event.id} className="border-s-2 ps-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{t(event.eventType === "initial_seen" ? "First observed" : event.eventType)}</h3><span className="rounded border px-2 py-0.5 text-xs">{t(event.source === "recorded" ? "Recorded" : event.source === "reconstructed" ? "Reconstructed" : "Unknown source")}</span></div><p className="text-xs text-muted-foreground"><LocalDate value={event.occurredAt} time /></p><dl className="mt-2 space-y-1 text-sm"><div><dt className="inline text-muted-foreground">{t("Before")}: </dt><dd className="inline"><bdi>{snapshot(event.before)}</bdi></dd></div><div><dt className="inline text-muted-foreground">{t("After")}: </dt><dd className="inline"><bdi>{snapshot(event.after)}</bdi></dd></div></dl></article>)}
    {loading && <p role="status">{t("Loading timeline...")}</p>}{error && <div role="alert">{t("Timeline unavailable")} <Button variant="ghost" onClick={() => load(failedCursor.current, true)}>{t("Retry")}</Button></div>}
    {!loading && !error && events.length === 0 && <p className="text-sm text-muted-foreground">{t("No membership events are available yet.")}</p>}
    {cursor && !error && <Button variant="outline" disabled={loading} onClick={() => load(cursor)}>{t("Load More")}</Button>}
  </CardContent></Card>;
}
