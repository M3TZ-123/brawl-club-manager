const test=require('node:test');const assert=require('node:assert/strict');
const {loadTypeScript}=require('./helpers/load-typescript.cjs');
const data=loadTypeScript('src/lib/club-rivals-data.ts');
const profile={tag:'#PYLQ',name:'نادي',description:'public',type:'inviteOnly',badgeId:1,trophies:120,requiredTrophies:10,members:[{tag:'#PYY',trophies:11},{tag:'#PQQ',trophies:20},{tag:'#PGG',trophies:50},{tag:'#PVV',trophies:39}],secret:'PRIVATE'};
test('rival comparison derives median and sum from complete roster, distinct from reported aggregate',()=>{
  const p=data.normalizeRivalProfile({...profile,trophies:999},'#PYLQ');
  assert.equal(p.medianTrophies,29.5);assert.equal(p.rosterTrophies,120);assert.equal(p.trophies,999);assert.equal(p.memberCount,4);assert.equal(p.averageTrophies,30);assert.equal(p.secret,undefined);assert.equal(p.members,undefined);
  const projected=data.projectRivalProfile({...p,lease_token:'SECRET',notes:'PRIVATE'},'#PYLQ');assert.equal(projected.lease_token,undefined);assert.equal(projected.notes,undefined);
});
test('invalid, truncated and mismatched club responses cannot replace the known snapshot',()=>{
  for(const update of [{tag:'#QQQQ'},{members:null},{members:Array(31).fill(profile.members[0])},{members:[profile.members[0],profile.members[0]]},{members:[{tag:'#PYY',trophies:-1}]},{requiredTrophies:'1'},{name:'x'.repeat(161)}])assert.throws(()=>data.normalizeRivalProfile({...profile,...update},'#PYLQ'));
  const empty=data.normalizeRivalProfile({...profile,members:[]},'#PYLQ');assert.equal(empty.medianTrophies,null);assert.equal(empty.rosterTrophies,0);
  assert.throws(()=>data.projectRivalProfile({...data.normalizeRivalProfile(profile,'#PYLQ'),medianTrophies:NaN},'#PYLQ'));
  for(const value of ['../../foo','#ABC',null,'#'])assert.throws(()=>data.clubTagInput(value));
  assert.equal(data.clubTagInput(' %23pylq '),'#PYLQ');assert.throws(()=>data.rivalRegion('unknown'));
});
function harness({cached=false,acquired=true,fail=false}={}){
  const calls=[];let upstream=0;const p=data.normalizeRivalProfile(profile,'#PYLQ');
  const db={from(table){const q={select(){return q},eq(){return q},in(){return q},gte(){return q},order(){return q},limit(){return q},maybeSingle(){return Promise.resolve({data:{value:'#QQQQ'}})},then(ok,bad){return Promise.resolve({data:table==='club_rivals'?[{rival_tag:'#PYLQ'}]:[]}).then(ok,bad)}};return q},async rpc(name,args){calls.push({name,args});return name==='claim_club_rival'?{data:{acquired,entry:{profile:cached?p:null,fetched_at:cached?'2026-09-16T00:00:00Z':null,expires_at:'2020-01-01T00:00:00Z'}}}:{data:true}}};
  const service=loadTypeScript('src/lib/club-rivals.ts',{'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/official-game-api':{officialGameRequest:async path=>{upstream++;assert.equal(path,'/clubs/%23PYLQ');await new Promise(r=>setTimeout(r,15));if(fail)throw Error('secret');return profile}},'@/lib/game-cache':{loadGameData:async()=>({fetchedAt:null,stale:true})}});
  return{service,calls,count:()=>upstream};
}
test('concurrent comparison requests share one refresh and upstream failures preserve cached data',async()=>{
  const h=harness();const results=await Promise.all([h.service.loadClubRivals('global'),h.service.loadClubRivals('global')]);
  assert.equal(h.count(),1);assert.equal(results[0].rivals[0].stale,false);assert.equal(results[1].rivals[0].profile.name,'نادي');
  const failed=harness({cached:true,fail:true});const row=(await failed.service.loadClubRivals('global')).rivals[0];assert.equal(row.stale,true);assert.equal(row.profile.name,'نادي');assert.equal(failed.calls.at(-1).args.p_profile,undefined);
  const locked=harness({cached:true,acquired:false});await locked.service.loadClubRivals('global');assert.equal(locked.count(),0);
});
test('rival mutation rejects unknown fields and selecting the managed club before RPC',async()=>{
  const h=harness();await assert.rejects(h.service.saveClubRival({tag:'#QQQQ',active:true}),/another club/);await assert.rejects(h.service.saveClubRival({tag:'#PYLQ',active:true,url:'https://invalid'}),/Invalid club/);assert.equal(h.calls.length,0);
});
