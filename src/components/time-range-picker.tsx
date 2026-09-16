"use client";

import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { TIME_RANGES, type TimeRangeKey } from "@/lib/time-range";
import type { ReactElement } from "react";

type PickerOptions = { label?: string; dayBased?: boolean };
type FinitePickerProps = PickerOptions & {
  value: TimeRangeKey;
  onChange: (value: TimeRangeKey) => void;
  includeAll?: false;
};
type AllPickerProps = PickerOptions & {
  value: TimeRangeKey | "all";
  onChange: (value: TimeRangeKey | "all") => void;
  includeAll: true;
};
export function TimeRangePicker(props: FinitePickerProps): ReactElement;
export function TimeRangePicker(props: AllPickerProps): ReactElement;
export function TimeRangePicker(props: FinitePickerProps | AllPickerProps) {
  const { value, label = "Period", dayBased = false } = props;
  const { t } = useI18n();
  return <div className="space-y-1.5">
    <div role="group" aria-label={t(label)} className="flex flex-wrap items-center gap-1.5">
      {(Object.keys(TIME_RANGES) as TimeRangeKey[]).map(key => <Button key={key} type="button" size="sm"
        variant={key === value ? "default" : "outline"} aria-pressed={key === value}
        title={t(dayBased && key === "24h" ? "Today (UTC)" : TIME_RANGES[key].label)} onClick={() => props.onChange(key)} className="min-w-14">
        {t(dayBased && key === "24h" ? "Today" : TIME_RANGES[key].shortLabel)}
      </Button>)}
      {props.includeAll && <Button type="button" size="sm" variant={value === "all" ? "default" : "outline"}
        aria-pressed={value === "all"} onClick={() => props.onChange("all")}>{t("All Time")}</Button>}
    </div>
    {value !== "all" && <p className="text-xs text-muted-foreground">{t(dayBased && value === "24h" ? "Today (UTC)" : TIME_RANGES[value].label)}</p>}
  </div>;
}
