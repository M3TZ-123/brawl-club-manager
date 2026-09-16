const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
const source=process.env.SECURITY_TEST_DATABASE_URL||process.env.SYNC_TEST_DATABASE_URL||process.env.BACKUP_TEST_DATABASE_URL;
const root=path.resolve(__dirname,'../..');

test('backup capture and sync admission coordinate across independent PostgreSQL sessions',{skip:!source},async t=>{
  const url=new URL(source);assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
  assert.match(url.pathname,/^\/brawl_[a-z_]+_tests$/);assert.equal(url.search,'');assert.equal(url.hash,'');
  const loopback=db=>assert.ok(['127.0.0.1','::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/i,'')));
  url.pathname='/postgres';const admin=new Client({connectionString:url.href});await admin.connect();
  try{loopback(admin);if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_backup_sync_tests'")).rowCount)await admin.query("CREATE DATABASE brawl_backup_sync_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");}finally{await admin.end();}
  url.pathname='/brawl_backup_sync_tests';const writer=new Client({connectionString:url.href}),other=new Client({connectionString:url.href});
  await writer.connect();await other.connect();t.after(async()=>{await writer.end();await other.end();});loopback(writer);loopback(other);
  assert.equal((await writer.query('SELECT current_database() name')).rows[0].name,'brawl_backup_sync_tests');
  await writer.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public;GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role');
  await writer.query(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
  const directory=path.join(root,'supabase/migrations');
  for(const file of fs.readdirSync(directory).filter(name=>/^20260916\d{4}_.*\.sql$/.test(name)&&name<'202609160029_').sort())await writer.query(fs.readFileSync(path.join(directory,file),'utf8'));
  await writer.query(fs.readFileSync(path.join(directory,'202609160028_backup_sync_coordination.sql'),'utf8'));
  await writer.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB') ON CONFLICT(key)DO UPDATE SET value=excluded.value;INSERT INTO members(player_tag,player_name,trophies)VALUES('#PLAYER','Player',100)");
  const reset=async()=>writer.query('TRUNCATE backup_snapshots,sync_leases,sync_runs CASCADE');
  const acquire=async(db=writer,key=randomUUID(),scope='roster',tag=null)=>(await db.query("SELECT acquire_sync_run('#CLUB','manual',$1,$2,$3) data",[scope,tag,key])).rows[0].data;
  const snapshot=async(db=writer,id=randomUUID())=>(await db.query('SELECT create_backup_snapshot($1) data',[id])).rows[0].data;
  const release=async run=>writer.query("SELECT fail_sync_run($1,$2,'test_failure','Fixture failure')",[run.run_id,run.fence]);
  const commit=async run=>(await writer.query('SELECT commit_roster_snapshot($1,$2,$3) data',[run.run_id,run.fence,{members:[{player_tag:'#PLAYER',player_name:'Player',role:'member',trophies:100,icon_id:null}],required_trophies:0}])).rows[0].data;
  const count=async table=>Number((await writer.query(`SELECT count(*) n FROM public.${table}`)).rows[0].n);

  await t.test('a snapshot already holding table locks rejects new sync admission immediately without creating a lease or run',async()=>{
    await reset();await writer.query('BEGIN');
    try{
      await snapshot(writer);await other.query("SET statement_timeout='300ms'");
      const result=await acquire(other,'after-backup');assert.deepEqual(result,{acquired:false,busy:true,backup_busy:true});
      assert.equal(await count('sync_leases'),0);assert.equal(await count('sync_runs'),0);
    }finally{await writer.query('ROLLBACK');await other.query('RESET statement_timeout');}
    const admitted=await acquire(other,'after-backup');assert.equal(admitted.acquired,true);await release(admitted);
  });

  await t.test('an uncommitted admission blocks the snapshot mutex, then its committed durable lease blocks capture',async()=>{
    await reset();await writer.query('BEGIN');let run;
    try{
      run=await acquire(writer,'admission-in-flight');
      assert.equal((await other.query('SELECT count(*)::int n FROM sync_leases')).rows[0].n,0,'The lease is still invisible to the backup transaction');
      await assert.rejects(snapshot(other),error=>error.code==='55P03'&&error.message==='backup_busy');
      assert.equal(await count('backup_snapshots'),0);await writer.query('COMMIT');
    }catch(error){await writer.query('ROLLBACK');throw error;}
    await assert.rejects(snapshot(other),error=>error.code==='55P03'&&error.message==='backup_sync_active');
    assert.equal(await count('backup_snapshots'),0);await release(run);assert.equal((await snapshot(other)).status,'ready');
  });

  await t.test('a live lease is checked before table locking and a rejected backup cannot block its later commit',async()=>{
    await reset();const run=await acquire();await writer.query('BEGIN;LOCK TABLE members IN ROW EXCLUSIVE MODE');
    try{await assert.rejects(snapshot(other),error=>error.code==='55P03'&&error.message==='backup_sync_active');}
    finally{await writer.query('ROLLBACK');}
    assert.equal(await count('backup_snapshots'),0);assert.equal((await commit(run)).success,true);
    assert.equal((await snapshot(other)).status,'ready');
  });

  await t.test('successful and failed idempotent outcomes remain replayable during a backup, without scope confusion or new writes',async()=>{
    await reset();const successRun=await acquire(writer,'successful');const success=await commit(successRun);
    const failed=await acquire(writer,'failed');await release(failed);
    await writer.query('BEGIN');
    try{
      await snapshot(writer);await other.query("SET statement_timeout='300ms'");
      const replay=await acquire(other,'successful');assert.equal(replay.replayed,true);assert.equal(replay.status,'succeeded');assert.deepEqual(replay.result,success);
      const failedReplay=await acquire(other,'failed');assert.equal(failedReplay.replayed,true);assert.equal(failedReplay.status,'failed');assert.equal(failedReplay.error_code,'test_failure');
      await assert.rejects(acquire(other,'successful','member','#PLAYER'),error=>error.code==='22023'&&error.message==='idempotency_scope_mismatch');
      assert.equal(await count('sync_runs'),2);assert.equal(await count('sync_leases'),1);
    }finally{await writer.query('ROLLBACK');await other.query('RESET statement_timeout');}
  });

  await t.test('expired leases permit snapshots but remain fenced, and an existing snapshot can be resumed during a live run',async()=>{
    await reset();const old=await acquire(writer,'expired');await writer.query("UPDATE sync_leases SET expires_at=clock_timestamp()-interval '1 second'");
    const id=randomUUID();assert.equal((await snapshot(other,id)).status,'ready');await assert.rejects(commit(old),/stale_sync_fence/);
    const replacement=await acquire(writer,'replacement');assert.equal(replacement.acquired,true);assert.ok(replacement.fence>old.fence);
    assert.equal((await snapshot(other,id)).snapshot_id,id,'An existing snapshot replay never takes table locks');
    await assert.rejects(snapshot(other),error=>error.code==='55P03'&&error.message==='backup_sync_active');await release(replacement);
  });

  await t.test('service-only permissions and function configuration survive reapplication',async()=>{
    for(const role of ['anon','authenticated','service_role']){await other.query(`SET ROLE ${role}`);try{
      if(role==='service_role'){const run=await acquire(other);assert.equal(run.acquired,true);await release(run);}
      else{await assert.rejects(acquire(other),error=>error.code==='42501');await assert.rejects(snapshot(other),error=>error.code==='42501');}
    }finally{await other.query('RESET ROLE');}}
    const config=(await writer.query("SELECT proconfig FROM pg_proc WHERE oid='public.create_backup_snapshot(uuid)'::regprocedure")).rows[0].proconfig;
    assert.ok(config.includes('search_path=pg_catalog'));assert.ok(config.includes('statement_timeout=50s'));
  });
});
