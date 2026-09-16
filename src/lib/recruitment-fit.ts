import type { Candidate } from "@/lib/recruitment-data";
import type { PublicJoinInfo } from "@/lib/club-administration-data";
export function recruitmentFit(candidate:Candidate,criteria:PublicJoinInfo){
  const measured=(value:number|null|undefined,min:number|null)=>min==null||min===0?"not_required":value==null?"unknown":value>=min?"met":"not_met";
  const manual=(required:string,value:string|undefined)=>!required?"not_required":value==="compatible"?"met":value==="incompatible"?"not_met":"unknown";
  return [
    {key:"trophies",label:"Trophies",status:measured(candidate.profile?.trophies,criteria.min_trophies)},
    {key:"power11",label:"Power 11 brawlers",status:measured(candidate.profile?.power11,criteria.min_power11)},
    {key:"ranked",label:"Ranked points",status:measured(candidate.profile?.rankedPoints,criteria.min_ranked_points)},
    {key:"language",label:"Language compatibility",status:manual(criteria.language,candidate.manual_compatibility?.language)},
    {key:"time",label:"Playing-time compatibility",status:manual(criteria.availability,candidate.manual_compatibility?.time)},
  ];
}
