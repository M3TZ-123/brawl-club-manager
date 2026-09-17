import { ar } from "./ar";
import { arExtra } from "./ar-extra";
import { arFeatures } from "./ar-features";
import { arGame } from "./ar-game";
import { arClubIntelligence } from "./ar-club-intelligence";
import { arClubAdministration } from "./ar-club-administration";
import { arClubPlanning } from "./ar-club-planning";
import { arClubRivals } from "./ar-club-rivals";
import arUx from "./ar-ux";
import arUxAnalytics from "./ar-ux-analytics";
import arUxPlanning from "./ar-ux-planning";
import arUxManagement from "./ar-ux-management";
import arMemberComparison from "./ar-member-comparison";
import arMegaPigSource from "./ar-mega-pig-source";
import arMegaPigArchive from "./ar-mega-pig-archive";
import { arHistory } from "./ar-history";
import { arAnalysis } from "./ar-analysis";
import { arAnalysisTeammates } from "./ar-analysis-teammates";

export type Locale = "en" | "ar";
export const intlLocale = (locale: Locale) => locale === "ar" ? "ar-TN" : "en-GB";

export function translate(text: string, locale: Locale, values: Record<string, string | number> = {}) {
  const key = text.trim();
  const message = locale === "ar" ? arAnalysis[key] || arAnalysisTeammates[key] || arHistory[key] || arMegaPigArchive[key] || arMegaPigSource[key] || arMemberComparison[key] || arUx[key] || arUxAnalytics[key] || arUxPlanning[key] || arUxManagement[key] || arClubIntelligence[key] || arClubAdministration[key] || arClubPlanning[key] || arClubRivals[key] || arFeatures[key] || arGame[key] || arExtra[key] || ar[key] || key : key;
  const translated = message.replace(/\{(\w+)\}/g, (match, name) => {
    const value = values[name];
    if (value === undefined) return match;
    return typeof value === "number" ? new Intl.NumberFormat(intlLocale(locale)).format(value) : value;
  });
  return `${text.startsWith(" ") ? " " : ""}${translated}${text.endsWith(" ") ? " " : ""}`;
}
