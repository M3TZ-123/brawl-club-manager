"use client";
import Link from "next/link";
import { useI18n } from "@/components/locale-provider";
import { useFeatureResource } from "@/components/use-feature-resource";
import type { PublicJoinInfo } from "@/lib/club-administration-data";
export function ClubJoinSummary(){
  const {t,number}=useI18n(),{data,error}=useFeatureResource<PublicJoinInfo>("/api/join","settings");
  return <section className="rounded-xl border bg-card p-5 space-y-3"><h2 className="text-xl font-semibold">{t("Join the club")}</h2>{data?<><p className={data.recruitment_open?"text-emerald-500":"text-muted-foreground"}>{t(data.recruitment_open?"Applications open":"Applications closed")}</p><dl className="space-y-2 text-sm"><div className="flex justify-between gap-3"><dt>{t("Application trophy requirement")}</dt><dd>{number(data.min_trophies)}</dd></div><div className="flex justify-between gap-3"><dt>{t("Minimum Power 11 brawlers")}</dt><dd>{number(data.min_power11)}</dd></div>{data.min_ranked_points!==null&&<div className="flex justify-between gap-3"><dt>{t("Minimum ranked points")}</dt><dd>{number(data.min_ranked_points)}</dd></div>}{data.language&&<div><dt className="text-muted-foreground">{t("Language")}</dt><dd className="break-words">{data.language}</dd></div>}{data.availability&&<div><dt className="text-muted-foreground">{t("Preferred play times")}</dt><dd className="break-words">{data.availability}</dd></div>}</dl><Link href="/join" className="inline-block text-primary underline underline-offset-4">{t("View club application")}</Link></>:<p className="text-sm text-muted-foreground">{t(error?"Applications are temporarily unavailable.":"Loading...")}</p>}</section>;
}
