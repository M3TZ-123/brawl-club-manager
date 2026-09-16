const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');

function fixture(options = {}) {
  const calls = [];
  const now = Date.now();
  const settings = { club_tag: '#CLUB', api_key: 'private-test-key', sync_expected_interval_minutes: '10', sync_ranked_interval_minutes: '30', ...options.settings };
  const db = {
    from(table) {
      const query = { select() { return query; }, eq() { return query; },
        in: async () => ({ data: Object.entries(settings).map(([key,value]) => ({key,value})), error: null }),
        maybeSingle: async () => ({data: table === 'sync_runs' && options.previousScope ? {scope:options.previousScope} : null,error:null}) };
      return query;
    },
    async rpc(name,args) {
      calls.push({name,args});
      if (name === 'acquire_sync_run') return {data: options.replay || {acquired:true,run_id:'run-1',fence:2},error:null};
      if (name === 'commit_roster_snapshot' || name === 'commit_sync_snapshot') return {data:{success:true,runId:'run-1',timestamp:new Date(now).toISOString(),synced:1,scope:name === 'commit_roster_snapshot'?'roster':'full',warnings:args.p_payload.warnings||[]},error:null};
      if (name === 'defer_sync_upstream' || name === 'fail_sync_run') return {data:true,error:null};
      throw new Error('Unexpected RPC ' + name);
    },
  };
  const api = {
    async getClub(_tag,_key,_signal,deadlineAt) {calls.push({name:'club',deadlineAt});return {tag:'#CLUB',members:[{tag:'#PLAYER',name:'Player',role:'member',trophies:123,icon:{id:1}}],requiredTrophies:100};},
    async getPlayer() {calls.push({name:'player'});if(options.profileError)throw options.profileError;return {tag:'#PLAYER',name:'Player',trophies:123,highestTrophies:150,expLevel:10,brawlers:[],soloVictories:1,duoVictories:2,'3vs3Victories':3};},
    async getPlayerBattleLog() {calls.push({name:'battles'});if(options.battleError)throw options.battleError;return {items:[]};},
    async getPlayerRankedData() {calls.push({name:'ranked'});return options.rank || {currentRank:'Gold I',highestRank:'Gold II',currentPoints:1500,highestPoints:1800,available:true};},
    processBattleLog:()=>[],calculateWinRateFromBattleLog:()=>({winRate:null}),
  };
  const service=loadTypeScript('src/lib/sync-service.ts',{'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/brawl-api':api,'@/lib/upstream-rate-limit':{getUpstreamCooldownMs:()=>0}},{console:{error(){},warn(){},log(){}}});
  return {service,calls,now};
}

test('roster sync requests only the club and never constructs an incomplete full snapshot',async()=>{
  const f=fixture();const result=await f.service.executeSync({source:'cron',scope:'roster'});
  assert.equal(result.scope,'roster');
  assert.deepEqual(f.calls.map(call=>call.name),['acquire_sync_run','club','commit_roster_snapshot']);
  assert.equal(f.calls[0].args.p_scope,'roster');
  const payload=f.calls.at(-1).args.p_payload;
  assert.equal(payload.members[0].trophies,123);
  assert.equal(Object.hasOwn(payload,'brawlers'),false);
  assert.equal(Object.hasOwn(payload.members[0],'highest_trophies'),false);
  assert.ok(f.calls[1].deadlineAt>=f.now+44000);
});

test('automatic scope uses full age, allows cron completion time, and preserves an original retry scope',async()=>{
  const f=fixture({settings:{last_full_sync_time:new Date().toISOString()}});
  assert.equal(f.service.selectScheduledScope({},f.now),'full');
  assert.equal(f.service.selectScheduledScope({last_full_sync_time:new Date(f.now-120000).toISOString()},f.now),'roster');
  assert.equal(f.service.selectScheduledScope({last_full_sync_time:new Date(f.now-595000).toISOString()},f.now),'full');
  await f.service.executeSync({source:'cron',scope:'auto',idempotencyKey:'bucket'});
  assert.equal(f.calls[0].args.p_scope,'roster');
  const replay=fixture({settings:{last_full_sync_time:new Date().toISOString()},previousScope:'full',replay:{acquired:false,replayed:true,status:'succeeded',result:{success:true,scope:'full',runId:'prior'}}});
  const result=await replay.service.executeSync({source:'cron',scope:'auto',idempotencyKey:'bucket'});
  assert.equal(replay.calls[0].args.p_scope,'full');assert.equal(result.runId,'prior');assert.equal(replay.calls.length,1);
});

test('full sync skips fresh ranked data and cannot advance its completeness marker',async()=>{
  const f=fixture({settings:{last_ranked_sync_time:new Date().toISOString()}});
  await f.service.executeSync({source:'cron'});
  assert.equal(f.calls.some(call=>call.name==='ranked'),false);
  const payload=f.calls.find(call=>call.name==='commit_sync_snapshot').args.p_payload;
  assert.equal(payload.ranked_complete,false);assert.equal(payload.battle_logs_complete,true);assert.deepEqual([...payload.warnings],[]);
});

test('ranked completion time does not delay a thirty-minute refresh until minute forty',async()=>{
  const f=fixture({settings:{last_ranked_sync_time:new Date(Date.now()-29*60000-40000).toISOString()}});
  await f.service.executeSync({source:'cron'});
  assert.equal(f.calls.filter(call=>call.name==='ranked').length,1);
  const payload=f.calls.find(call=>call.name==='commit_sync_snapshot').args.p_payload;
  assert.equal(payload.ranked_complete,true);assert.equal(payload.members[0].rank_available,true);
});

test('a partial battle update saves the shared cooldown and reports reduced completeness',async()=>{
  const f=fixture({battleError:{status:429,retryAfterMs:120000}});
  const result=await f.service.executeSync({source:'cron'});
  const deferred=f.calls.find(call=>call.name==='defer_sync_upstream');
  assert.equal(deferred.args.p_provider,'brawl');assert.ok(Date.parse(deferred.args.p_until)>=f.now+119000);
  const commit=f.calls.find(call=>call.name==='commit_sync_snapshot');
  assert.equal(commit.args.p_payload.battle_logs_complete,false);assert.equal(commit.args.p_payload.ranked_complete,true);
  assert.deepEqual([...result.warnings],['battle_logs_rate_limited']);
});

test('a persisted game cooldown prevents all upstream requests',async()=>{
  const f=fixture({settings:{sync_upstream_cooldown_until:new Date(Date.now()+120000).toISOString()}});
  await assert.rejects(f.service.executeSync({source:'cron'}),error=>error.code==='upstream_rate_limited'&&error.status===429&&error.retryAfterSeconds>=119);
  assert.equal(f.calls.some(call=>['club','player','battles','ranked'].includes(call.name)),false);
  assert.equal(f.calls.at(-1).name,'fail_sync_run');
});

test('mandatory rate failures cannot commit a snapshot or expose upstream error text',async()=>{
  const f=fixture({profileError:{status:429,retryAfterMs:180000,message:'private-test-key'}});
  await assert.rejects(f.service.executeSync({source:'cron'}),error=>error.code==='upstream_rate_limited'&&error.retryAfterSeconds===180&&!error.message.includes('private-test-key'));
  assert.equal(f.calls.some(call=>call.name==='commit_sync_snapshot'),false);
  assert.equal(f.calls.at(-1).args.p_error_code,'upstream_rate_limited');
});

test('ranked cooldown preserves game updates and does not call the ranked provider',async()=>{
  const f=fixture({settings:{sync_ranked_cooldown_until:new Date(Date.now()+180000).toISOString()}});
  const result=await f.service.executeSync({source:'cron'});
  assert.equal(f.calls.some(call=>call.name==='ranked'),false);
  const payload=f.calls.find(call=>call.name==='commit_sync_snapshot').args.p_payload;
  assert.equal(payload.ranked_complete,false);assert.equal(payload.battle_logs_complete,true);
  assert.deepEqual([...result.warnings],['ranked_rate_limited']);
});

test('the HTTP route passes adaptive scope only after authentication and returns Retry-After',async()=>{
  const {NextRequest}=require('next/server');let received;let allowed=false;
  class SyncError extends Error {constructor(){super('Cooldown');this.status=429;this.code='upstream_rate_limited';this.retryAfterSeconds=120;}}
  const route=loadTypeScript('src/app/api/sync/route.ts',{
    '@/lib/scheduler-auth':{isAuthorizedSchedulerRequest:async()=>allowed},
    '@/lib/admin-auth':{rejectUnauthorizedAdminRequest:()=>Response.json({error:'Unauthorized'},{status:401}),rejectUnauthorizedAdminMutation:()=>null},
    '@/lib/sync-service':{SyncError,executeSync:async options=>{received=options;throw new SyncError();}},
  });
  const request=new NextRequest('https://example.com/api/sync?mode=auto',{headers:{'Idempotency-Key':'cron-bucket'}});
  assert.equal((await route.GET(request)).status,401);assert.equal(received,undefined);
  allowed=true;const result=await route.GET(request);
  assert.equal(received.scope,'auto');assert.equal(received.idempotencyKey,'cron-bucket');
  assert.equal(result.status,429);assert.equal(result.headers.get('Retry-After'),'120');
});
