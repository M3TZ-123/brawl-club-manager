"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Flag, Plus } from "lucide-react";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { useI18n } from "@/components/locale-provider";
import { useFeatureResource } from "@/components/use-feature-resource";
import { ClubRankingSummary } from "@/components/club-ranking-summary";
import { ClubRivalsComparison } from "@/components/club-rivals-comparison";
import { Button } from "@/components/ui/button";
import { useAdminSession } from "@/hooks/use-admin-session";
import { invalidateJsonCache } from "@/lib/client-data-cache";
import { gameRegions, type GameRegion } from "@/lib/game-data";
import type { ClubRivalsResponse } from "@/lib/club-rivals-data";
import type { ClubIntelligenceResponse } from "@/lib/club-intelligence-types";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";

const regions: Record<GameRegion, string> = { global: "Global", TN: "Tunisia", DZ: "Algeria", MA: "Morocco", FR: "France", EG: "Egypt", SA: "Saudi Arabia", US: "United States" };

export default function RivalsPage() {
  const { t } = useI18n();
  const { isAdmin } = useAdminSession();
  const [region, setRegion] = useState<GameRegion>("TN");
  const [tag, setTag] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; mutation.current?.abort(); };
  }, []);
  useEffect(() => { if (!isAdmin) mutation.current?.abort(); }, [isAdmin]);

  const resource = useFeatureResource<ClubRivalsResponse>(`/api/club-rivals?region=${region}`, "roster,settings");
  const { data } = resource;
  // The own-roster aggregate is needed only when there is another club to compare.
  const ownResource = useFeatureResource<ClubIntelligenceResponse>(data?.rivals.length ? "/api/club-intelligence?range=7d" : null, "roster,settings");
  const own = ownResource.data?.club.tag === data?.clubTag ? ownResource.data : null;

  async function save(value: string, active: boolean) {
    if (!isAdmin || !data || (active && data.rivals.length >= 5) || (mutation.current && !mutation.current.signal.aborted)) return;
    const current = new AbortController();
    mutation.current = current;
    setSaving(true);
    setError("");
    try {
      await fetchJsonWithTimeout("/api/club-rivals", { method: "POST", signal: current.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: value, active }) });
      if (current.signal.aborted || !mounted.current) return;
      invalidateJsonCache();
      if (active) setTag(draft => draft === value ? "" : draft);
      await resource.reload();
    } catch (failure) {
      if (mounted.current && !current.signal.aborted) setError(failure instanceof Error ? failure.message : "Club comparison unavailable");
    } finally {
      if (mutation.current === current) {
        mutation.current = null;
        if (mounted.current) setSaving(false);
      }
    }
  }

  return <LayoutWrapper><div className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="flex items-center gap-3 text-2xl font-bold"><Flag className="size-6 text-primary" />{t("Club rivals")}</h1><p className="mt-2 text-sm text-muted-foreground">{t("Follow your club's ranking and compare the clubs you choose.")}</p></div>
      <Button variant="outline" size="sm" disabled={resource.loading} onClick={() => { void resource.reload(); if (data?.rivals.length) void ownResource.reload(); }}>{t("Refresh")}</Button>
    </header>

    <section className="space-y-3 rounded-xl border p-4 sm:p-5" aria-label={t("Your club's ranking")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("Ranking region")}</p>
        <label className="flex min-w-0 items-center gap-2 text-sm"><span className="sr-only">{t("Region")}</span><select aria-label={t("Region")} value={region} onChange={event => setRegion(event.target.value as GameRegion)} className="h-9 max-w-full rounded-md border bg-background px-3">{gameRegions.map(key => <option key={key} value={key}>{t(regions[key])}</option>)}</select></label>
      </div>
      {resource.loading && !data && <p role="status" className="py-3 text-sm text-muted-foreground">{t("Loading club rankings…")}</p>}
      {resource.error && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm"><p>{t("Club comparison unavailable")} {data && t("The figures below are from the last successful load.")}</p><Button variant="outline" size="sm" onClick={() => void resource.reload()}>{t("Retry")}</Button></div>}
      {data && <ClubRankingSummary tag={data.clubTag} region={region} observations={data.ranks} rankingAt={data.rankingAt} rankingStale={data.rankingStale || resource.error} />}
    </section>

    <section className="min-w-0 space-y-4" aria-label={t("Compare clubs")}>
      <div><h2 className="text-xl font-semibold">{t("Compare clubs")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("Follow up to five clubs to compare member counts and trophy levels.")}</p></div>
      {isAdmin && <form onSubmit={event => { event.preventDefault(); void save(tag, true); }} className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 basis-52"><span className="mb-1 block text-sm">{t("Club tag")}</span><input dir="ltr" value={tag} onChange={event => setTag(event.target.value)} maxLength={22} required placeholder="#XXXXXXXX" className="h-10 w-full rounded-md border bg-background px-3" /></label>
        <Button disabled={saving || !data || data.rivals.length >= 5}><Plus className="me-2 size-4" />{t("Follow club")}</Button>
      </form>}
      {error && <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">{t(error)}</p>}
      {data && data.rivals.length >= 5 && isAdmin && <p className="text-xs text-muted-foreground">{t("Five clubs followed. Open a club's details to stop following it before adding another.")}</p>}
      {data?.rivals.length === 0 && <div className="rounded-xl border border-dashed p-5 text-sm">
        <p className="font-medium">{t("No rival clubs selected yet.")}</p><p className="mt-1 text-muted-foreground">{t(isAdmin ? "Add the first club using its tag above." : "An administrator can add the first club to compare.")}</p>
        {!isAdmin && <Link href="/admin?next=%2Frivals" className="mt-3 inline-block text-primary underline underline-offset-4">{t("Sign in")}</Link>}
      </div>}
      {!!data?.rivals.length && <>
        {!isAdmin && <p className="text-xs text-muted-foreground">{t("An administrator can manage followed clubs.")} <Link href="/admin?next=%2Frivals" className="text-primary underline">{t("Sign in")}</Link></p>}
        <ClubRivalsComparison data={data} own={own} ownLoading={ownResource.loading} ownError={ownResource.error || (!ownResource.loading && !own)} onRetryOwn={() => void ownResource.reload()} isAdmin={isAdmin} saving={saving} onUnfollow={value => void save(value, false)} />
      </>}
    </section>
  </div></LayoutWrapper>;
}
