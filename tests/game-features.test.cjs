const test = require('node:test');
const assert = require('node:assert/strict');
const {loadTypeScript} = require('./helpers/load-typescript.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const game = loadTypeScript('src/lib/game-data.ts');
const recruitment = loadTypeScript('src/lib/recruitment-data.ts');

test('official rotation honors event mode IDs, UTC boundaries, and rejects invalid payloads',()=>{
  const rows=game.normalizeGameEvents([{slotId:39,startTime:'20260916T080000.000Z',endTime:'20260917T080000.000Z',event:{id:15001283,mode:'duoShowdown',modeId:38,map:'Doom Shroom'}}]);
  assert.equal(rows[0].mode,'trioShowdown');assert.equal(rows[0].startTime,'2026-09-16T08:00:00.000Z');
  assert.throws(()=>game.normalizeGameEvents({active:[],upcoming:[]}));
  assert.throws(()=>game.normalizeGameEvents([{slotId:1,startTime:'invalid',event:{}}]));
  assert.throws(()=>game.normalizeGameEvents([{slotId:1,startTime:'20260230T080000.000Z',endTime:'20260305T080000.000Z',event:{id:1,mode:'gemGrab',map:'Map'}}]));
  assert.equal(game.normalizeGameEvents([{slotId:1,startTime:'20260228T080000.125Z',endTime:'20260301T080000.000Z',event:{id:1,mode:'gemGrab',map:'Map'}}])[0].startTime,'2026-02-28T08:00:00.125Z');
  assert.deepEqual(plain(game.normalizeGameEvents([])),[]);
});
test('ranking cache keys are finite and official DTO strips unrelated data',()=>{
  assert.equal(game.gameRankingKey('TN','players'),'rankings:TN:players');
  for(const [region,kind] of [['../../players','players'],['zz','clubs'],['TN','brawlers'],['global','events']])assert.equal(game.gameRankingKey(region,kind),null);
  const rows=game.normalizeGameRankings({items:[{tag:'#PYLQ',name:'لاعب',trophies:50000,rank:1,club:{name:'نادي',secret:'private'},secret:'private'}]});
  assert.deepEqual(plain(rows),[{tag:'#PYLQ',name:'لاعب',trophies:50000,rank:1,memberCount:null,clubName:'نادي'}]);
  assert.throws(()=>game.normalizeGameRankings({items:[{tag:'#PYLQ',rank:1,trophies:NaN,name:'player'}]}));
});
test('recruitment validates strict tags, manual statuses, notes and revision without leaking arbitrary fields',()=>{
  assert.equal(recruitment.candidateTag(' pylq '),'#PYLQ');
  for(const tag of ['#ABC','../../secret','#','%23PYLQ',null]) assert.throws(()=>recruitment.candidateTag(tag));
  const value={player_tag:'PYLQ',status:'watching',notes:'  ملاحظة  ',version:0};
  assert.deepEqual(plain(recruitment.candidateInput(value)),{...value,player_tag:'#PYLQ',notes:'ملاحظة'});
  for(const update of [{version:-1},{notes:'x'.repeat(1001)},{status:'invite_now'},{secret:'value'}])assert.throws(()=>recruitment.candidateInput({...value,...update}));
});
test('candidate summary uses actual power and preserves unknown Ranked instead of fabricating Unranked',()=>{
  const source={tag:'#PYLQ',name:'candidate',trophies:0,highestTrophies:10,brawlers:[{power:11},{power:10}],private:'hidden'};
  const p=recruitment.candidateProfile(source,'#PYLQ');assert.equal(p.power11,1);assert.equal(p.rank,null);assert.equal(p.rankedPoints,null);assert.equal(p.trophies,0);assert.equal(p.private,undefined);
  assert.throws(()=>recruitment.candidateProfile(source,'#QQQQ'));
  assert.throws(()=>recruitment.candidateProfile({...source,brawlers:null},'#PYLQ'));
});

function cacheHarness({acquired=true,payload=null,fail=false,finish=true,expires=null}={}) {
  let upstream=0;const calls=[];
  const service=loadTypeScript('src/lib/game-cache.ts',{
    '@/lib/supabase-admin':{supabaseAdmin:{rpc:async(name,args)=>{calls.push({name,args});return name==='claim_game_cache'?{data:{acquired,entry:{payload,fetched_at:payload?'2026-09-16T00:00:00Z':null,expires_at:expires,lease_until:null}}}:{data:finish};}}},
    '@/lib/official-game-api':{officialGameRequest:async()=>{upstream++;if(fail)throw Error('secret request must never escape');return [];}}
  });return{service,calls,count:()=>upstream};
}
test('cache contention and provider failure serve known data without duplicate calls or false freshness',async()=>{
  const cached=[{slotId:1,id:1,map:'Known map',mode:'gemGrab',startTime:'2026-09-16T00:00:00.000Z',endTime:'2026-09-17T00:00:00.000Z'}];const contender=cacheHarness({acquired:false,payload:cached});
  assert.deepEqual(plain((await contender.service.loadGameData('events')).data),cached);assert.equal(contender.count(),0);
  const failure=cacheHarness({payload:cached,fail:true});const result=await failure.service.loadGameData('events');
  assert.equal(result.stale,true);assert.deepEqual(plain(result.data),cached);assert.equal(failure.calls.at(-1).args.p_payload,undefined);
  const lostLease=cacheHarness({finish:false});assert.equal((await lostLease.service.loadGameData('events')).data,null);
  const success=cacheHarness();assert.equal((await success.service.loadGameData('events')).stale,false);assert.equal(success.count(),1);
});

test('cached DTOs discard extra fields and invalid cache expiry cannot masquerade as fresh',async()=>{
  const cached=[{slotId:1,id:1,map:'Known map',mode:'gemGrab',startTime:'2026-09-16T00:00:00.000Z',endTime:'2026-09-17T00:00:00.000Z',secret:'PRIVATE'}];
  const result=await cacheHarness({acquired:false,payload:cached,expires:'invalid'}).service.loadGameData('events');
  assert.equal(result.stale,true);assert.equal(result.data[0].map,'Known map');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|secret/);
  const malformed=await cacheHarness({acquired:false,payload:[{secret:'PRIVATE'}],expires:'2999-01-01'}).service.loadGameData('events');
  assert.equal(malformed.data,null);assert.equal(malformed.stale,true);
  const rankings=game.projectGameSnapshot('players',[{tag:'#PYLQ',name:'Name',rank:1,trophies:10,memberCount:null,clubName:'Club',secret:'PRIVATE'}]);
  assert.equal(rankings[0].clubName,'Club');assert.doesNotMatch(JSON.stringify(rankings),/PRIVATE|secret/);
});

test('candidate refresh returns a concurrent saved notes revision instead of the pre-request snapshot',async()=>{
  const at='2026-09-16T00:00:00.000Z';let row={player_tag:'#PYLQ',status:'watching',notes:'old',version:1,created_at:at,updated_at:at,profile:null,profile_checked_at:null,private_future:'PRIVATE'};
  let reads=0;
  const service=loadTypeScript('src/lib/recruitment.ts',{
    '@/lib/supabase-admin':{supabaseAdmin:{from:()=>({select(){return this;},eq(){return this;},async maybeSingle(){reads++;return{data:structuredClone(row)};}}),rpc:async(name,args)=>{
      if(name==='claim_recruitment_refresh')return{data:true};
      if(name==='finish_recruitment_refresh'){row={...row,profile:args.p_profile,profile_checked_at:at};return{data:true};}
      throw Error('Unexpected RPC');
    }}},
    '@/lib/official-game-api':{officialGameRequest:async()=>{row={...row,notes:'new saved note',status:'shortlisted',version:2};return{tag:'#PYLQ',name:'Player',trophies:10,highestTrophies:20,brawlers:[{power:11}]};}}
  });
  const result=await service.refreshCandidate('PYLQ');assert.equal(result.refreshed,true);assert.equal(reads,2);assert.equal(result.candidate.version,2);assert.equal(result.candidate.notes,'new saved note');assert.equal(result.candidate.status,'shortlisted');assert.equal(result.candidate.profile.power11,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|private_future/);
});

test('supplemental official requests honor persisted cooldown and persist429 without exposing the bearer key',async()=>{
  const at=Date.now();let requests=0;const calls=[];
  const load=(cooldown='')=>loadTypeScript('src/lib/official-game-api.ts',{
    '@/lib/supabase-admin':{supabaseAdmin:{from:()=>({select(){return this;},in(){return this;},async abortSignal(){return{data:[{key:'api_key',value:'FAKE_TEST_KEY_ONLY'},{key:'sync_upstream_cooldown_until',value:cooldown}]};}}),rpc:async(name,args)=>{calls.push({name,args});return{data:null};}}}
  },{fetch:async()=>{requests++;return new Response('{}',{status:429,headers:{'Retry-After':'120'}});}});
  const paused=load(new Date(at+60000).toISOString());await assert.rejects(paused.officialGameRequest('/events/rotation'),error=>error.status===429);assert.equal(requests,0);
  const service=load();await assert.rejects(service.officialGameRequest('/events/rotation'),error=>error.message==='Game data temporarily unavailable'&&!String(error).includes('FAKE_TEST_KEY_ONLY'));
  assert.equal(requests,1);assert.equal(calls.length,1);assert.equal(calls[0].name,'defer_sync_upstream');assert.equal(calls[0].args.p_provider,'brawl');assert.ok(Date.parse(calls[0].args.p_until)>=at+120000);
  for(const path of ['/players/%23ABC','https://attacker.invalid','/rankings/zz/players?limit=50','/rankings/global/players?limit=500'])await assert.rejects(service.officialGameRequest(path),/Invalid official API path/);
  assert.equal(requests,1);
});
test('recruitment endpoints enforce authentication before database access and disable caching',async()=>{
  let reads=0,writes=0;
  const api=loadTypeScript('src/app/api/recruitment/route.ts',{
    'next/server':{NextResponse:{json:(body,init)=>new Response(JSON.stringify(body),init)}},
    '@/lib/admin-auth':{rejectUnauthorizedAdminRequest:()=>new Response('{}',{status:401}),rejectUnauthorizedAdminMutation:()=>new Response('{}',{status:403})},
    '@/lib/recruitment':{listCandidates:()=>reads++,saveCandidate:()=>writes++,refreshCandidate:()=>writes++}
  });
  for(const [method,status]of[['GET',401],['PATCH',403],['POST',403]]){const response=await api[method](new Request('https://app.test/api/recruitment'));assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('vary'),'Cookie');}
  assert.equal(reads+writes,0);
});
