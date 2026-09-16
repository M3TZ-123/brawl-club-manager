"use client";

import { useState } from "react";
import { ClubGrowth } from "@/components/club-growth";
import { useI18n } from "@/components/locale-provider";
import type { ClubIntelligenceRange } from "@/lib/club-intelligence-types";

export function ClubGrowthPeriod({ range: controlledRange, onChange }: { range?: ClubIntelligenceRange; onChange?: (range: ClubIntelligenceRange) => void } = {}) {
  const [chosen, setChosen] = useState<ClubIntelligenceRange>("7d");
  const range = controlledRange || chosen;
  const { t } = useI18n();
  return <section className="space-y-2">
    <label className="flex flex-wrap items-center justify-end gap-2 text-sm text-muted-foreground">
      {t("Roster comparison period")}
      <select className="rounded-md border bg-background px-3 py-2 text-foreground" value={range} onChange={event => (onChange || setChosen)(event.target.value as ClubIntelligenceRange)}>
        <option value="7d">{t("7 days")}</option><option value="30d">{t("30 days")}</option><option value="90d">{t("90 days")}</option>
      </select>
    </label>
    <ClubGrowth range={range} />
  </section>;
}
