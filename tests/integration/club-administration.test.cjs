const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {Client}=require('pg');const {randomUUID}=require('node:crypto');
const source=process.env.SECURITY_TEST_DATABASE_URL;const root=path.resolve(__dirname,'../..');
test('club administration protects dated records, suppression and bounded private applications',{skip:!source},async t=>{
  const url=new URL(source);assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.match(url.pathname,/^\/brawl_[a-z_]+_tests$/);assert.equal(url.search,'');
  url.pathname='/postgres';const admin=new Client({connectionString:url.href});await admin.connect();
  const local=db=>assert.ok(['127.0.0.1','::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/,'')));
  try{local(admin);if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_administration_tests'")).rowCount)await admin.query("CREATE DATABASE brawl_administration_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");}finally{await admin.end();}
  url.pathname='/brawl_administration_tests';const db=new Client({connectionString:url.href});await db.connect();t.after(()=>db.end());local(db);
  await db.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public;GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
  for(const file of ['202609160001_sync_durability.sql','202609160002_admin_privacy.sql','202609160023_recruitment.sql','202609160030_club_administration.sql'])await db.query(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8'));
  await db.query("INSERT INTO settings(key,value)VALUES('club_tag','#CLUB');INSERT INTO members(player_tag,player_name,is_active)VALUES('#PYLQ','علي',false),('#GGRR','Other',false);INSERT INTO member_history(player_tag,player_name,is_current_member)VALUES('#PYLQ','علي',true),('#GGRR','Other',false)");
  const event=async(tag,type,club='#CLUB',source='recorded',at=new Date())=>(await db.query("INSERT INTO membership_change_events(club_tag,player_tag,player_name,event_type,source,occurred_at,trigger_source,actor)VALUES($1,$2,'Player',$3,$4,$5,'manual','admin')RETURNING id",[club,tag,type,source,at])).rows[0].id;
  const append=async(kind,body,id=randomUUID(),departure=null,corrects=null,follow=null)=>(await db.query("SELECT append_member_decision('#PYLQ',$1,$2,$3,$4,$5,$6) id",[kind,body,id,departure,corrects,follow])).rows[0].id;
  const values={grace_hours:0,recruitment_open:false,min_trophies:1000,min_power11:3,min_ranked_points:null,language:'العربية',availability:'18:00 UTC'};
  const save=async(value,version)=>(await db.query('SELECT save_club_administration($1,$2) data',[JSON.stringify(value),version])).rows[0].data;
  const exempt=async(at=new Date(),club='#CLUB')=>(await db.query("SELECT member_inactivity_exempt($1,'#PYLQ',$2) value",[club,at])).rows[0].value;
  const application=async(tag,client='a'.repeat(64),id=randomUUID(),club='#CLUB')=>(await db.query('SELECT submit_recruitment_application($1,$2,$3,$4,$5,$6,$7) accepted',[club,tag,'طلب خاص','العربية','Evening',client,id])).rows[0].accepted;

  await t.test('departure reasons bind the exact same-club player departure and never fabricate identity or backdate entries',async()=>{
    const leave=await event('#PYLQ','leave'),join=await event('#PYLQ','join'),other=await event('#GGRR','leave'),elsewhere=await event('#PYLQ','leave','#OTHER');
    for(const id of [join,other,elsewhere])await assert.rejects(append('departure_reason','سبب',randomUUID(),id),error=>error.code==='22023');
    const request=randomUUID(),id=await append('departure_reason','سبب موثّق',request,leave);assert.equal(await append('departure_reason','سبب موثّق',request,leave),id);
    await assert.rejects(append('departure_reason','changed',request,leave),error=>error.code==='40001');
    const row=(await db.query('SELECT * FROM member_decision_log WHERE id=$1',[id])).rows[0];assert.equal(row.departure_event_id,leave);assert.equal(row.body,'سبب موثّق');assert.equal(row.author,undefined);assert.ok(Math.abs(Date.now()-row.created_at.getTime())<10000);
    const correction=await append('correction','تصحيح معلن',randomUUID(),null,id);assert.equal((await db.query('SELECT corrects_id FROM member_decision_log WHERE id=$1',[correction])).rows[0].corrects_id,id);
    await assert.rejects(db.query("UPDATE member_decision_log SET body='erased' WHERE id=$1",[id]),error=>error.code==='42501');
    await assert.rejects(db.query('DELETE FROM member_decision_log WHERE id=$1',[id]),error=>error.code==='42501');
    await assert.rejects(db.query('TRUNCATE member_decision_log'),error=>error.code==='42501');
    assert.equal((await db.query("SELECT has_table_privilege('service_role','public.member_decision_log','TRUNCATE') allowed")).rows[0].allowed,false);
    assert.equal((await db.query('SELECT body FROM member_decision_log WHERE id=$1',[id])).rows[0].body,'سبب موثّق');
  });
  await t.test('criteria use optimistic versions and absence suppression has exact boundaries without activity mutation',async()=>{
    const setting=await save(values,0);assert.equal(setting.version,1);await assert.rejects(save({...values,grace_hours:48},0),error=>error.code==='40001');
    assert.equal(await exempt(),false);const start=new Date(Date.now()-60000),end=new Date(Date.now()+3600000),request=randomUUID();
    const absence=(await db.query("SELECT declare_member_absence('#PYLQ',$1,$2,'private absence',$3) id",[start,end,request])).rows[0].id;
    assert.equal((await db.query("SELECT declare_member_absence('#PYLQ',$1,$2,'private absence',$3) id",[start,end,request])).rows[0].id,absence);
    assert.equal(await exempt(start),true);assert.equal(await exempt(end),false);assert.equal(await exempt(new Date(), '#OTHER'),false);
    assert.equal((await db.query("SELECT is_active FROM members WHERE player_tag='#PYLQ'")).rows[0].is_active,false);
    await assert.rejects(db.query("SELECT declare_member_absence('#GGRR',$1,$2,'',$3)",[start,end,randomUUID()]),error=>error.code==='22023');
    await assert.rejects(db.query("SELECT declare_member_absence('#PYLQ',$1,$2,'',$3)",[start,new Date(start.getTime()+91*86400000),randomUUID()]),error=>error.code==='23514');
    await db.query('SELECT cancel_member_absence($1)',[absence]);assert.equal(await exempt(),false);
    assert.equal((await db.query("SELECT count(*)::int n FROM member_decision_log WHERE kind IN('absence_declared','absence_cancelled')")).rows[0].n,2);
  });
  await t.test('grace is based on recorded current-club joins, expires, and does not rely on reconstructed history',async()=>{
    await save({...values,grace_hours:48},1);
    assert.equal(await exempt(),true);
    const future=new Date(Date.now()+49*3600000);assert.equal(await exempt(future),false);
    await event('#PYLQ','join','#CLUB','reconstructed',future);assert.equal(await exempt(future),false);
    await event('#PYLQ','join','#OTHER','recorded',future);assert.equal(await exempt(future),false);
  });
  await t.test('public application submission is closed by default, rate bounded, deduplicated and club scoped',async()=>{
    await assert.rejects(application('#PYLQ'),error=>error.code==='55000');await save({...values,grace_hours:48,recruitment_open:true},2);
    await assert.rejects(application('#PYLQ','a'.repeat(64),randomUUID(),'#OTHER'),error=>error.code==='40001');
    const request=randomUUID();assert.equal(await application('#PYLQ','a'.repeat(64),request),true);assert.equal(await application('#PYLQ','a'.repeat(64),request),true);
    assert.equal((await db.query('SELECT attempts FROM recruitment_application_limits')).rows[0].attempts,1);
    assert.equal(await application('#GGRR'),true);assert.equal(await application('#PYYL'),true);assert.equal(await application('#QQLL'),false);
    assert.equal((await db.query('SELECT count(*)::int n FROM recruitment_applications')).rows[0].n,3);
    assert.equal(await application('#PYLQ','b'.repeat(64)),true);assert.equal((await db.query('SELECT count(*)::int n FROM recruitment_applications')).rows[0].n,3);
    const row=(await db.query("SELECT id FROM recruitment_applications WHERE player_tag='#PYLQ'")).rows[0];
    await db.query("SELECT review_recruitment_application($1,'reviewing','private review',1)",[row.id]);
    await assert.rejects(db.query("SELECT review_recruitment_application($1,'accepted','stale',1)",[row.id]),error=>error.code==='40001');
    assert.equal((await db.query('SELECT private_notes FROM recruitment_applications WHERE id=$1',[row.id])).rows[0].private_notes,'private review');
  });
  await t.test('compatibility writes preserve optimistic notes and old clients preserve manual fields',async()=>{
    await db.query("SELECT save_recruitment_candidate('#PYLQ','watching','original',0)");const manual={language:'compatible',time:'unknown',languages:'العربية',availability:'Evening'};
    const row=(await db.query("SELECT save_recruitment_candidate_details('#PYLQ','shortlisted','kept',1,$1) data",[manual])).rows[0].data;assert.equal(row.version,2);assert.deepEqual(row.manual_compatibility,manual);
    await assert.rejects(db.query("SELECT save_recruitment_candidate_details('#PYLQ','watching','lost',1,$1)",[manual]),error=>error.code==='40001');
    await assert.rejects(db.query("SELECT save_recruitment_candidate_details('#PYLQ','watching','lost',2,'{}')"),error=>error.code==='22023');
    await db.query("SELECT save_recruitment_candidate('#PYLQ','watching','legacy edit',2)");assert.deepEqual((await db.query("SELECT manual_compatibility FROM recruitment_candidates WHERE player_tag='#PYLQ'")).rows[0].manual_compatibility,manual);
  });
  await t.test('daily/global caps and bounded cleanup reject excess applications without removing pending reviews',async()=>{
    await db.query('BEGIN');try{
      await db.query("INSERT INTO recruitment_applications(club_tag,player_tag,message,language,availability,request_id) SELECT '#CLUB','#QQ','','','',gen_random_uuid() FROM generate_series(1,47)");
      assert.equal(await application('#VV','d'.repeat(64)),false);assert.equal((await db.query("SELECT count(*)::int n FROM recruitment_applications WHERE club_tag='#CLUB'")).rows[0].n,50);
    }finally{await db.query('ROLLBACK');}
    await db.query('BEGIN');try{
      await db.query("INSERT INTO recruitment_applications(club_tag,player_tag,message,language,availability,request_id,created_at) SELECT '#CLUB','#QQ','','','',gen_random_uuid(),now()-interval '10 days' FROM generate_series(1,497)");
      assert.equal(await application('#VV','e'.repeat(64)),false);assert.equal((await db.query("SELECT count(*)::int n FROM recruitment_applications WHERE club_tag='#CLUB'")).rows[0].n,500);
    }finally{await db.query('ROLLBACK');}
    await db.query('BEGIN');try{
      await db.query("INSERT INTO recruitment_applications(club_tag,player_tag,message,language,availability,request_id,status,created_at,updated_at) VALUES('#CLUB','#QQ','','','',gen_random_uuid(),'archived',now()-interval '100 days',now()-interval '91 days'),('#CLUB','#VV','','','',gen_random_uuid(),'pending',now()-interval '100 days',now()-interval '100 days');INSERT INTO recruitment_application_limits VALUES('#CLUB',repeat('f',64),current_date-5,3)");
      assert.equal(await application('#CC','d'.repeat(64)),true);
      assert.equal((await db.query("SELECT count(*)::int n FROM recruitment_applications WHERE status='archived'")).rows[0].n,0);
      assert.equal((await db.query("SELECT count(*)::int n FROM recruitment_applications WHERE player_tag='#VV'")).rows[0].n,1);
      assert.equal((await db.query("SELECT count(*)::int n FROM recruitment_application_limits WHERE day<current_date-2")).rows[0].n,0);
    }finally{await db.query('ROLLBACK');}
  });
  await t.test('public roles cannot read administrative rows, infer absence or invoke writes even with permissive defaults',async()=>{
    const queries=['SELECT * FROM member_decision_log','SELECT * FROM member_absences','SELECT * FROM club_administration_settings','SELECT * FROM recruitment_applications','SELECT * FROM recruitment_application_limits',"SELECT member_inactivity_exempt('#CLUB','#PYLQ',now())","SELECT administration_club_tag()",`SELECT append_member_decision('#PYLQ','note','bad','${randomUUID()}')`,`SELECT submit_recruitment_application('#CLUB','#PYLQ','','','','${'c'.repeat(64)}','${randomUUID()}')`];
    for(const role of ['anon','authenticated'])for(const sql of queries){await db.query('BEGIN');try{await db.query('SET LOCAL ROLE '+role);await assert.rejects(db.query(sql),error=>error.code==='42501');}finally{await db.query('ROLLBACK');}}
    await db.query('BEGIN');try{await db.query('SET LOCAL ROLE service_role');assert.equal(typeof(await db.query("SELECT member_inactivity_exempt('#CLUB','#PYLQ',now()) x")).rows[0].x,'boolean');}finally{await db.query('ROLLBACK');}
  });
});
