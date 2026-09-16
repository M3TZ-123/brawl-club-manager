const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const{Client}=require('pg');const{randomUUID}=require('node:crypto');
const source=process.env.SECURITY_TEST_DATABASE_URL;const root=path.resolve(__dirname,'../..');
test('rival roster cache and prospective ranking history stay bounded and private',{skip:!source},async t=>{
  const url=new URL(source);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/brawl_security_tests');url.pathname='/postgres';
  const admin=new Client({connectionString:url.href});await admin.connect();assert.ok(['127.0.0.1','::1'].includes(admin.connection.stream.remoteAddress.replace(/^::ffff:/,'')));
  try{if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_rivals_tests'")).rowCount)await admin.query("CREATE DATABASE brawl_rivals_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");}finally{await admin.end();}
  url.pathname='/brawl_rivals_tests';const db=new Client({connectionString:url.href});await db.connect();t.after(()=>db.end());
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
  await db.query(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
  for(const file of ['202609160001_sync_durability.sql','202609160022_game_cache.sql','202609160032_club_rivals.sql'])await db.query(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8'));
  const club='#QQQQ',tag='#PYLQ';const save=(tag,active=true)=>db.query('SELECT save_club_rival($1,$2,$3)',[club,tag,active]);
  const claim=async(token,tagValue=tag)=>(await db.query('SELECT claim_club_rival($1,$2,$3) x',[club,tagValue,token])).rows[0].x;
  const p={tag,name:'Club',description:'',type:'open',badgeId:1,trophies:100,rosterTrophies:100,requiredTrophies:0,memberCount:2,medianTrophies:50,averageTrophies:50,lowestTrophies:20,highestTrophies:80};
  const finish=async(token,payload)=>(await db.query('SELECT finish_club_rival($1,$2,$3,$4) x',[club,tag,token,payload?JSON.stringify(payload):null])).rows[0].x;
  await t.test('only five active rivals, scoped to the managed club, without roster mutation',async()=>{
    for(const value of [tag,'#PYY','#PLL','#PGG','#PVV'])await save(value);
    await assert.rejects(save('#PUU'),e=>e.code==='54000');await save('#PVV',false);await save('#PUU');
    await assert.rejects(save(club),e=>e.code==='22023');assert.equal(Number((await db.query('SELECT count(*) n FROM members')).rows[0].n),0);
  });
  await t.test('lease fencing, six-hour cache and soft removal preserve truthful snapshots',async()=>{
    const token=randomUUID();assert.equal((await claim(token)).acquired,true);assert.equal((await claim(randomUUID())).acquired,false);assert.equal(await finish(randomUUID(),p),false);assert.equal(await finish(token,p),true);
    assert.equal((await claim(randomUUID())).acquired,false);const row=(await db.query('SELECT * FROM club_rivals WHERE club_tag=$1 AND rival_tag=$2',[club,tag])).rows[0];assert.equal((row.expires_at-row.fetched_at)/3600000,6);
    await db.query('UPDATE club_rivals SET expires_at=now()-interval \'1 second\' WHERE club_tag=$1 AND rival_tag=$2',[club,tag]);const retry=randomUUID();assert.equal((await claim(retry)).acquired,true);assert.equal(await finish(retry),true);assert.equal((await claim(randomUUID())).entry.profile.name,'Club');
    await save(tag,false);assert.equal(await claim(randomUUID()),null);assert.equal(Number((await db.query('SELECT count(*) n FROM club_rival_snapshots')).rows[0].n),1);await save(tag);
  });
  await t.test('shared upstream pause blocks new competitor requests',async()=>{
    await db.query("INSERT INTO settings(key,value) VALUES('sync_upstream_cooldown_until',(now()+interval '2 minutes')::text) ON CONFLICT(key) DO UPDATE SET value=excluded.value");assert.equal((await claim(randomUUID(),'#PYY')).acquired,false);await db.query("DELETE FROM settings WHERE key='sync_upstream_cooldown_until'");
  });
  await t.test('rank history records only tracked clubs and preserves missing top50 ranks as null',async()=>{
    await db.query("INSERT INTO settings(key,value) VALUES('club_tag',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[club]);
    const token=randomUUID();await db.query("SELECT claim_game_cache('rankings:TN:clubs',$1)",[token]);
    await db.query("SELECT finish_game_cache('rankings:TN:clubs',$1,$2)",[token,JSON.stringify([{tag:club,rank:3,trophies:500},{tag,rank:8,trophies:100},{tag:'#9999',rank:1,trophies:999}])]);
    const rows=(await db.query('SELECT * FROM club_rank_history ORDER BY observed_tag')).rows;assert.equal(rows.length,6);assert.equal(rows.find(r=>r.observed_tag===club).rank,3);assert.equal(rows.find(r=>r.observed_tag==='#PYY').rank,null);assert.equal(rows.some(r=>r.observed_tag==='#9999'),false);
    const again=randomUUID();await db.query("UPDATE game_api_cache SET expires_at=now()-interval '1 second' WHERE cache_key='rankings:TN:clubs'");await db.query("SELECT claim_game_cache('rankings:TN:clubs',$1)",[again]);await db.query("SELECT finish_game_cache('rankings:TN:clubs',$1,'[]')",[again]);assert.equal(Number((await db.query('SELECT count(*) n FROM club_rank_history')).rows[0].n),6);assert.equal((await db.query('SELECT rank FROM club_rank_history WHERE observed_tag=$1',[club])).rows[0].rank,null);
  });
  await t.test('public database roles cannot access cache leases or write comparison configuration',async()=>{
    for(const role of ['anon','authenticated'])for(const sql of ['SELECT * FROM club_rivals','SELECT * FROM club_rival_snapshots','SELECT * FROM club_rank_history',`SELECT save_club_rival('${club}','${tag}',false)`,`SELECT claim_club_rival('${club}','${tag}','${randomUUID()}')`]){await db.query('BEGIN');try{await db.query('SET LOCAL ROLE '+role);await assert.rejects(db.query(sql),e=>e.code==='42501');}finally{await db.query('ROLLBACK');}}
  });
});
