"use client";
import { useI18n } from "@/components/locale-provider";

export function ClubTrendLine({points,label,rank=false}:{points:{at:string;value:number|null}[];label:string;rank?:boolean}) {
  const {number,date} = useI18n();
  const ordered=[...points].filter(p=>Number.isFinite(Date.parse(p.at))).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const known=ordered.filter((p):p is {at:string;value:number}=>p.value!==null&&Number.isFinite(p.value));
  if(known.length<2) return null;
  const min=Math.min(...known.map(p=>p.value)),max=Math.max(...known.map(p=>p.value)),span=max-min||1;
  const start=Date.parse(ordered[0].at),end=Date.parse(ordered.at(-1)!.at),timeSpan=end-start||1;
  const segments:string[]=[];let segment:string[]=[];
  for(const p of ordered){
    if(p.value===null||!Number.isFinite(p.value)){if(segment.length)segments.push(segment.join(" "));segment=[];continue;}
    const x=10+380*(Date.parse(p.at)-start)/timeSpan;
    const y=rank?12+76*(p.value-min)/span:88-76*(p.value-min)/span;
    segment.push(`${x},${y}`);
  }
  if(segment.length)segments.push(segment.join(" "));
  return <details className="text-sm"><summary className="cursor-pointer font-medium text-primary">{label}</summary><figure className="mt-2 space-y-1"><figcaption className="text-xs text-muted-foreground">{number(min)}–{number(max)}</figcaption><svg viewBox="0 0 400 100" role="img" aria-label={label} className="h-28 w-full text-primary" preserveAspectRatio="none"><path d="M10 90H390" stroke="currentColor" opacity="0.2"/>{segments.map((line,index)=><polyline key={index} points={line} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/>)}</svg><div className="flex justify-between text-xs text-muted-foreground"><span>{date(ordered[0].at)}</span><span>{date(ordered.at(-1)!.at)}</span></div></figure></details>;
}
