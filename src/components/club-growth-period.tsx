"use client";

import { useState } from "react";
import { ClubGrowth } from "@/components/club-growth";
import { useI18n } from "@/components/locale-provider";
import type { ClubIntelligenceRange } from "@/lib/club-intelligence-types";

export function ClubGrowthPeriod() {
  const [range, setRange] = useState<ClubIntelligenceRange>("7d");
  const { t } = useI18n();
  return <section className="space-y-2">
    <label className="flex flex-wrap items-center justify-end gap-2 text-sm text-muted-foreground">
      {t("Roster comparison period")}
      <select className="rounded-md border bg-background px-3 py-2 text-foreground" value={range} onChange={event => setRange(event.target.value as ClubIntelligenceRange)}>
        <option value="7d">{t("7 days")}</option><option value="30d">{t("1 month")}</option><option value="90d">{t("3 months")}</option>
      </select>
    </label>
    <ClubGrowth range={range} />
  </section>;
}
