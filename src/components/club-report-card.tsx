"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import { ImageDown } from "lucide-react";
import { useI18n } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export type ReportCardData={generatedAt:string;period:{start:string;end:string};summary:{totalMembers:number;totalTrophies:number;weeklyBattles:number;weeklyWins:number;weeklyWinRate:number;trophyProgressKnownMembers?:number};topGainers?:{playerName:string;trophyChange:number}[]};
export function ClubReportCard({report}:{report:ReportCardData}){
  const {t,number,reportDate,locale,direction}=useI18n(),name=useAppStore(s=>s.clubName);
  const [error,setError]=useState(false),[busy,setBusy]=useState(false);
  const [preview,setPreview]=useState<{url:string;filename:string}|null>(null);
  useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview.url);},[preview]);
  async function download(){
    setBusy(true);setError(false);
    try{
      await document.fonts.ready;
      const canvas=document.createElement("canvas");canvas.width=1200;canvas.height=750;
      const ctx=canvas.getContext("2d");if(!ctx)throw new Error("canvas");
      ctx.fillStyle="#080e1d";ctx.fillRect(0,0,1200,750);
      ctx.fillStyle="#8255ef";ctx.fillRect(0,0,1200,12);
      ctx.direction=direction;ctx.textAlign=direction==="rtl"?"right":"left";
      const edge=direction==="rtl"?1136:64;
      const line=(text:string,y:number,size:number,color:string,max=1072)=>{ctx.font=`${size>=30?"bold ":""}${size}px Arial, sans-serif`;ctx.fillStyle=color;ctx.fillText(text,edge,y,max);};
      line(name||"BrawlStatz",94,44,"#ffffff");
      line(t("Club report card"),143,27,"#b9a2ff");
      line(`${reportDate(report.period.start)} — ${reportDate(report.period.end)} · UTC`,187,22,"#acbad0");
      const metrics=[[t("Roster members"),number(report.summary.totalMembers)],[t("Roster trophies"),number(report.summary.totalTrophies)],[t("Observed participations"),number(report.summary.weeklyBattles)],[t("Observed win share"),report.summary.weeklyBattles > 0 ? `${number(report.summary.weeklyWinRate)}%` : "—"]];
      metrics.forEach(([label,value],index)=>{
        const col=direction==="rtl"?1-index%2:index%2,x=64+col*550,y=235+Math.floor(index/2)*157;
        ctx.fillStyle="#131d31";ctx.fillRect(x,y,522,132);
        const tx=direction==="rtl"?x+490:x+32;
        ctx.font="20px Arial, sans-serif";ctx.fillStyle="#a9b9d0";ctx.fillText(label,tx,y+37,460);
        ctx.font="bold 38px Arial, sans-serif";ctx.fillStyle="#ffffff";ctx.fillText(value,tx,y+92,460);
      });
      const leader=report.topGainers?.find(member=>member.trophyChange>0);
      line(leader?t("Top observed gain: {name} · +{count}",{name:leader.playerName,count:number(leader.trophyChange)}):t("No positive trophy gain recorded for this period."),590,24,"#ffffff");
      line(t("Trophy progress coverage: {known}/{total} members",{known:report.summary.trophyProgressKnownMembers==null?t("Unknown"):number(report.summary.trophyProgressKnownMembers),total:number(report.summary.totalMembers)}),625,18,"#acbad0");
      line(t("Public report · no private notes"),674,20,"#acbad0");
      line(`${t("Updated")}: ${reportDate(report.generatedAt)} · brawlstatz.vercel.app`,712,18,"#8397b4");
      const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,"image/png"));if(!blob)throw new Error("image");
      setPreview({url:URL.createObjectURL(blob),filename:`club-report-${locale}-${report.period.end.slice(0,10)}.png`});
    }catch{setError(true);}finally{setBusy(false);}
  }
  return <div><Button variant="outline" disabled={busy} onClick={()=>void download()}><ImageDown className="w-4 h-4 me-2"/>{t("Download report image")}</Button>{error&&<p role="alert" className="text-sm text-amber-500">{t("Report image could not be created")}</p>}
    <Sheet open={preview!==null} onOpenChange={open=>{if(!open)setPreview(null);}}><SheetContent className="w-full overflow-y-auto sm:max-w-4xl">
      <SheetHeader><SheetTitle>{t("Club report card")}</SheetTitle><SheetDescription className="sr-only">{t("Preview the image, then save it to share.")}</SheetDescription></SheetHeader>
      {preview&&<div className="mt-5 space-y-4"><Image src={preview.url} alt={t("Club report card")} width={1200} height={750} unoptimized className="h-auto w-full rounded-lg border"/><a href={preview.url} download={preview.filename} className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">{t("Download PNG")}</a></div>}
    </SheetContent></Sheet>
  </div>;
}
