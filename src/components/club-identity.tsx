"use client";
import Link from "next/link";
import { useI18n } from "@/components/locale-provider";
import { ClubIntelligencePanel, useClubIntelligence } from "@/components/club-intelligence-panel";
import type { ClubMetadata } from "@/lib/club-intelligence-types";
const fields: Record<keyof ClubMetadata, string> = { name: "Club name", description: "Club description", type: "Admission type", badgeId: "Badge", requiredTrophies: "Required trophies" };

export function ClubIdentity({ showHistory = false }: { showHistory?: boolean }) {
  const resource = useClubIntelligence(), data = resource.data;
  const { t, number, dateTime } = useI18n();
  const metadataValue = (key: keyof ClubMetadata, value: ClubMetadata[keyof ClubMetadata]) => value === undefined ? t("Unknown")
    : typeof value === "number" ? number(value) : value === "" ? t("Empty") : key === "type" ? t(value) : value;
  return <ClubIntelligencePanel title="About the club" resource={resource}>{data && <>
    {data.club.metadata ? <><div><p className="text-xl font-semibold">{data.club.metadata.name || data.club.tag}</p><p className="text-xs text-muted-foreground" dir="ltr">{data.club.tag}</p>{data.club.metadata.description !== undefined && <p className="mt-2 whitespace-pre-wrap break-words text-sm">{data.club.metadata.description || t("No club description")}</p>}</div>
      <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-muted-foreground">{t("Admission type")}</dt><dd>{t(data.club.metadata.type || "Unknown")}</dd></div><div><dt className="text-muted-foreground">{t("Required trophies")}</dt><dd>{data.club.metadata.requiredTrophies === undefined ? t("Unknown") : number(data.club.metadata.requiredTrophies)}</dd></div><div><dt className="text-muted-foreground">{t("Members")}</dt><dd>{number(data.club.memberCount)} / {number(30)}</dd></div><div><dt className="text-muted-foreground">{t("Open seats")}</dt><dd>{number(data.club.openSeats)}</dd></div></dl>
      <ul className="flex flex-wrap gap-2 text-sm">{data.club.leaders.map(member => <li key={member.tag}><Link href={`/members/${encodeURIComponent(member.tag)}`} className="hover:text-primary">{member.name}</Link> <span className="text-xs text-muted-foreground">{t(member.role)}</span></li>)}</ul>
      <p className="text-xs text-muted-foreground">{t("Club profile observed")}: {dateTime(data.club.observedAt)}</p>
    </> : <p className="text-sm text-muted-foreground">{t("Club details will appear after the next accepted roster observation.")}</p>}
    {showHistory && <details className="border-t pt-3 text-sm"><summary className="cursor-pointer text-primary">{t("Club settings history")}</summary><ul className="mt-3 max-h-80 space-y-4 overflow-auto">{data.metadataHistory.map(event => <li key={event.id}><p className="text-xs text-muted-foreground">{dateTime(event.observedAt)} · {t(event.before ? "Observed change" : "First observed")}</p><dl>{event.changedFields.map(rawKey => {
      const key = rawKey as keyof ClubMetadata;
      return <div key={key} className="mt-1"><dt className="font-medium">{t(fields[key])}</dt><dd className="whitespace-pre-wrap break-words text-muted-foreground">
        {key === "badgeId" ? t(event.before ? "Club badge changed" : "Club badge first observed")
          : <>{event.before ? `${metadataValue(key, event.before[key])} → ` : ""}{metadataValue(key, event.after[key])}</>}
      </dd></div>;
    })}</dl></li>)}</ul>{!data.metadataHistory.length && <p className="mt-2 text-muted-foreground">{t("No club setting changes recorded yet.")}</p>}</details>}
  </>}</ClubIntelligencePanel>;
}
