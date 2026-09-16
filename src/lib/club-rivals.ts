import "server-only";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { officialGameRequest } from "@/lib/official-game-api";
import { loadGameData } from "@/lib/game-cache";
import { clubTagInput, normalizeRivalProfile, projectRivalProfile, RivalInputError, type RivalSnapshot, type ClubRivalsResponse, type ClubRankObservation } from "@/lib/club-rivals-data";
import type { GameRegion } from "@/lib/game-data";

const pending = new Map<string, Promise<RivalSnapshot>>();
export async function managedClubTag() {
  const {data,error} = await supabaseAdmin.from("settings").select("value").eq("key","club_tag").maybeSingle();
  if (error) throw new Error("Club comparison unavailable");
  return clubTagInput(data?.value || process.env.CLUB_TAG || "");
}
async function readRival(club: string, tag: string): Promise<RivalSnapshot> {
  const token = randomUUID();
  const {data: claim,error} = await supabaseAdmin.rpc("claim_club_rival",{p_club:club,p_tag:tag,p_token:token});
  if (error || !claim?.entry) throw new Error("Club comparison unavailable");
  const row = claim.entry;
  let profile = null;
  try { if (row.profile) profile = projectRivalProfile(row.profile,tag); } catch { /* Invalid cache is not exposed. */ }
  let fetchedAt = profile && Number.isFinite(Date.parse(row.fetched_at)) ? new Date(row.fetched_at).toISOString() : null;
  let stale = !profile || !fetchedAt || !(Date.parse(row.expires_at)>Date.now());
  if (claim.acquired) {
    try {
      const fresh = normalizeRivalProfile(await officialGameRequest(`/clubs/${encodeURIComponent(tag)}`),tag);
      const committed = await supabaseAdmin.rpc("finish_club_rival",{p_club:club,p_tag:tag,p_token:token,p_profile:fresh});
      if (committed.error || committed.data !== true) throw new Error("Rival refresh not committed");
      profile=fresh;fetchedAt=new Date().toISOString();stale=false;
    } catch {
      await supabaseAdmin.rpc("finish_club_rival",{p_club:club,p_tag:tag,p_token:token});
    }
  }
  const history = await supabaseAdmin.from("club_rival_snapshots").select("observed_at,trophies,member_count").eq("club_tag",club).eq("rival_tag",tag).gte("day",new Date(Date.now()-90*86400000).toISOString().slice(0,10)).order("day",{ascending:false}).limit(91);
  if (history.error) throw new Error("Club comparison unavailable");
  return {tag,profile,fetchedAt,stale,refreshing:!claim.acquired && Date.parse(row.lease_until)>Date.now(),history:(history.data||[]).map(r=>({at:r.observed_at,trophies:Number(r.trophies),memberCount:Number(r.member_count)}))};
}
function sharedRival(club:string,tag:string) {
  const key=`${club}:${tag}`, previous=pending.get(key);
  if (previous) return previous;
  const result=readRival(club,tag).finally(()=>pending.delete(key));pending.set(key,result);return result;
}
export async function loadClubRivals(region: GameRegion): Promise<ClubRivalsResponse> {
  const club=await managedClubTag();
  const list=await supabaseAdmin.from("club_rivals").select("rival_tag").eq("club_tag",club).eq("active",true).order("updated_at",{ascending:true}).limit(5);
  if(list.error) throw new Error("Club comparison unavailable");
  const tags=(list.data||[]).map(row=>clubTagInput(row.rival_tag));
  const [rivalResults,ranking] = await Promise.all([
    Promise.allSettled(tags.map(tag=>sharedRival(club,tag))),
    loadGameData("clubs",region).catch(()=>null),
  ]);
  const ranks=await supabaseAdmin.from("club_rank_history").select("observed_tag,region,observed_at,rank,trophies").eq("club_tag",club).eq("region",region).in("observed_tag",[club,...tags]).gte("day",new Date(Date.now()-90*86400000).toISOString().slice(0,10)).order("day",{ascending:false}).limit(546);
  if(ranks.error) throw new Error("Club comparison unavailable");
  return {clubTag:club,region,rivals:rivalResults.map((result,index)=>result.status==="fulfilled"?result.value:{tag:tags[index],profile:null,fetchedAt:null,stale:true,refreshing:false,history:[]}),
    ranks:(ranks.data||[]).map((r):ClubRankObservation=>({tag:clubTagInput(r.observed_tag),region,at:r.observed_at,rank:r.rank,trophies:r.trophies==null?null:Number(r.trophies)})),rankingAt:ranking?.fetchedAt||null,rankingStale:ranking?.stale??true};
}
export async function saveClubRival(body: unknown) {
  if(!body || typeof body!=="object" || Array.isArray(body) || Object.keys(body).some(key=>!["tag","active"].includes(key))) throw new RivalInputError("Invalid club selection");
  const input=body as {tag:unknown;active:unknown},tag=clubTagInput(input.tag),club=await managedClubTag();
  if(typeof input.active!=="boolean" || club===tag) throw new RivalInputError("Choose another club to compare");
  const saved=await supabaseAdmin.rpc("save_club_rival",{p_club:club,p_tag:tag,p_active:input.active});
  if(saved.error?.code==="54000") throw new RivalInputError("You can follow five clubs. Remove one before adding another.",409);
  if(saved.error) throw new Error("Club comparison unavailable");
  return {saved:true};
}
