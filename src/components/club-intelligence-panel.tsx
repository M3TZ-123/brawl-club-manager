"use client";
import type { ReactNode } from "react";
import { useI18n } from "@/components/locale-provider";
import { useFeatureResource } from "@/components/use-feature-resource";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { ClubIntelligenceRange, ClubIntelligenceResponse } from "@/lib/club-intelligence-types";

export const useClubIntelligence = (range: ClubIntelligenceRange = "7d") => useFeatureResource<ClubIntelligenceResponse>(`/api/club-intelligence?range=${range}`, "roster,battles,ranked");
export function ClubIntelligencePanel({ title, resource, children }: { title: string; resource: ReturnType<typeof useClubIntelligence>; children: ReactNode }) {
  const { t, dateTime } = useI18n();
  return <Card><CardHeader className="pb-3"><CardTitle>{t(title)}</CardTitle></CardHeader><CardContent className="space-y-4">
    {resource.error && <div role="alert" className="text-sm text-destructive">{t("Club insights are temporarily unavailable.")} <Button variant="ghost" size="sm" onClick={resource.reload}>{t("Retry")}</Button></div>}
    {resource.loading && !resource.data && <p role="status" className="text-sm text-muted-foreground">{t("Loading...")}</p>}
    {resource.data && <>{resource.error && <p className="text-xs text-muted-foreground">{t("Showing the last available update")} · {dateTime(resource.data.generatedAt)}</p>}{children}</>}
  </CardContent></Card>;
}
