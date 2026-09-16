const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const{Client}=require('pg');const{randomUUID}=require('node:crypto');
const source=process.env.SECURITY_TEST_DATABASE_URL;const root=path.resolve(__dirname,'../..');
test('shared official cache and private recruitment enforce leases, bounded storage and access',{skip:!source},async t=>{
  const url=new URL(source);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/brawl_security_tests');url.pathname='/postgres';
  const admin=new Client({connectionString:url.href});await admin.connect();assert.ok(['127.0.0.1','::1'].includes(admin.connection.stream.remoteAddress.replace(/^::ffff:/,'')));
  try{if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_game_tests'")).rowCount)await admin.query("CREATE DATABASE brawl_game_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");}finally{await admin.end();}
  url.pathname='/brawl_game_tests';const db=new Client({connectionString:url.href});await db.connect();t.after(()=>db.end());
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
  for(const file of ['202609160001_sync_durability.sql','202609160022_game_cache.sql','202609160023_recruitment.sql'])await db.query(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8'));
  const claim=async(key,token)=>(await db.query('SELECT public.claim_game_cache($1,$2) x',[key,token])).rows[0].x;
  const finish=async(key,token,payload)=>(await db.query('SELECT public.finish_game_cache($1,$2,$3) x',[key,token,payload===undefined?null:JSON.stringify(payload)])).rows[0].x;
  await t.test('one durable cache lease survives contention and cannot be finished by a stale worker',async()=>{
    const token=randomUUID();assert.equal((await claim('events',token)).acquired,true);assert.equal((await claim('events',randomUUID())).acquired,false);
    assert.equal(await finish('events',randomUUID(),[]),false);assert.equal(await finish('events',token,[{map:'Known'}]),true);
    const cached=await claim('events',randomUUID());assert.equal(cached.acquired,false);assert.deepEqual(cached.entry.payload,[{map:'Known'}]);assert.equal(cached.entry.lease_token,undefined);
    await db.query("UPDATE game_api_cache SET expires_at=now()-interval '1 minute' WHERE cache_key='events'");
    const failed=randomUUID();assert.equal((await claim('events',failed)).acquired,true);assert.equal(await finish('events',failed),true);
    assert.equal((await claim('events',randomUUID())).acquired,false);assert.deepEqual((await claim('events',randomUUID())).entry.payload,[{map:'Known'}]);
    await assert.rejects(claim('arbitrary-unbounded-key',randomUUID()),e=>e.code==='23514');
  });
  await t.test('upstream cooldown blocks a new cache worker',async()=>{
    await db.query("INSERT INTO settings(key,value) VALUES('sync_upstream_cooldown_until',(now()+interval '2 minutes')::text) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    assert.equal((await claim('rankings:TN:players',randomUUID())).acquired,false);
    await db.query("DELETE FROM settings WHERE key='sync_upstream_cooldown_until'");
  });
  await t.test('a contended cache claim starts its lease after the row lock is released',async()=>{
    const contender=new Client({connectionString:url.href});await contender.connect();
    try{
      assert.ok(['127.0.0.1','::1'].includes(contender.connection.stream.remoteAddress.replace(/^::ffff:/,'')));
      await db.query("UPDATE game_api_cache SET expires_at=NULL,retry_at=NULL,lease_token=NULL,lease_until=NULL WHERE cache_key='events'");
      await db.query('BEGIN');
      try{
        await db.query("SELECT 1 FROM game_api_cache WHERE cache_key='events' FOR UPDATE");
        const pid=(await contender.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const pending=contender.query("SELECT claim_game_cache('events',$1) x",[randomUUID()]);
        let waiting=false;
        for(let i=0;i<100;i++){
          waiting=(await db.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting;
          if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(waiting,true);await db.query('SELECT pg_sleep(0.35)');
        const released=(await db.query('SELECT clock_timestamp() at')).rows[0].at.getTime();await db.query('COMMIT');
        assert.equal((await pending).rows[0].x.acquired,true);
        const expiry=(await db.query("SELECT lease_until FROM game_api_cache WHERE cache_key='events'")).rows[0].lease_until.getTime();
        assert.ok(expiry-released>=14900,'Lock wait must not consume the new15-second worker lease');
      }catch(error){await db.query('ROLLBACK');throw error;}
    }finally{await contender.end();}
  });
  await t.test('candidate revision prevents lost notes and hourly refresh preserves them',async()=>{
    await db.query("ALTER TABLE recruitment_candidates ADD COLUMN private_future text DEFAULT 'PRIVATE'");
    const save=async(status,notes,version)=>(await db.query("SELECT public.save_recruitment_candidate('#PYLQ',$1,$2,$3) x",[status,notes,version])).rows[0].x;
    const created=await save('watching','ملاحظة خاصة',0);assert.equal(created.version,1);assert.equal(created.refresh_token,undefined);
    assert.equal(created.private_future,undefined);
    await save('shortlisted','updated',1);await assert.rejects(save('archived','lost update',1),e=>e.code==='40001');
    const token=randomUUID();assert.equal((await db.query("SELECT public.claim_recruitment_refresh('#PYLQ',$1) x",[token])).rows[0].x,true);
    assert.equal((await db.query("SELECT public.claim_recruitment_refresh('#PYLQ',$1) x",[randomUUID()])).rows[0].x,false);
    await db.query("SELECT public.finish_recruitment_refresh('#PYLQ',$1,'{\"name\":\"Player\",\"trophies\":100}')",[token]);
    assert.equal((await db.query("SELECT public.claim_recruitment_refresh('#PYLQ',$1) x",[randomUUID()])).rows[0].x,false);
    const row=(await db.query("SELECT * FROM recruitment_candidates WHERE player_tag='#PYLQ'")).rows[0];assert.equal(row.notes,'updated');assert.equal(row.status,'shortlisted');assert.equal(row.version,2);
  });
  await t.test('public roles cannot read private tables or invoke their mutation functions',async()=>{
    for(const role of ['anon','authenticated'])for(const sql of ['SELECT * FROM game_api_cache','SELECT * FROM recruitment_candidates',`SELECT public.claim_game_cache('events','${randomUUID()}')`,`SELECT public.save_recruitment_candidate('#PYLQ','watching','stolen',2)`]){
      await db.query('BEGIN');try{await db.query('SET LOCAL ROLE '+role);await assert.rejects(db.query(sql),e=>e.code==='42501');}finally{await db.query('ROLLBACK');}
    }
  });
});
