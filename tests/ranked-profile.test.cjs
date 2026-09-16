const test = require('node:test');
const assert = require('node:assert/strict');
const {loadTypeScript}=require('./helpers/load-typescript.cjs');
const {readProfileRankedData,rankedCoreComplete,mergeRankedFallback,rankedSnapshot}=loadTypeScript('src/lib/ranked-data.ts');
const profile={rankedSeasonId:48,rankedRank:10,rankedRankName:'DIAMOND I',rankedElo:3417,highestSeasonRankedRank:11,highestSeasonRankedRankName:'DIAMOND II',highestSeasonRankedElo:3505,highestAllTimeRankedRank:13,highestAllTimeRankedRankName:'MYTHIC I',highestAllTimeRankedElo:4678};
const plain=v=>JSON.parse(JSON.stringify(v));

test('profile current, season best and all-time best remain independent',()=>{
 const data=readProfileRankedData(profile);assert.equal(rankedCoreComplete(data),true);
 assert.deepEqual(plain(data.fields),{rank_current:'Diamond I',rank_highest:'Mythic I',ranked_points:3417,ranked_all_time_best_points:4678,ranked_season_id:48,ranked_season_best:'Diamond II',ranked_season_best_points:3505});
});
test('historical rank names remain valid with zero Elo; missing is not Unranked',()=>{
 const data=readProfileRankedData({...profile,highestAllTimeRankedElo:0});assert.equal(data.fields.rank_highest,'Mythic I');assert.equal(data.fields.ranked_all_time_best_points,0);assert.equal(rankedCoreComplete(data),true);
 assert.deepEqual(plain(readProfileRankedData({}).fields),{});
 assert.equal(readProfileRankedData({rankedRank:0,rankedElo:0}).fields.rank_current,'Unranked');
 assert.equal(readProfileRankedData({highestAllTimeRankedRankName:'MASTERS',highestAllTimeRankedRank:19,highestAllTimeRankedElo:0}).fields.rank_highest,'Masters');
});
test('invalid values and unknown names cannot silently establish a rank',()=>{
 const data=readProfileRankedData({rankedRank:10,rankedRankName:'FUTURE TIER',rankedElo:-1,highestAllTimeRankedElo:Infinity,rankedSeasonId:'48',highestSeasonRankedRankName:'GOLD I'});
 assert.deepEqual(plain(data.fields),{});assert.equal(rankedCoreComplete(data),false);
 assert.equal(readProfileRankedData({rankedRank:999,rankedRankName:'DIAMOND I'}).fields.rank_current,'Diamond I');
 assert.equal(readProfileRankedData({rankedRank:10}).fields.rank_current,undefined);
});
test('RNT fills only missing current/all-time fields and cannot invent season best',()=>{
 const p=readProfileRankedData({rankedRankName:'DIAMOND I',rankedElo:3417});
 const data=mergeRankedFallback(p,{currentRank:'Bronze I',currentPoints:0,highestRank:'Mythic I',highestPoints:4678,available:true});
 assert.equal(data.fields.rank_current,'Diamond I');assert.equal(data.fields.ranked_points,3417);assert.equal(data.fields.rank_highest,'Mythic I');assert.equal(data.fields.ranked_season_best,undefined);
 const out=rankedSnapshot(data,'2026-09-16T12:00:00.000Z');assert.equal(out.ranked_source,'mixed');assert.equal(out.ranked_provenance.rank_current.source,'profile');assert.equal(out.ranked_provenance.rank_highest.source,'rnt');
});
test('failed fallback preserves valid partial evidence without claiming complete freshness',()=>{
 const p=readProfileRankedData({rankedRankName:'DIAMOND I',rankedElo:3417});const out=rankedSnapshot(mergeRankedFallback(p,{available:false}),'2026-09-16T12:00:00.000Z');
 assert.equal(out.rank_current,'Diamond I');assert.equal(out.rank_available,false);assert.equal(out.ranked_checked_at,undefined);assert.equal(out.ranked_source,undefined);assert.equal(Object.hasOwn(out,'rank_highest'),false);
});
test('public ranked provenance omits arbitrary private metadata',()=>{
 const {publicMemberSnapshot}=loadTypeScript('src/lib/sync-public-snapshots.ts');
 const result=publicMemberSnapshot({ranked_provenance:{rank_current:{source:'profile',checked_at:'2026-09-16T12:00:00.000Z',token:'secret'},notes:{source:'rnt',checked_at:'2026-09-16T12:00:00.000Z'},rank_highest:{source:'rnt',checked_at:'invalid'}},owner_user_id:'private'});
 assert.deepEqual(plain(result),{ranked_provenance:{rank_current:{source:'profile',checked_at:'2026-09-16T12:00:00.000Z'}}});
});
test('thirty valid profiles need zero RNT calls; sparse fallback starts after all profiles are fetched',async()=>{
 for(const missing of [[],['#P04','#P29']]){
  let fetched=0;const rankTags=[],calls=[];
  const tags=Array.from({length:30},(_,i)=>`#P${String(i).padStart(2,'0')}`);
  const db={from:table=>{const result={data:table==='settings'?[{key:'club_tag',value:'#CLUB'},{key:'api_key',value:'test-only'}]:[],error:null};const query={select:()=>query,eq:()=>query,in:()=>Object.assign(Promise.resolve(result),{abortSignal:async()=>result})};return query;},rpc:(name,args)=>{calls.push({name,args});if(name==='acquire_sync_run')return{data:{acquired:true,run_id:'run',fence:1}};if(name==='begin_sync_ranked_fallback')return{abortSignal:async()=>({data:args.p_player_tags})};if(name==='commit_sync_snapshot')return{data:{success:true}};throw Error(name);}};
  const api={getClub:async()=>({members:tags.map(tag=>({tag,name:tag,role:'member'}))}),getPlayer:async tag=>{fetched++;return{tag,name:tag,trophies:100,highestTrophies:100,expLevel:1,soloVictories:0,duoVictories:0,'3vs3Victories':0,brawlers:[],...(missing.includes(tag)?{}:profile)};},getPlayerBattleLog:async()=>({items:[]}),calculateWinRateFromBattleLog:()=>({winRate:null}),processBattleLog:()=>[],getPlayerRankedData:async tag=>{assert.equal(fetched,30);rankTags.push(tag);return{currentRank:'Gold I',highestRank:'Gold I',currentPoints:1500,highestPoints:1500,available:true};}};
  const service=loadTypeScript('src/lib/sync-service.ts',{'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/brawl-api':api},{setTimeout:fn=>{fn();return 0;}});
  await service.executeSync({source:'cron'});assert.deepEqual(rankTags,missing);
  const payload=calls.find(c=>c.name==='commit_sync_snapshot').args.p_payload;assert.equal(payload.ranked_complete,true);assert.equal(payload.ranked_attempted,missing.length>0);
 }
});
