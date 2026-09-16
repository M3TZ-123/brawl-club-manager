const test=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {loadTypeScript}=require('./helpers/load-typescript.cjs');const {readOnlyDatabase}=require('./helpers/read-only-database.cjs');
const next={NextResponse:{json:Response.json}};const env={NODE_ENV:'test',ADMIN_PASSWORD:'test-password',ADMIN_SESSION_SECRET:'test-secret',VERCEL:'1'};
const globals={process:{env},console:{error(){}},Error};
const {createAdminSessionToken}=loadTypeScript('src/lib/admin-auth.ts',{'next/server':next},globals);
const req=(path,{body,admin=false,origin='https://club.test',method}={})=>new Request(`https://club.test${path}`,{method:method??(body===undefined?'GET':'POST'),headers:{'content-type':'application/json',origin,host:'club.test',...(admin?{cookie:`brawlstatz_admin=${createAdminSessionToken()}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
function fixture(overrides={}){
  const calls=[];const tables={club_administration_settings:[{club_tag:'#CLUB',grace_hours:48,recruitment_open:true,min_trophies:1000,min_power11:3,min_ranked_points:null,language:'العربية',availability:'Evening',version:2,updated_at:'2026-09-16T00:00:00Z',future_secret:'PRIVATE'}],
    member_decision_log:[],member_absences:[],membership_change_events:[],recruitment_applications:[],...overrides};
  const base=readOnlyDatabase(tables);
  const db={from(table){const query=base.from(table);query.or=expression=>{
    const match=/^created_at\.lt\.(.+),and\(created_at\.eq\.\1,id\.lt\.([a-f0-9-]{36})\)$/.exec(expression);assert.ok(match,'Expected timestamp/UUID keyset predicate');
    return query.in('id',tables[table].filter(row=>row.created_at<match[1]||row.created_at===match[1]&&row.id<match[2]).map(row=>row.id));
  };return query;},rpc:async(name,args)=>{calls.push({name,args});return{name,data:name==='administration_club_tag'?'#CLUB':true,error:null};}};
  const load=path=>loadTypeScript(path,{'next/server':next,'@/lib/supabase-admin':{supabaseAdmin:db}},globals);
  return{calls,tables,db,load};
}
test('all private administration and application routes deny unauthenticated reads/writes before storage',async()=>{
  const f=fixture();
  for(const path of ['member-administration','club-administration','recruitment/applications']){
    const route=f.load(`src/app/api/${path}/route.ts`);
    for(const [method,body]of [['GET',undefined],[path==='member-administration'?'POST':'PATCH',{}]]){
      const response=await route[method](req(`/api/${path}`,{body,method}));assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('vary'),'Cookie');
    }
  }
  assert.equal(f.calls.length,0);
  const response=await f.load('src/app/api/member-administration/route.ts').POST(req('/api/member-administration',{admin:true,body:{},origin:'https://evil.test'}));assert.equal(response.status,403);assert.equal(f.calls.length,0);
});
test('public recruitment metadata uses an explicit projection and reveals no grace, revisions, secrets or applications',async()=>{
  const f=fixture();const response=await f.load('src/app/api/join/route.ts').GET();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{club_tag:'#CLUB',recruitment_open:true,min_trophies:1000,min_power11:3,min_ranked_points:null,language:'العربية',availability:'Evening'});
});
test('public applications have bounded bodies, origin/consent checks, honeypot handling and opaque quota keys',async()=>{
  const f=fixture();const route=f.load('src/app/api/join/route.ts');const body={club_tag:'#CLUB',player_tag:'#PYLQ',message:'Hello',language:'Arabic',availability:'Evenings',consent:true,website:'',request_id:randomUUID()};
  assert.equal((await route.POST(req('/api/join',{body,origin:'https://evil.test'}))).status,403);
  assert.equal((await route.POST(req('/api/join',{body:{...body,consent:false}}))).status,400);
  assert.equal((await route.POST(req('/api/join',{body:{...body,player_tag:'#INVALID'}}))).status,400);
  assert.equal((await route.POST(req('/api/join',{body:{...body,message:'x'.repeat(5000)}}))).status,413);
  assert.equal((await route.POST(req('/api/join',{body:{...body,website:'spam'}}))).status,202);assert.equal(f.calls.length,0);
  const response=await route.POST(req('/api/join',{body}));assert.equal(response.status,202);assert.deepEqual(await response.json(),{accepted:true});
  assert.equal(f.calls[0].name,'submit_recruitment_application');assert.match(f.calls[0].args.p_client_key,/^[a-f0-9]{64}$/);assert.equal(f.calls[0].args.p_club_tag,'#CLUB');assert.equal(f.calls[0].args.p_tag,'#PYLQ');
  f.db.rpc=async()=>({data:false,error:null});assert.equal((await route.POST(req('/api/join',{body}))).status,429);
  f.db.rpc=async()=>({data:null,error:{code:'55000',message:'PRIVATE'}});const closed=await route.POST(req('/api/join',{body}));assert.equal(closed.status,409);assert.doesNotMatch(await closed.text(),/PRIVATE/);
});
test('decision API requires exact typed references and preserves a dated request across retries',async()=>{
  const f=fixture();const route=f.load('src/app/api/member-administration/route.ts');const request_id=randomUUID(),departure_event_id=randomUUID();
  for(const body of [{action:'decision',player_tag:'#PYLQ',kind:'departure_reason',body:'Reason',request_id},{action:'decision',player_tag:'#PYLQ',kind:'follow_up',body:'Review',request_id,follow_up_at:'2026-02-30T00:00:00Z'},{action:'absence',player_tag:'#PYLQ',starts_at:'2026-09-16T00:00:00Z',ends_at:'2026-09-15T00:00:00Z',request_id}])assert.equal((await route.POST(req('/api/member-administration',{admin:true,body}))).status,400);
  assert.equal(f.calls.length,0);
  assert.equal((await route.GET(req('/api/member-administration?player_tag=bad',{admin:true}))).status,400);assert.equal(f.calls.length,0);
  const response=await route.POST(req('/api/member-administration',{admin:true,body:{action:'decision',player_tag:'#PYLQ',kind:'departure_reason',body:'Specific departure reason',request_id,departure_event_id}}));
  assert.equal(response.status,200);assert.equal(f.calls[0].args.p_departure_event_id,departure_event_id);assert.equal(f.calls[0].args.p_request_id,request_id);assert.equal(f.calls[0].args.author,undefined);
});

test('application keysets retain UUID ties and exact microseconds after earlier rows leave the status filter',async()=>{
  const at='2026-09-16T00:00:00.123456+00:00';const rows=Array.from({length:53},(_,i)=>({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,club_tag:'#CLUB',player_tag:'#PYLQ',status:'pending',created_at:at,version:1,private_notes:'Private',future_secret:'HIDDEN'}));
  const f=fixture({recruitment_applications:rows});const route=f.load('src/app/api/recruitment/applications/route.ts');
  const first=await(await route.GET(req('/api/recruitment/applications?status=pending',{admin:true}))).json();assert.equal(first.applications.length,50);assert.equal(first.total,53);assert.equal(first.nextOffset,50);assert.equal(JSON.parse(Buffer.from(first.nextCursor,'base64url').toString()).at,at);assert.doesNotMatch(JSON.stringify(first),/HIDDEN|future_secret/);
  rows[52].status='reviewing';rows.push({...rows[0],id:randomUUID(),created_at:'2026-09-17T00:00:00Z'});
  const secondResponse=await route.GET(req('/api/recruitment/applications?status=pending&cursor='+encodeURIComponent(first.nextCursor),{admin:true}));assert.equal(secondResponse.status,200);const second=await secondResponse.json();assert.equal(second.applications.length,3);assert.equal(second.nextCursor,null);assert.equal(second.total,null);assert.equal(new Set([...first.applications,...second.applications].map(row=>row.id)).size,53);
  for(const cursor of ['invalid',Buffer.from(JSON.stringify({at,id:'bad'})).toString('base64url'),Buffer.from(JSON.stringify({at,id:rows[0].id,private_notes:'injected'})).toString('base64url')])assert.equal((await route.GET(req('/api/recruitment/applications?cursor='+cursor,{admin:true}))).status,400);
});

test('application review returns only the committed private DTO and preserves optimistic conflict status',async()=>{
  const f=fixture();const id=randomUUID();f.db.rpc=async(name,args)=>{f.calls.push({name,args});return {data:{id,player_tag:'#PYLQ',status:'reviewing',private_notes:'Saved',version:4,created_at:'2026-09-16T00:00:00.123456Z',updated_at:'2026-09-16T00:00:00.987654Z',club_tag:'#CLUB',request_id:randomUUID(),future_secret:'HIDDEN'},error:null};};
  const route=f.load('src/app/api/recruitment/applications/route.ts');const body={id,status:'reviewing',private_notes:'Saved',version:3};const response=await route.PATCH(req('/api/recruitment/applications',{admin:true,method:'PATCH',body}));assert.equal(response.status,200);const data=await response.json();assert.equal(data.application.version,4);assert.equal(data.application.updated_at,'2026-09-16T00:00:00.987654Z');assert.doesNotMatch(JSON.stringify(data),/HIDDEN|request_id|club_tag/);assert.equal(f.calls[0].args.p_version,3);
  f.db.rpc=async()=>({data:null,error:{code:'40001',message:'SECRET'}});const conflict=await route.PATCH(req('/api/recruitment/applications',{admin:true,method:'PATCH',body}));assert.equal(conflict.status,409);assert.doesNotMatch(await conflict.text(),/SECRET/);
});

test('a decision retains its linked departure date even beyond the 100-entry dropdown',async()=>{
  const id=randomUUID(),departure=randomUUID();const events=Array.from({length:101},(_,i)=>({id:randomUUID(),club_tag:'#CLUB',player_tag:'#PYLQ',event_type:'leave',source:'recorded',occurred_at:new Date(Date.UTC(2026,8,16)-i*86400000).toISOString()}));events.push({id:departure,club_tag:'#CLUB',player_tag:'#PYLQ',event_type:'leave',source:'recorded',occurred_at:'2025-01-01T00:00:00Z'});
  const f=fixture({member_decision_log:[{id,club_tag:'#CLUB',player_tag:'#PYLQ',kind:'departure_reason',body:'Reason',departure_event_id:departure,created_at:'2026-09-16T00:00:00Z'}],membership_change_events:events});const response=await f.load('src/app/api/member-administration/route.ts').GET(req('/api/member-administration?player_tag=%23PYLQ',{admin:true}));const data=await response.json();assert.equal(response.status,200);assert.equal(data.departures.length,100);assert.equal(data.departuresLimited,true);assert.equal(data.decisions[0].departure_occurred_at,'2025-01-01T00:00:00Z');
});
test('private decision reads strip future fields and paginate by exact timestamp plus id',async()=>{
  const id=randomUUID();const rows=Array.from({length:51},(_,i)=>({id:i===49?id:randomUUID(),club_tag:'#CLUB',player_tag:'#PYLQ',kind:'note',body:'private note',created_at:`2026-09-16T00:00:${String(59-i).padStart(2,'0')}.123456+00:00`,future_secret:'PRIVATE',departure_event_id:null,corrects_id:null,follow_up_at:null}));
  const f=fixture({member_decision_log:rows});const response=await f.load('src/app/api/member-administration/route.ts').GET(req('/api/member-administration?player_tag=%23PYLQ',{admin:true}));
  const data=await response.json();assert.equal(response.status,200);assert.equal(data.decisions.length,50);assert.doesNotMatch(JSON.stringify(data),/future_secret|PRIVATE/);assert.deepEqual(JSON.parse(Buffer.from(data.nextCursor,'base64url').toString()),{at:'2026-09-16T00:00:10.123456+00:00',id});
});
test('fit criteria distinguish missing profiles and unknown rank points from a failed requirement without inventing a score',()=>{
  const {recruitmentFit}=loadTypeScript('src/lib/recruitment-fit.ts');const criteria={min_trophies:1000,min_power11:3,min_ranked_points:100,language:'Arabic',availability:'Evening'};
  let result=recruitmentFit({profile:null},criteria);assert.ok(result.every(row=>row.status==='unknown'));
  result=recruitmentFit({profile:{trophies:1000,power11:2,rank:'Gold',rankedPoints:null},manual_compatibility:{language:'compatible',time:'incompatible'}},criteria);
  assert.deepEqual(JSON.parse(JSON.stringify(result.map(row=>row.status))),['met','not_met','unknown','met','not_met']);
  assert.equal(recruitmentFit({profile:null},{...criteria,min_trophies:0})[0].status,'not_required');
});
