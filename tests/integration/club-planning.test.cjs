const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const{Client}=require('pg');
const source=process.env.SECURITY_TEST_DATABASE_URL,root=path.resolve(__dirname,'../..');
test('club planning freezes goals and protects manual event revisions',{skip:!source},async t=>{
  const url=new URL(source);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/brawl_security_tests');url.pathname='/postgres';
  const admin=new Client({connectionString:url.href});await admin.connect();assert.ok(['127.0.0.1','::1'].includes(admin.connection.stream.remoteAddress.replace(/^::ffff:/,'')));
  try{if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_planning_tests'")).rowCount)await admin.query("CREATE DATABASE brawl_planning_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");}finally{await admin.end();}
  url.pathname='/brawl_planning_tests';const db=new Client({connectionString:url.href});await db.connect();t.after(()=>db.end());
  assert.ok(['127.0.0.1','::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/,'')));
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
  for(const file of ['202609160001_sync_durability.sql','202609160009_battle_coverage.sql','202609160031_club_planning.sql'])await db.query(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8'));
  await db.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('last_roster_sync_time',now()::text) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  await db.query("INSERT INTO members(player_tag,player_name,trophies,last_updated) VALUES('#AAA','Alpha',100,now()),('#BBB','Beta',200,now()); INSERT INTO member_history(player_tag,player_name,is_current_member) VALUES('#AAA','Alpha',true),('#BBB','Beta',true)");
  const runId=(await db.query("INSERT INTO sync_runs(id,club_tag,source,scope,fence,status) VALUES(gen_random_uuid(),'#CLUB','manual','full',1,'succeeded') RETURNING id")).rows[0].id;
  const createGoal=async(metric='trophies',target=100)=>(await db.query("SELECT club_planning_create_goal('#CLUB','Goal',$1,'weekly',NULL,$2) id",[metric,target])).rows[0].id;
  const refresh=()=>db.query("SELECT club_planning_refresh_goals('#CLUB')");
  const readGoal=async id=>(await db.query('SELECT * FROM club_goals WHERE id=$1',[id])).rows[0];
  await t.test('switching the configured club cannot freeze its predecessor roster into a new goal',async()=>{
    await db.query("UPDATE settings SET value='' WHERE key='last_roster_sync_time'");await assert.rejects(createGoal(),e=>e.message==='planning_roster_not_ready');
    await db.query("UPDATE settings SET value=now()::text WHERE key='last_roster_sync_time'");await assert.rejects(db.query("SELECT club_planning_create_goal('#OTHER','Goal','trophies','weekly',NULL,1)"),e=>e.message==='planning_roster_not_ready');
  });
  await t.test('the frozen roster retains departed members and excludes later arrivals',async()=>{
    const id=await createGoal();
    await db.query("UPDATE member_history SET is_current_member=false WHERE player_tag='#BBB'; INSERT INTO members(player_tag,player_name,trophies) VALUES('#CCC','Later arrival',900); INSERT INTO member_history(player_tag,player_name,is_current_member) VALUES('#CCC','Later arrival',true)");
    await refresh();const members=(await db.query('SELECT player_tag,baseline_trophies,departed FROM club_goal_members WHERE goal_id=$1 ORDER BY player_tag',[id])).rows;
    assert.deepEqual(members,[{player_tag:'#AAA',baseline_trophies:100,departed:false},{player_tag:'#BBB',baseline_trophies:200,departed:true}]);assert.equal((await readGoal(id)).cohort_count,2);
    await db.query("UPDATE member_history SET is_current_member=player_tag IN ('#AAA','#BBB')");
  });
  await t.test('late goal reads exclude post-deadline balances and retain achievement snapshots',async()=>{
    const id=await createGoal();await db.query("UPDATE club_goals SET starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' WHERE id=$1;",[id]);
    await db.query("UPDATE club_goal_members SET baseline_at=now()-interval '2 hours',latest_at=now()-interval '2 hours' WHERE goal_id=$1",[id]);
    await db.query("INSERT INTO activity_log(player_tag,trophies,recorded_at) VALUES('#AAA',150,now()-interval '70 minutes'),('#BBB',250,now()-interval '70 minutes'),('#AAA',9999,now()-interval '10 minutes'); UPDATE members SET trophies=9000,last_updated=now() WHERE player_tag IN ('#AAA','#BBB')");
    await refresh();const goal=await readGoal(id);assert.equal(Number(goal.progress),100);assert.equal(goal.limited,false);assert.ok(goal.achieved_at);
    await db.query("UPDATE club_goals SET refreshed_at=now()-interval '31 seconds' WHERE id=$1",[id]);await refresh();assert.equal(Number((await readGoal(id)).progress),100);assert.equal((await readGoal(id)).achieved_at.toISOString(),goal.achieved_at.toISOString());assert.equal(Number((await db.query('SELECT count(*) FROM club_goal_snapshots WHERE goal_id=$1',[id])).rows[0].count),1);
  });
  await t.test('participation is unique, deadline bounded and possible gaps stay visible after source retention',async()=>{
    const id=await createGoal('participants',2);await db.query("UPDATE club_goals SET starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' WHERE id=$1",[id]);
    await db.query("INSERT INTO battle_history(player_tag,battle_time) VALUES('#AAA',now()-interval '80 minutes'),('#AAA',now()-interval '70 minutes'),('#BBB',now()-interval '10 minutes')");
    await db.query("INSERT INTO sync_battle_coverage(club_tag,player_tag,baseline_started_at,last_observed_at,last_attempt_at,last_observation_status,last_run_id) VALUES('#CLUB','#AAA',now()-interval '3 hours',now(),now(),'observed',$1),('#CLUB','#BBB',now()-interval '3 hours',now(),now(),'observed',$1)",[runId]);
    await refresh();assert.equal(Number((await readGoal(id)).progress),1);
    await db.query("INSERT INTO sync_battle_gaps(club_tag,player_tag,gap_start_at,gap_end_at,run_id,detected_at,previous_observed_at,window_size,scope) VALUES('#CLUB','#AAA',now()-interval '90 minutes',now()-interval '80 minutes',$1,now(),now()-interval '2 hours',25,'full')",[runId]);await db.query("UPDATE club_goals SET refreshed_at=NULL WHERE id=$1",[id]);await refresh();assert.equal((await readGoal(id)).possible_gap,true);
    await db.query("DELETE FROM sync_battle_gaps; DELETE FROM battle_history WHERE player_tag='#AAA'");await db.query("UPDATE club_goals SET refreshed_at=NULL WHERE id=$1",[id]);await refresh();assert.equal(Number((await readGoal(id)).progress),1);assert.equal((await readGoal(id)).limited,true);assert.equal((await readGoal(id)).possible_gap,true);
  });
  await t.test('an unmonitored retained-history interval cannot become complete on the next read',async()=>{
    const id=await createGoal('participants',2);await db.query("UPDATE club_goals SET starts_at=now()-interval '40 days',ends_at=now()-interval '1 hour' WHERE id=$1",[id]);await db.query("UPDATE sync_battle_coverage SET baseline_started_at=now()-interval '50 days'");
    await refresh();assert.equal((await readGoal(id)).history_limited,true);await db.query("UPDATE club_goals SET refreshed_at=now()-interval '31 seconds' WHERE id=$1",[id]);await refresh();assert.equal((await readGoal(id)).limited,true);
  });
  await t.test('missing balances remain unknown and cannot achieve a trophy target',async()=>{
    const id=await createGoal();await db.query('UPDATE club_goal_members SET baseline_trophies=NULL,baseline_at=NULL WHERE goal_id=$1',[id]);await refresh();const goal=await readGoal(id);assert.equal(goal.progress,null);assert.equal(goal.limited,true);assert.equal(goal.achieved_at,null);
  });
  await t.test('goal targets cannot exceed the frozen cohort and archived goals use optimistic revisions',async()=>{
    await assert.rejects(createGoal('participants',3),e=>e.code==='22023');const id=await createGoal();await db.query("SELECT club_planning_archive_goal('#CLUB',$1,1)",[id]);await assert.rejects(db.query("SELECT club_planning_archive_goal('#CLUB',$1,1)",[id]),e=>e.code==='40001');
  });
  await t.test('repeated eligible refreshes do not rewrite unchanged cohort tuples but still save new observations',async()=>{
    const id=await createGoal();
    await db.query("UPDATE members SET trophies=trophies+5,last_updated=clock_timestamp() WHERE player_tag='#AAA'; UPDATE member_history SET is_current_member=false WHERE player_tag='#BBB'; INSERT INTO battle_history(player_tag,battle_time) VALUES('#AAA',clock_timestamp())");
    await refresh();
    const tuples=async()=>(await db.query('SELECT player_tag,xmin::text revision,ctid::text tuple_id,latest_trophies,latest_at,participated,departed,possible_gap FROM club_goal_members WHERE goal_id=$1 ORDER BY player_tag',[id])).rows;
    const before=await tuples();assert.equal(before[0].participated,true);assert.equal(before[1].departed,true);
    for(let attempt=0;attempt<3;attempt++){
      await db.query("UPDATE club_goals SET refreshed_at=now()-interval '31 seconds' WHERE id=$1",[id]);await refresh();
      assert.deepEqual(await tuples(),before,'An eligible check with unchanged source data must preserve physical cohort tuples');
    }
    await db.query("UPDATE members SET trophies=trophies+1,last_updated=clock_timestamp() WHERE player_tag='#AAA'");
    await db.query("UPDATE club_goals SET refreshed_at=now()-interval '31 seconds' WHERE id=$1",[id]);await refresh();
    const changed=await tuples();assert.equal(changed[0].latest_trophies,before[0].latest_trophies+1);assert.notEqual(changed[0].revision,before[0].revision);assert.deepEqual(changed[1],before[1]);
    await db.query("UPDATE member_history SET is_current_member=true WHERE player_tag='#BBB'");
  });
  const now=Date.now(),event={title:'Manual Mega Pig',kind:'mega_pig',cycleLabel:'September edition',startsAt:new Date(now-7200000).toISOString(),endsAt:new Date(now-3600000).toISOString(),teamSize:1,ticketAllowance:15,status:'completed',notes:'PRIVATE EVENT'};
  const entry={playerTag:'#AAA',team:1,slot:'starter',attendance:'present',wins:3,ticketsRemaining:10,observedAt:new Date(now-5400000).toISOString(),notes:'PRIVATE MEMBER'};
  const save=async(id,version,e=event,entries=[entry],reason='')=>(await db.query("SELECT club_planning_save_event('#CLUB',$1,$2,$3,$4,$5) id",[id,version,JSON.stringify(e),JSON.stringify(entries),reason])).rows[0].id;
  let eventId;
  await t.test('manual event creation stores explicit zero separately from unknown',async()=>{
    eventId=await save(null,0,event,[{...entry,wins:0,ticketsRemaining:null}]);const stored=(await db.query('SELECT wins,tickets_remaining,source FROM club_event_entries WHERE event_id=$1',[eventId])).rows[0];assert.deepEqual(stored,{wins:0,tickets_remaining:null,source:'manual'});assert.equal(Number((await db.query('SELECT count(*) FROM club_event_revisions WHERE event_id=$1',[eventId])).rows[0].count),1);
  });
  await t.test('corrections require a reason, and a stale revision cannot overwrite results',async()=>{
    await assert.rejects(save(eventId,1),e=>e.message==='correction_reason_required');await save(eventId,1,event,[entry],'Corrected attendance sheet');await assert.rejects(save(eventId,1,event,[{...entry,wins:4}],'Stale update'),e=>e.code==='40001');
    const row=(await db.query('SELECT version FROM club_planned_events WHERE id=$1',[eventId])).rows[0];assert.equal(row.version,2);
  });
  await t.test('recorded results cannot silently roll into a new cycle',async()=>{
    await assert.rejects(save(eventId,2,{...event,cycleLabel:'October edition'},[entry],'New cycle'),e=>e.message==='event_cycle_locked');await assert.rejects(save(eventId,2,{...event,endsAt:new Date(now-1800000).toISOString()},[entry],'Extend'),e=>e.message==='event_cycle_locked');
  });
  await t.test('event boundaries, unknown members, duplicate rosters and team capacity are enforced atomically',async()=>{
    for(const [e,entries] of [[event,[entry,{...entry}]], [event,[entry,{...entry,playerTag:'#BBB'}]], [event,[{...entry,playerTag:'#NOPE'}]], [event,[{...entry,observedAt:new Date(now).toISOString()}]], [event,[{...entry,wins:6}]], [event,[{...entry,observedAt:null}]], [{...event,kind:'ranked',ticketAllowance:null},[entry]], [{...event,endsAt:new Date(now+60000).toISOString()},[entry]]]) await assert.rejects(save(null,0,e,entries),e=>e.code==='22023');
    assert.equal(Number((await db.query('SELECT count(*) FROM club_planned_events')).rows[0].count),1);
    await save(null,0,event,[entry,{...entry,playerTag:'#BBB',slot:'substitute'}]);
  });
  await t.test('former event members remain editable and each event retains at most20 revisions',async()=>{
    await db.query("UPDATE member_history SET is_current_member=false WHERE player_tag='#AAA'");for(let version=2;version<=24;version++)await save(eventId,version,event,[entry],'Verified');
    assert.equal(Number((await db.query('SELECT count(*) FROM club_event_revisions WHERE event_id=$1',[eventId])).rows[0].count),20);assert.equal((await db.query('SELECT version FROM club_planned_events WHERE id=$1',[eventId])).rows[0].version,25);
  });
  await t.test('concurrent event saves from one baseline allow exactly one winner',async()=>{
    const other=new Client({connectionString:url.href});await other.connect();assert.ok(['127.0.0.1','::1'].includes(other.connection.stream.remoteAddress.replace(/^::ffff:/,'')));
    try{const args=[eventId,25,JSON.stringify(event),JSON.stringify([entry]),'Concurrent verification'];const writes=await Promise.allSettled([db.query("SELECT club_planning_save_event('#CLUB',$1,$2,$3,$4,$5)",args),other.query("SELECT club_planning_save_event('#CLUB',$1,$2,$3,$4,$5)",args)]);assert.equal(writes.filter(r=>r.status==='fulfilled').length,1);assert.equal(writes.find(r=>r.status==='rejected').reason.code,'40001');assert.equal((await db.query('SELECT version FROM club_planned_events WHERE id=$1',[eventId])).rows[0].version,26);}finally{await other.end();}
  });
  await t.test('public roles cannot read private planning tables or invoke mutations',async()=>{
    for(const role of ['anon','authenticated'])for(const sql of ['SELECT * FROM club_goals','SELECT * FROM club_goal_members','SELECT * FROM club_goal_snapshots','SELECT * FROM club_planned_events','SELECT * FROM club_event_entries','SELECT * FROM club_event_revisions',"SELECT club_planning_refresh_goals('#CLUB')","SELECT club_planning_create_goal('#CLUB','Forbidden','trophies','weekly',NULL,1)"]){await db.query('BEGIN');try{await db.query('SET LOCAL ROLE '+role);await assert.rejects(db.query(sql),e=>e.code==='42501');}finally{await db.query('ROLLBACK');}}
    await db.query('BEGIN');try{await db.query('SET LOCAL ROLE service_role');await assert.rejects(db.query("UPDATE club_planned_events SET notes='bypass'"),e=>e.code==='42501');}finally{await db.query('ROLLBACK');}
  });
});
