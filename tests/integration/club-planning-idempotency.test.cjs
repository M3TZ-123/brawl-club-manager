const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const{randomUUID}=require('node:crypto');
const{Client}=require('pg');
const source=process.env.SECURITY_TEST_DATABASE_URL,root=path.resolve(__dirname,'../..');

test('planning creates are atomic, canonical, private and replayable',{skip:!source},async t=>{
  const url=new URL(source);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/brawl_security_tests');url.pathname='/postgres';
  const assertLocal=db=>assert.ok(['127.0.0.1','::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/,'')));
  const admin=new Client({connectionString:url.href});await admin.connect();assertLocal(admin);
  try{if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_planning_idempotency_tests'")).rowCount)await admin.query("CREATE DATABASE brawl_planning_idempotency_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");}finally{await admin.end();}
  url.pathname='/brawl_planning_idempotency_tests';const db=new Client({connectionString:url.href});await db.connect();assertLocal(db);t.after(()=>db.end());
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
  for(const file of ['202609160001_sync_durability.sql','202609160009_battle_coverage.sql','202609160031_club_planning.sql','202609160035_planning_create_requests.sql'])await db.query(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8'));
  await db.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('last_roster_sync_time',now()::text) ON CONFLICT(key) DO UPDATE SET value=excluded.value; INSERT INTO members(player_tag,player_name,trophies,last_updated) VALUES('#AAA','Alpha',100,now()),('#BBB','Beta',200,now()); INSERT INTO member_history(player_tag,player_name,is_current_member) VALUES('#AAA','Alpha',true),('#BBB','Beta',true)");
  const goal={action:'create_goal',title:'Weekly goal',metric:'trophies',cycle:'weekly',endsAt:null,target:100};
  const run=async(key,payload=goal,client=db,club='#CLUB')=>(await client.query('SELECT public.club_planning_create_once($1,$2,$3::jsonb) id',[club,key,JSON.stringify(payload)])).rows[0].id;
  const count=async table=>Number((await db.query(`SELECT count(*) FROM public.${table}`)).rows[0].count);
  await t.test('same key returns the original frozen cohort even when the current roster changed',async()=>{
    const key=randomUUID(),id=await run(key);await db.query("UPDATE members SET trophies=999 WHERE player_tag='#AAA'; UPDATE member_history SET is_current_member=false WHERE player_tag='#BBB'");
    assert.equal(await run(key,{target:100,cycle:'weekly',title:'  Weekly goal  ',action:'create_goal',endsAt:null,metric:'trophies'}),id);
    assert.equal(await count('club_goals'),1);assert.equal(await count('club_planning_create_requests'),1);
    assert.deepEqual((await db.query('SELECT player_tag,baseline_trophies FROM club_goal_members WHERE goal_id=$1 ORDER BY player_tag',[id])).rows,[{player_tag:'#AAA',baseline_trophies:100},{player_tag:'#BBB',baseline_trophies:200}]);
    await assert.rejects(run(key,{...goal,target:101}),e=>e.code==='40001'&&e.message==='planning_request_changed');
    await db.query("UPDATE member_history SET is_current_member=true WHERE player_tag='#BBB'");
  });
  await t.test('concurrent submissions commit exactly one goal and one receipt',async()=>{
    const other=new Client({connectionString:url.href});await other.connect();assertLocal(other);
    try{const key=randomUUID(),before=await count('club_goals');const ids=await Promise.all([run(key),run(key,goal,other)]);assert.equal(ids[0],ids[1]);assert.equal(await count('club_goals'),before+1);assert.equal((await db.query('SELECT count(*)::int n FROM club_planning_create_requests WHERE request_id=$1',[key])).rows[0].n,1);}finally{await other.end();}
  });
  await t.test('failed validation does not consume the request ID and whole-transaction rollback leaves no duplicate',async()=>{
    const key=randomUUID(),before=await count('club_goals');await assert.rejects(run(key,{...goal,metric:'participants',target:3}),e=>e.code==='22023');
    assert.equal((await db.query('SELECT count(*)::int n FROM club_planning_create_requests WHERE request_id=$1',[key])).rows[0].n,0);
    await run(key,{...goal,metric:'participants',target:2});assert.equal(await count('club_goals'),before+1);
    const rolledBack=randomUUID();await db.query('BEGIN');await run(rolledBack);await db.query('ROLLBACK');
    assert.equal(await count('club_goals'),before+1);assert.equal((await db.query('SELECT count(*)::int n FROM club_planning_create_requests WHERE request_id=$1',[rolledBack])).rows[0].n,0);
    await run(rolledBack);assert.equal(await count('club_goals'),before+2);
  });
  await t.test('committed custom goals replay after their deadline while a new late create still fails',async()=>{
    const endsAt=(await db.query("SELECT clock_timestamp()+interval '600 milliseconds' deadline")).rows[0].deadline.toISOString();
    const key=randomUUID(),payload={...goal,cycle:'custom',endsAt},id=await run(key,payload);
    await db.query('SELECT pg_sleep(0.7)');assert.equal(await run(key,payload),id);
    await assert.rejects(run(randomUUID(),payload),e=>e.code==='22023');
    const sameInstant={...payload,endsAt:endsAt.replace('Z','+00:00')};assert.equal(await run(key,sameInstant),id);
  });
  const now=Date.now(),event={title:'Manual Mega Pig',kind:'mega_pig',cycleLabel:'Cycle A',startsAt:new Date(now-7200000).toISOString(),endsAt:new Date(now-3600000).toISOString(),teamSize:2,ticketAllowance:15,status:'completed',notes:'PRIVATE EVENT'};
  const entry={playerTag:'#AAA',team:1,slot:'starter',attendance:'present',wins:0,ticketsRemaining:null,observedAt:new Date(now-5400000).toISOString(),notes:'PRIVATE MEMBER'};
  const payload={action:'save_event',id:null,version:0,event,entries:[entry,{...entry,playerTag:'#BBB',slot:'substitute'}],reason:''};
  await t.test('event retries normalize entry order and preserve zero, private notes and optimistic revisions',async()=>{
    const key=randomUUID(),id=await run(key,payload);assert.equal(await run(key,{...payload,entries:[...payload.entries].reverse(),event:{...event,notes:' PRIVATE EVENT '}}),id);
    assert.equal(await count('club_planned_events'),1);assert.equal(await count('club_event_revisions'),1);
    assert.deepEqual((await db.query("SELECT wins,tickets_remaining,notes FROM club_event_entries WHERE event_id=$1 AND player_tag='#AAA'",[id])).rows[0],{wins:0,tickets_remaining:null,notes:'PRIVATE MEMBER'});
    await assert.rejects(run(key,{...payload,entries:payload.entries.map(e=>({...e,wins:null}))}),e=>e.code==='40001');
    await db.query("SELECT club_planning_save_event('#CLUB',$1,1,$2::jsonb,$3::jsonb,'Corrected entry')",[id,JSON.stringify({...event,notes:'Revised note'}),JSON.stringify(payload.entries)]);
    assert.equal(await run(key,payload),id);assert.equal((await db.query('SELECT version,notes FROM club_planned_events WHERE id=$1',[id])).rows[0].version,2);
    await assert.rejects(db.query("SELECT club_planning_save_event('#CLUB',$1,1,$2::jsonb,$3::jsonb,'Stale')",[id,JSON.stringify(event),JSON.stringify(payload.entries)]),e=>e.code==='40001');
    await assert.rejects(run(key,goal),e=>e.code==='40001');
  });
  await t.test('event validation failures leave no receipt and corrected retry can save',async()=>{
    const key=randomUUID();await assert.rejects(run(key,{...payload,event:{...event,endsAt:event.startsAt}}),e=>e.code==='22023');
    assert.equal((await db.query('SELECT count(*)::int n FROM club_planning_create_requests WHERE request_id=$1',[key])).rows[0].n,0);await run(key,payload);
  });
  await t.test('request IDs are club scoped and replay needs no newly accepted roster',async()=>{
    const key=randomUUID(),id=await run(key);await db.query("UPDATE settings SET value='#OTHER' WHERE key='club_tag'; UPDATE settings SET value='' WHERE key='last_roster_sync_time'");
    assert.equal(await run(key),id);await assert.rejects(run(key,goal,db,'#OTHER'),e=>e.message==='planning_roster_not_ready');
    await db.query("UPDATE settings SET value=clock_timestamp()::text WHERE key='last_roster_sync_time'");assert.notEqual(await run(key,goal,db,'#OTHER'),id);
    await db.query("UPDATE settings SET value='#CLUB' WHERE key='club_tag'");
  });
  await t.test('only the service RPC can create receipts; public roles cannot inspect digests or invoke it',async()=>{
    const key=randomUUID();
    for(const role of ['anon','authenticated'])for(const sql of ['SELECT * FROM public.club_planning_create_requests',`SELECT public.club_planning_create_once('#CLUB','${key}','{}')`]){
      await db.query('BEGIN');try{await db.query('SET LOCAL ROLE '+role);await assert.rejects(db.query(sql),e=>e.code==='42501');}finally{await db.query('ROLLBACK');}
    }
    for(const sql of ["DELETE FROM club_planning_create_requests","UPDATE club_planning_create_requests SET action='save_event'","INSERT INTO club_planning_create_requests SELECT * FROM club_planning_create_requests"]){
      await db.query('BEGIN');try{await db.query('SET LOCAL ROLE service_role');await assert.rejects(db.query(sql),e=>e.code==='42501');}finally{await db.query('ROLLBACK');}
    }
    await db.query('BEGIN');try{await db.query('SET LOCAL ROLE service_role');const id=await run(key);assert.ok(id);assert.equal((await db.query('SELECT octet_length(payload_sha256) n FROM club_planning_create_requests WHERE request_id=$1',[key])).rows[0].n,32);}finally{await db.query('ROLLBACK');}
    assert.deepEqual((await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='club_planning_create_requests' ORDER BY ordinal_position")).rows.map(row=>row.column_name),['club_tag','request_id','action','payload_sha256','result_id','created_at']);
  });
});
