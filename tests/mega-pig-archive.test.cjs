const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const cycleId = '00000000-0000-4000-8000-000000000039';
const readingId = '00000000-0000-4000-8000-000000000040';
const now = '2026-09-17T12:00:00.000Z';
const cycleRow = (extra = {}) => ({ id: cycleId, club_tag: '#PYLQ', title: 'September', starts_at: '2026-09-04T08:00:00Z', ends_at: '2026-09-07T08:00:00Z',
  milestones: [16, 32, 48, 64, 80], version: 1, created_at: now, updated_at: now, capture_enabled: false, capture_paused_reason: null,
  initial_observation_id: readingId, last_captured_at: now, reported_total_wins: 82, reported_players_played: 24,
  final_total_wins: null, confirmed_stage: null, reward_status: 'unknown', finalized_at: null, notes: 'ملاحظة الدورة',
  create_payload_hash: 'PRIVATE HASH', ...extra });
const memberRow = (extra = {}) => ({ cycle_id: cycleId, player_tag: '#PYLR', player_name: 'عضو سابق', is_current_member: false,
  first_observed_at: now, last_observed_at: now, wins: 4, tickets_remaining: 0, wins_observed_at: now, tickets_observed_at: now,
  latest_wins_unknown: true, latest_tickets_unknown: false, internal_data: 'PRIVATE INTERNAL', ...extra });
const summary = (extra = {}) => ({ id: readingId, club_tag: '#PYLQ', first_fetched_at: now, last_fetched_at: now,
  total_wins: 4, reported_players_played: 1, source_members: 1, unknown_members: 0, ...extra });
const creation = (extra = {}) => ({ action: 'save_cycle', id: null, version: 0, requestId: cycleId, cycle: {
  title: 'دورة سبتمبر', startsAt: '2026-09-04T08:00:00Z', endsAt: '2026-09-07T08:00:00Z', milestones: [16,32,48,64,80],
  captureEnabled: true, initialObservationId: readingId, notes: '', ...extra,
} });
const next = { NextResponse: { json: Response.json } };
const globals = { process: { env: { ADMIN_PASSWORD: 'test-password', ADMIN_SESSION_SECRET: 'test-secret', NODE_ENV: 'test' } } };
const { createAdminSessionToken } = loadTypeScript('src/lib/admin-auth.ts', { 'next/server': next }, globals);
function request(query = '', input, options = {}) {
  const headers = { host: 'club.test', origin: options.origin || 'https://club.test', 'content-type': 'application/json', ...options.headers };
  if (options.admin !== false) headers.cookie = `brawlstatz_admin=${createAdminSessionToken()}`;
  return new Request(`https://club.test/api/mega-pig-archive${query}`, { method: input === undefined ? 'GET' : 'POST', headers,
    ...(input === undefined ? {} : { body: typeof input === 'string' ? input : JSON.stringify(input) }) });
}
function fixture() {
  const state = { calls: [], before: 0, after: 0, clubChanged: false, error: null, data: { cycles: [cycleRow()], next_offset: null, observation_count: 1, latest_observation: summary() } };
  class ClubRosterUnavailableError extends Error {}
  const api = loadTypeScript('src/app/api/mega-pig-archive/route.ts', { 'next/server': next,
    '@/lib/accepted-club-roster': { ClubRosterUnavailableError, requireAcceptedClubRoster: async () => { state.before++; return '#PYLQ'; },
      assertAcceptedClubRoster: async () => { state.after++; if (state.clubChanged) throw new ClubRosterUnavailableError('Club changed'); } },
    '@/lib/supabase-admin': { supabaseAdmin: { rpc: (name, args) => ({ abortSignal(signal) { assert.ok(signal); state.calls.push({ name, args }); return Promise.resolve({ data: state.data, error: state.error }); } }) } },
  }, globals);
  return { api, state };
}

test('archive authentication and cross-origin checks precede any private storage access', async () => {
  const { api, state } = fixture();
  assert.equal((await api.GET(request('', undefined, { admin: false }))).status, 401);
  assert.equal((await api.POST(request('', creation(), { admin: false }))).status, 401);
  assert.equal((await api.POST(request('', creation(), { origin: 'https://evil.invalid' }))).status, 403);
  assert.equal(state.before, 0); assert.equal(state.calls.length, 0);
});

test('archive query contract rejects scope overrides, duplicate parameters and unbounded requests', async () => {
  for (const query of ['?club=%23OTHER','?force=1','?mode=unknown','?mode=cycle','?mode=cycles&id='+cycleId,'?mode=player&player=%23BADTAG','?offset=-1','?offset=1000001','?offset=0&offset=20','?mode=reading&id='+readingId+'&offset=20']) {
    const { api, state } = fixture(); assert.equal((await api.GET(request(query))).status,400,query); assert.equal(state.calls.length,0);
  }
});

test('archive cycle lists are scoped, paginated, private and strip storage-only fields', async () => {
  const { api, state } = fixture(); const response=await api.GET(request('?offset=20')); const value=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('vary'),'Cookie');
  assert.equal(state.calls[0].args.p_club,'#PYLQ');assert.equal(state.calls[0].args.p_offset,20);assert.equal(state.after,1);
  assert.equal(value.cycles[0].reportedTotalWins,82);assert.equal(value.cycles[0].finalTotalWins,null);assert.equal(value.cycles[0].rewardStatus,'unknown');
  assert.deepEqual(value.cycles[0].milestones,[16,32,48,64,80]);assert.equal(value.cycles[0].initialObservationId,readingId);
  assert.equal(value.latestObservation.source,'BrawlAce');assert.equal(value.latestObservation.reportedBattlesPlayed,null);
  assert.equal(value.cycles[0].notes,'ملاحظة الدورة');assert.doesNotMatch(JSON.stringify(value),/PRIVATE HASH|create_payload_hash/);
});

test('archived leavers retain their last known counters and evidence of newer unknown values', async () => {
  const {api,state}=fixture();state.data={cycle:cycleRow(),members:[memberRow()],next_offset:50,latest_observation:summary()};
  const value=await(await api.GET(request('?mode=cycle&id='+cycleId))).json();
  assert.equal(value.members[0].isCurrentMember,false);assert.equal(value.members[0].wins,4);assert.equal(value.members[0].latestWinsUnknown,true);
  assert.equal(value.members[0].ticketsRemaining,0);assert.equal(value.members[0].winsObservedAt,now);assert.equal(value.nextOffset,50);
  assert.equal(value.latestObservation.id,readingId);
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE INTERNAL|internal_data/);
});

test('a returning-player lookup searches retained cycle records by exact player tag', async () => {
  const {api,state}=fixture();state.data={player_tag:'#PYLR',history:[{cycle:cycleRow(),member:memberRow()}],player_readings:[{observation:summary(),member:{playerTag:'#PYLR',playerName:'اسم قديم',reportedWins:4,reportedTicketsRemaining:0}}],next_offset:null};
  const value=await(await api.GET(request('?mode=player&player=pylr'))).json();
  assert.equal(value.playerTag,'#PYLR');assert.equal(value.history[0].member.wins,4);assert.equal(state.calls[0].args.p_player,'#PYLR');
  assert.equal(value.playerReadings[0].member.playerName,'اسم قديم');assert.equal(value.playerReadings[0].member.reportedWins,4);
});

test('saved readings work without a cycle, preserve unknown timestamps and never infer zero', async () => {
  const {api,state}=fixture();state.data={observation:summary({first_fetched_at:null,last_fetched_at:null,unknown_members:1,
    payload:{clubTag:'#PYLQ',totalWins:4,reportedPlayersPlayed:1,members:[{playerTag:'#PYLR',playerName:'سابق',reportedWins:null,reportedTicketsRemaining:null,online:true}]}})};
  const response=await api.GET(request('?mode=reading&id='+readingId)),value=await response.json();assert.equal(response.status,200);
  assert.equal(value.observation.firstFetchedAt,null);assert.equal(value.observation.members[0].reportedWins,null);assert.equal(value.observation.totalWins,4);
  assert.doesNotMatch(JSON.stringify(value),/online/);
});

test('BrawlTools archive readings retain source and match totals without inventing participant counts or cycle metadata', async () => {
  const {api,state}=fixture();state.data={observation:summary({source:'BrawlTools',reported_players_played:null,reported_battles_played:128,
    payload:{clubTag:'#PYLQ',source:'BrawlTools',totalWins:4,reportedPlayersPlayed:null,reportedBattlesPlayed:128,
      id:1,timestamp:1789749903,members:[{playerTag:'#PYLR',playerName:'عضو',reportedWins:4,reportedTicketsRemaining:0}]}})};
  const response=await api.GET(request('?mode=reading&id='+readingId)),value=await response.json();assert.equal(response.status,200);
  assert.equal(value.observation.source,'BrawlTools');assert.equal(value.observation.reportedPlayersPlayed,null);
  assert.equal(value.observation.reportedBattlesPlayed,128);assert.equal(value.observation.members[0].reportedTicketsRemaining,0);
  assert.equal(value.observation.id,readingId);assert.doesNotMatch(JSON.stringify(value),/timestamp|1789749903/);
});

test('source changes remain a paused cycle awaiting an explicitly confirmed reading', async () => {
  const {api,state}=fixture();state.data.cycles=[cycleRow({capture_paused_reason:'source_changed'})];
  state.data.latest_observation=summary({source:'BrawlTools',reported_players_played:null,reported_battles_played:128});
  const response=await api.GET(request()),value=await response.json();assert.equal(response.status,200);
  assert.equal(value.cycles[0].capturePausedReason,'source_changed');assert.equal(value.cycles[0].captureEnabled,false);
  assert.equal(value.cycles[0].reportedTotalWins,82);assert.equal(value.cycles[0].finalizedAt,null);assert.equal(value.cycles[0].rewardStatus,'unknown');
});

test('archive summaries reject unknown sources and mixed counter meanings', async () => {
  for(const changed of [{source:'Other'}, {source:null}, {source:'BrawlAce',reported_players_played:null},
    {source:'BrawlAce',reported_battles_played:128}, {source:'BrawlTools',reported_players_played:1},
    {source:'BrawlTools',reported_players_played:null,reported_battles_played:3},
    {source:'BrawlTools',reported_players_played:null,reported_battles_played:30001}]) {
    const {api,state}=fixture();state.data.latest_observation=summary(changed);
    assert.equal((await api.GET(request())).status,503,JSON.stringify(changed));
  }
});

test('reading summaries must agree with the payload provider, totals and unknown members', async () => {
  const payload={clubTag:'#PYLQ',source:'BrawlTools',totalWins:4,reportedPlayersPlayed:null,reportedBattlesPlayed:128,
    members:[{playerTag:'#PYLR',playerName:'عضو',reportedWins:4,reportedTicketsRemaining:0}]};
  for(const change of [{source:'BrawlAce',reported_players_played:1,reported_battles_played:null},
    {reported_battles_played:129}, {unknown_members:1}]) {
    const {api,state}=fixture();state.data={observation:summary({source:'BrawlTools',reported_players_played:null,reported_battles_played:128,payload,...change})};
    assert.equal((await api.GET(request('?mode=reading&id='+readingId))).status,503);
  }
});

test('archive rejects mixed-club, wrong-player, oversized and malformed storage responses', async () => {
  for (const change of [s=>{s.data.cycles[0].club_tag='#OTHER';},s=>{s.data.cycles[0].milestones=[40,20];},s=>{s.data.cycles[0].reward_status='automatic';},s=>{s.data.cycles=Array.from({length:21},()=>cycleRow());},s=>{s.data.next_offset=0;}]) {
    const {api,state}=fixture();change(state);assert.equal((await api.GET(request())).status,503);
  }
  const {api,state}=fixture();state.data={player_tag:'#PYLR',history:[{cycle:cycleRow(),member:memberRow({player_tag:'#PYLG'})}],next_offset:null};
  assert.equal((await api.GET(request('?mode=player&player=PYLR'))).status,503);
});

test('a club change during archive reads or writes never returns a mixed-club result', async () => {
  let {api,state}=fixture();state.clubChanged=true;assert.equal((await api.GET(request())).status,409);
  ({api,state}=fixture());state.clubChanged=true;state.data={cycle_id:cycleId,version:1,replayed:false};assert.equal((await api.POST(request('',creation()))).status,409);
});

test('archive creates are idempotent requests and only send explicitly validated fields', async () => {
  const {api,state}=fixture();state.data={cycle_id:cycleId,version:1,replayed:true};
  const response=await api.POST(request('',creation())),value=await response.json();assert.equal(response.status,200);assert.deepEqual(value,{id:cycleId,version:1,replayed:true});
  assert.equal(state.calls[0].name,'mega_pig_archive_write');assert.equal(state.calls[0].args.p_body.requestId,cycleId);
  assert.equal(state.calls[0].args.p_body.cycle.startsAt,'2026-09-04T08:00:00.000Z');
});

test('archive mutation input forbids invented defaults, invalid rules, missing confirmation and writes outside the contract', async () => {
  const cases=[creation({milestones:[16,16,48]}),creation({milestones:[16,null,48]}),creation({milestones:[]}),creation({milestones:[-1]}),creation({endsAt:'2026-09-01T00:00:00Z'}),creation({initialObservationId:null}),
    {...creation(),version:1},{...creation(),clubTag:'#OTHER'},creation({notes:'x'.repeat(2001)}),{action:'delete_cycle',id:cycleId},
    {action:'finalize_cycle',id:cycleId,version:1,finalTotalWins:-1,confirmedStage:5,rewardStatus:'received',notes:''},
    {action:'finalize_cycle',id:cycleId,version:1,finalTotalWins:80,confirmedStage:5,rewardStatus:true,notes:''},
    {action:'reopen_cycle',id:cycleId,version:1,reason:''}];
  for(const input of cases){const{api,state}=fixture();assert.equal((await api.POST(request('',input))).status,400);assert.equal(state.calls.length,0);}
});

test('unknown final counters and reward confirmation remain independent persisted inputs', async () => {
  for(const rewardStatus of ['unknown','received','not_received']){
    const{api,state}=fixture();state.data={cycle_id:cycleId,version:2,replayed:false};
    const input={action:'finalize_cycle',id:cycleId,version:1,finalTotalWins:null,confirmedStage:null,rewardStatus,notes:'تأكيد داخل اللعبة'};
    assert.equal((await api.POST(request('',input))).status,200);assert.equal(state.calls[0].args.p_body.finalTotalWins,null);assert.equal(state.calls[0].args.p_body.rewardStatus,rewardStatus);
  }
});

test('archive errors expose actionable conflict/not-found codes without raw database messages', async () => {
  for(const[error,status,code]of [[{code:'40001',message:'PRIVATE VERSION'},409,'conflict'],[{code:'P0002',message:'PRIVATE TAG'},404,'not_found'],[{code:'XX000',message:'PRIVATE SQL'},503,'unavailable']]){
    const{api,state}=fixture();state.error=error;const response=await api.GET(request());const value=await response.json();
    assert.equal(response.status,status);assert.equal(value.code,code);assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);
  }
});

test('archive POST bounds JSON bytes, rejects invalid UTF8/JSON and incompatible media types', async () => {
  const {api,state}=fixture();
  assert.equal((await api.POST(request('', '{'))).status,400);
  assert.equal((await api.POST(request('',creation(),{headers:{'content-type':'text/plain'}}))).status,415);
  assert.equal((await api.POST(request('',' '.repeat(16385)))).status,413);
  assert.equal((await api.POST(request('',creation(),{headers:{'content-length':'16385'}}))).status,413);
  const invalid=request('',new String('x').toString());const headers=new Headers(invalid.headers);
  const badBytes=new Request(invalid.url,{method:'POST',headers,body:new Uint8Array([0xc3,0x28])});
  assert.equal((await api.POST(badBytes)).status,400);assert.equal(state.calls.length,0);
});

test('five-stage progress follows per-cycle rules and keeps end, goal and reward separate', async t => {
  const {megaPigCycleProgress,megaPigReportedStage}=loadTypeScript('src/lib/mega-pig-progress.ts');
  const base={startsAt:'2026-09-04T08:00:00Z',endsAt:'2026-09-07T08:00:00Z',milestones:[16,32,48,64,80],finalizedAt:null,confirmedStage:null,reportedTotalWins:82,finalTotalWins:null,rewardStatus:'unknown'};
  for(const [wins,stage]of [[0,0],[15,0],[16,1],[63,3],[64,4],[79,4],[80,5],[82,5]])assert.equal(megaPigReportedStage(wins),stage);
  await t.test('a met observed target does not confirm reward receipt',()=>{const p=megaPigCycleProgress(base,Date.parse(now));assert.equal(p.stage,5);assert.equal(p.lifecycle,'ended');assert.equal(p.goal,'achieved');assert.equal(p.basis,'observed');assert.equal(base.rewardStatus,'unknown');});
  await t.test('an ended incomplete observation is not a verified failure',()=>{const p=megaPigCycleProgress({...base,reportedTotalWins:64},Date.parse(now));assert.equal(p.stage,4);assert.equal(p.goal,'in_progress');});
  await t.test('final confirmation can establish shortfall without pretending the reward is known',()=>{const p=megaPigCycleProgress({...base,finalizedAt:now,finalTotalWins:64},Date.parse(now));assert.equal(p.stage,4);assert.equal(p.goal,'missed');assert.equal(p.basis,'confirmed');});
  await t.test('unknown final totals never inherit unconfirmed observed totals',()=>{const p=megaPigCycleProgress({...base,finalizedAt:now},Date.parse(now));assert.equal(p.totalWins,null);assert.equal(p.stage,null);assert.equal(p.goal,'unknown');});
  await t.test('an archived cycle keeps its saved milestones when the default rules change',()=>{const p=megaPigCycleProgress({...base,milestones:[40,80,120,160,200]},Date.parse(now));assert.equal(p.stage,2);assert.equal(p.target,200);});
  await t.test('unknown rules stay unknown unless the stage itself is confirmed',()=>{assert.equal(megaPigCycleProgress({...base,milestones:null},Date.parse(now)).stage,null);const p=megaPigCycleProgress({...base,milestones:null,finalizedAt:now,confirmedStage:5},Date.parse(now));assert.equal(p.stage,5);assert.equal(p.stages,5);assert.equal(p.goal,'achieved');});
});
