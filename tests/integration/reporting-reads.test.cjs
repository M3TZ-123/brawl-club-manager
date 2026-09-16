const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {Client}=require("pg");
const source=process.env.REPORTING_READS_TEST_DATABASE_URL||process.env.SECURITY_TEST_DATABASE_URL||process.env.SYNC_TEST_DATABASE_URL;
const root=path.resolve(__dirname,"../..");
const now="2026-09-16T12:00:00.000Z";
const ago=days=>new Date(Date.parse(now)-days*86400000).toISOString();

test("reporting read RPCs preserve UTC semantics, real baselines and private permissions",{skip:!source},async t=>{
  const url=new URL(source);assert.ok(["postgres:","postgresql:"].includes(url.protocol));assert.ok(["127.0.0.1","localhost","[::1]"].includes(url.hostname));
  assert.match(url.pathname,/^\/brawl_[a-z_]+_tests$/);assert.equal(url.search,"");assert.equal(url.hash,"");
  const loopback=db=>assert.ok(["127.0.0.1","::1"].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/i,"")));
  url.pathname="/postgres";const admin=new Client({connectionString:url.href});await admin.connect();
  try{loopback(admin);if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_reporting_reads_tests'")).rowCount)await admin.query("CREATE DATABASE brawl_reporting_reads_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");}finally{await admin.end();}
  url.pathname="/brawl_reporting_reads_tests";const db=new Client({connectionString:url.href});await db.connect();t.after(()=>db.end());loopback(db);
  assert.equal((await db.query("SELECT current_database() name")).rows[0].name,"brawl_reporting_reads_tests");
  await db.query("DROP SCHEMA public CASCADE;CREATE SCHEMA public;GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role");
  await db.query(fs.readFileSync(path.join(root,"supabase/schema.sql"),"utf8"));
  await db.query("ALTER TABLE members ADD COLUMN owner_user_id uuid,ADD COLUMN private_future text;ALTER TABLE daily_stats ADD COLUMN owner_user_id uuid;ALTER TABLE notifications ADD COLUMN owner_user_id uuid");
  for(const file of ["202609160001_sync_durability.sql","202609160002_admin_privacy.sql","202609160012_reporting_ranges.sql","202609160017_reporting_reads.sql"])await db.query(fs.readFileSync(path.join(root,"supabase/migrations",file),"utf8"));
  await db.query(fs.readFileSync(path.join(root,"supabase/migrations/202609160017_reporting_reads.sql"),"utf8"));
  await db.query("INSERT INTO members(player_tag,player_name,trophies,role,owner_user_id,private_future) VALUES('#A','علي',1000,'member','00000000-0000-0000-0000-000000000001','PRIVATE'),('#B','B',2000,'senior',NULL,'PRIVATE'),('#C','C',3000,'member',NULL,'PRIVATE'),('#FORMER','Former',9000,'member',NULL,'PRIVATE')");
  await db.query("INSERT INTO member_history(player_tag,player_name,is_current_member,notes) VALUES('#A','علي',true,'SECRET'),('#B','B',true,'SECRET'),('#C','C',true,'SECRET'),('#FORMER','Former',false,'SECRET'),('#MISSING','Missing',true,'SECRET')");
  await db.query("INSERT INTO settings(key,value) VALUES('inactivity_threshold','96'),('last_sync_time',$1),('scheduler_token','SECRET'),('api_key','SECRET') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[now]);
  await db.query("INSERT INTO member_activity_state(player_tag,last_activity_at,last_battle_at) VALUES('#A',$1,$1),('#B',$2,$2),('#C',$3,$3)",[ago(1),ago(4),new Date(Date.parse(now)+61000).toISOString()]);
  for(const [days,trophies] of [[1,1000],[3,1003],[7,980],[30,700],[90,100]])await db.query("INSERT INTO activity_log(player_tag,trophies,recorded_at) VALUES('#A',$1,$2)",[trophies,ago(days)]);
  await db.query("INSERT INTO activity_log(player_tag,trophies,recorded_at) VALUES('#C',2900,$1::timestamptz-interval '91 days 1 microsecond'),('#C',2990,$1::timestamptz-interval '89 days 23 hours'),('#C',2900,$1::timestamptz-interval '31 days')",[now]);
  await db.query("INSERT INTO daily_stats(player_tag,date,battles,wins,losses,star_player,trophies_gained) SELECT tag,($1::timestamptz AT TIME ZONE 'UTC')::date-i,1,1,0,1,999 FROM unnest(ARRAY['#A','#B']) tag CROSS JOIN generate_series(0,119)i",[now]);
  await db.query("INSERT INTO daily_stats(player_tag,date,battles,wins) VALUES('#A','2026-09-17',999,999),('#FORMER','2026-09-16',999,999),('#MISSING','2026-09-16',999,999)");
  await db.query("INSERT INTO player_tracking(player_tag,total_battles,total_wins,current_streak) VALUES('#A',999999,999999,999)");
  for(const days of [0,2,6,29,89,90,-1]){
    const timestamp=ago(days).slice(0,10)+"T01:00:00.000Z";
    await db.query("INSERT INTO club_events(event_type,player_tag,player_name,event_time) VALUES('join','#A','علي',$1)",[timestamp]);
    await db.query("INSERT INTO notifications(type,title,message,created_at,dedupe_key) VALUES('name_change','Public','Public',$1,'name-'||$2),('promotion','Public','Public',$1,'promotion-'||$2)",[timestamp,String(days)]);
  }
  const read=async(name,days,pNow=now)=>(await db.query(`SELECT public.${name}($1,$2) data`,[days,pNow])).rows[0].data;
  const methods=["report_dashboard_read","report_leaderboard_read"];

  await t.test("both RPCs select the same current roster and preserve all five account baseline results",async()=>{
    const expected={1:0,3:-3,7:20,30:300,90:900};
    const canonical=(await db.query("SELECT * FROM sync_activity_summary_v2(ARRAY['#A','#B','#C'],$1)",[now])).rows;
    for(const [days,key] of [[1,"24h"],[3,"3d"],[7,"7d"],[30,"30d"],[90,"90d"]]){
      const dashboard=await read(methods[0],days),board=await read(methods[1],days);
      assert.deepEqual(dashboard.members.map(row=>row.player_tag).sort(),["#A","#B","#C"]);assert.deepEqual(board.members.map(row=>row.player_tag),["#A","#B","#C"]);
      assert.equal(board.members.find(row=>row.player_tag==="#A").trophyChange,expected[days]);
      for(const member of board.members){
        assert.equal(member.trophyChange,canonical.find(row=>row.player_tag===member.player_tag)[`trophies_${key}`]);
        assert.equal(dashboard.members.find(row=>row.player_tag===member.player_tag)[`trophies_${key}`],member.trophyChange);
      }
      assert.equal(board.members.find(row=>row.player_tag==="#B").trophyChange,null,"Battle trophy totals cannot invent account progress");
      assert.equal(dashboard.inactivityThreshold,"96");assert.equal(dashboard.lastSyncTime,now);
    }
  });

  await t.test("daily totals include only selected UTC dates and do not load stale tracking substitutes",async()=>{
    for(const days of [1,3,7,30,90]){
      const result=await read(methods[1],days);
      assert.equal(result.members.reduce((sum,row)=>sum+row.battles,0),days*2);
      for(const tag of ["#A","#B"]){const row=result.members.find(member=>member.player_tag===tag);assert.equal(row.activeDays,days);assert.equal(row.wins,days);assert.equal(row.starPlayer,days);}
      assert.equal(result.members.find(row=>row.player_tag==="#C").battles,0);
      assert.doesNotMatch(JSON.stringify(result),/allTime|current_streak|999999|trophies_gained|trophies_lost/);
    }
  });

  await t.test("change counts and recent events keep inclusive UTC period bounds and exclude future records",async()=>{
    for(const [days,count] of [[1,1],[3,2],[7,3],[30,4],[90,5]]){
      const result=await read(methods[0],days);
      assert.deepEqual(result.changeCounts,{joins:count,leaves:0,nameChanges:count,roleChanges:count});
      assert.equal(result.recentEvents.length,Math.min(count,5));
      assert.ok(result.recentEvents.every(row=>Date.parse(row.event_time)<=Date.parse(now)));
    }
    for(const pNow of ["2024-03-01T00:15:00+02:00","2026-01-01T00:15:00Z"]){
      await db.query("BEGIN");try{
        const end=new Date(pNow),start=end.toISOString().slice(0,10)+"T00:00:00.000Z";
        await db.query("INSERT INTO club_events(event_type,player_tag,player_name,event_time) VALUES('leave','#A','علي',$1),('leave','#A','علي',$2),('leave','#A','علي',$1::timestamptz-interval '1 microsecond'),('leave','#A','علي',$2::timestamptz+interval '1 microsecond')",[start,end.toISOString()]);
        assert.equal((await read(methods[0],1,pNow)).changeCounts.leaves,2);
      }finally{await db.query("ROLLBACK");}
    }
  });

  await t.test("large retained history is aggregated to at most one public object per current member",async()=>{
    await db.query("BEGIN");try{
      await db.query("INSERT INTO members(player_tag,player_name,trophies) SELECT '#P'||i,'Player'||i,1000 FROM generate_series(1,30)i;INSERT INTO member_history(player_tag,player_name,is_current_member) SELECT '#P'||i,'Player'||i,true FROM generate_series(1,30)i");
      await db.query("INSERT INTO daily_stats(player_tag,date,battles,wins) SELECT '#P'||i,($1::timestamptz AT TIME ZONE 'UTC')::date-d,1,1 FROM generate_series(1,30)i CROSS JOIN generate_series(0,364)d",[now]);
      const result=await read(methods[1],90);assert.equal(result.members.length,33);
      for(const member of result.members.filter(row=>row.player_tag.startsWith("#P")))assert.equal(member.battles,90);
      assert.ok(Buffer.byteLength(JSON.stringify(result))<15000,"Do not ship retained daily rows or repeated history to the API server");
    }finally{await db.query("ROLLBACK");}
  });

  await t.test("public DTOs exclude private and future columns; functions remain bounded and read-only",async()=>{
    const before=(await db.query("SELECT count(*)::int n FROM activity_log")).rows[0].n;
    for(const method of methods){
      const result=await read(method,7);assert.doesNotMatch(JSON.stringify(result),/owner_user_id|private_future|notes|PRIVATE|SECRET|scheduler_token|api_key/);
      for(const days of [0,2,91,365,null])await assert.rejects(read(method,days),error=>error.code==="22023");
      await assert.rejects(read(method,7,null),error=>error.code==="22023");await assert.rejects(read(method,7,"infinity"),error=>error.code==="22023");
    }
    assert.equal((await db.query("SELECT count(*)::int n FROM activity_log")).rows[0].n,before);
    await db.query("BEGIN");try{
      await db.query("INSERT INTO member_history(player_tag,player_name,is_current_member) SELECT '#EXTRA'||i,'Extra'||i,true FROM generate_series(1,101)i");
      for(const method of methods){await db.query("SAVEPOINT roster_limit");await assert.rejects(read(method,7),error=>error.code==="22023");await db.query("ROLLBACK TO SAVEPOINT roster_limit;RELEASE SAVEPOINT roster_limit");}
    }finally{await db.query("ROLLBACK");}
  });

  await t.test("service role can read, while anon and authenticated cannot invoke security-definer reporting",async()=>{
    const functions=(await db.query("SELECT proname,provolatile,prosecdef,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1)",[methods])).rows;
    assert.equal(functions.length,2);for(const fn of functions){assert.equal(fn.provolatile,"s");assert.equal(fn.prosecdef,true);assert.ok(fn.proconfig.includes("search_path=pg_catalog, pg_temp"));}
    // A checked-out Client keeps role changes and failed requests on one session.
    for(const role of ["anon","authenticated","service_role"]){await db.query(`SET ROLE ${role}`);try{
      for(const method of methods){if(role==="service_role")assert.equal((await read(method,7)).members.length,3);else await assert.rejects(read(method,7),error=>error.code==="42501");}
    }finally{await db.query("RESET ROLE");}}
  });
});
