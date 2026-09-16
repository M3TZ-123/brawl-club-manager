"use client";

import { LocalDate, useI18n } from "@/components/locale-provider";
import type { ReportedEquipment as Equipment } from "@/lib/club-analysis-types";

export function EquipmentList({ label, items, checkedAt }: { label: string; items: Equipment[] | null; checkedAt?: string }) {
  const { t, number } = useI18n();
  return <div className="min-w-0 space-y-1">
    <h4 className="text-sm font-medium">{t(label)}</h4>
    {items === null ? <p className="text-sm text-muted-foreground">{t("Not reported")}</p> : !items.length ? <p className="text-sm text-muted-foreground">{t("None reported")}</p> : <ul className="space-y-1 text-sm">
      {items.map(item => <li key={item.id} className="break-words">{item.name || t("Unnamed item")} <bdi dir="ltr" className="text-xs text-muted-foreground">#{item.id}</bdi>{item.level != null && <span className="text-muted-foreground"> · {t("Level {level}", { level: number(item.level) })}</span>}</li>)}
    </ul>}
    {checkedAt && <p className="text-xs text-muted-foreground">{t("Last observed")}: <LocalDate value={checkedAt} time /></p>}
  </div>;
}

export function ReportedEquipmentDetails({ gadgets, starPowers, gears, hyperCharges, buffies, fieldCheckedAt = {} }: {
  gadgets: Equipment[] | null; starPowers: Equipment[] | null; gears: Equipment[] | null; hyperCharges: Equipment[] | null;
  buffies: { gadget: boolean | null; starPower: boolean | null; hyperCharge: boolean | null } | null;
  fieldCheckedAt?: Record<string, string>;
}) {
  const { t } = useI18n();
  return <div className="space-y-4">
    <div className="grid gap-4 sm:grid-cols-2">
      <EquipmentList label="Reported gadgets" items={gadgets} checkedAt={fieldCheckedAt.gadgets} />
      <EquipmentList label="Reported star powers" items={starPowers} checkedAt={fieldCheckedAt.star_powers ?? fieldCheckedAt.starPowers} />
      <EquipmentList label="Reported gears" items={gears} checkedAt={fieldCheckedAt.gears} />
      <EquipmentList label="Reported hypercharges" items={hyperCharges} checkedAt={fieldCheckedAt.hyper_charges ?? fieldCheckedAt.hyperCharges} />
    </div>
    <p className="text-xs text-muted-foreground">{t("Hypercharge entries are reported by the profile. They do not confirm ownership or usability.")}</p>
    <div><h4 className="text-sm font-medium">{t("Reported Buffies")}</h4><dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
      {([["gadget", "Gadget"], ["starPower", "Star power"], ["hyperCharge", "Hypercharge"]] as const).map(([key, label]) => <div key={key}><dt className="text-muted-foreground">{t(label)}</dt><dd className="mt-1">{buffies?.[key] == null ? t("Not reported") : buffies[key] ? t("Yes") : t("No")}</dd></div>)}
    </dl>{fieldCheckedAt.buffies && <p className="mt-2 text-xs text-muted-foreground">{t("Last observed")}: <LocalDate value={fieldCheckedAt.buffies} time /></p>}</div>
  </div>;
}
