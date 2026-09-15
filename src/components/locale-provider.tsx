"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useAppStore } from "@/lib/store";
import { intlLocale, translate, type Locale } from "@/lib/i18n/messages";

const LocaleContext = createContext<Locale>("en");

export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = useAppStore((state) => state.locale || "en");
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
  }, [locale]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useI18n() {
  const locale = useContext(LocaleContext);
  return useMemo(() => ({
    locale,
    direction: locale === "ar" ? "rtl" as const : "ltr" as const,
    t: (text: string, values?: Record<string, string | number>) => translate(text, locale, values),
    number: (value: number) => new Intl.NumberFormat(intlLocale(locale)).format(value),
    delta: (value: number | null | undefined) => value == null ? "—" : new Intl.NumberFormat(intlLocale(locale), { signDisplay: "exceptZero" }).format(value),
    dateTime: (value: string | Date | null | undefined) => !value || Number.isNaN(new Date(value).getTime()) ? translate("Unknown", locale) : new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)),
    reportDate: (value: string | Date) => new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)),
    relative: (value: string | Date | null | undefined) => {
      if (!value || Number.isNaN(new Date(value).getTime())) return translate("Unknown", locale);
      const seconds = Math.min(0, (new Date(value).getTime() - Date.now()) / 1000);
      const [amount, unit] = Math.abs(seconds) < 60 ? [0, "second"] : Math.abs(seconds) < 3600 ? [Math.round(seconds / 60), "minute"] : Math.abs(seconds) < 86400 ? [Math.round(seconds / 3600), "hour"] : [Math.round(seconds / 86400), "day"];
      return new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" }).format(Number(amount), unit as Intl.RelativeTimeFormatUnit);
    },
    date: (value: string | Date | null | undefined, options?: Intl.DateTimeFormatOptions) => {
      if (!value || Number.isNaN(new Date(value).getTime())) return translate("Unknown", locale);
      return new Intl.DateTimeFormat(intlLocale(locale), options || { dateStyle: "medium" }).format(new Date(value));
    },
  }), [locale]);
}

export function T({ text, values }: { text?: string | number | null; values?: Record<string, string | number> }) {
  const { t, number } = useI18n();
  return <>{text == null ? "" : typeof text === "number" ? number(text) : t(text, values)}</>;
}

export function LocalDate({ value, time = false, utc = false }: { value?: string | Date | null; time?: boolean; utc?: boolean }) {
  const { date } = useI18n();
  const valid = value && !Number.isNaN(new Date(value).getTime());
  return <time dateTime={valid ? new Date(value).toISOString() : undefined}>{date(value, { dateStyle: "medium", ...(time ? { timeStyle: "short" } : {}), ...(utc ? { timeZone: "UTC" } : {}) })}</time>;
}

export function LanguageSelector() {
  const { locale } = useI18n();
  const setLocale = useAppStore((state) => state.setLocale);
  return <select aria-label="Language / اللغة" value={locale} onChange={(event) => setLocale(event.target.value as Locale)} className="h-9 max-w-28 rounded-md border bg-background px-2 text-sm">
    <option value="en">English</option>
    <option value="ar">العربية</option>
  </select>;
}
