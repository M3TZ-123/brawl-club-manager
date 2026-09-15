import { ar } from "./ar";
import { arExtra } from "./ar-extra";

export type Locale = "en" | "ar";
export const intlLocale = (locale: Locale) => locale === "ar" ? "ar-TN" : "en-GB";

export function translate(text: string, locale: Locale, values: Record<string, string | number> = {}) {
  const key = text.trim();
  const message = locale === "ar" ? arExtra[key] || ar[key] || key : key;
  const translated = message.replace(/\{(\w+)\}/g, (match, name) => {
    const value = values[name];
    if (value === undefined) return match;
    return typeof value === "number" ? new Intl.NumberFormat(intlLocale(locale)).format(value) : value;
  });
  return `${text.startsWith(" ") ? " " : ""}${translated}${text.endsWith(" ") ? " " : ""}`;
}
