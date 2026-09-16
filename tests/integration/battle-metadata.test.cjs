const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { loadTypeScript } = require("../helpers/load-typescript.cjs");
const source = process.env.BATTLE_TEST_DATABASE_URL || process.env.SYNC_TEST_DATABASE_URL;
const root = path.resolve(__dirname,"../..");

test("battle metadata, canonical facets and fenced commits use actual PostgreSQL",{skip:!source},async t=>{
  const target=new URL(source);
  assert.ok(["postgres:","postgresql:"].includes(target.protocol));
  assert.ok(["127.0.0.1","localhost","[::1]"].includes(target.hostname));
  assert.match(target.pathname,/^\/brawl_[a-z_]+_tests$/); assert.equal(target.search,"");assert.equal(target.hash,"");
  const loopback=db=>assert.ok(["127.0.0.1","::1"].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/i,"")));
  target.pathname="/postgres";
  const admin=new Client({connectionString:target.href});await admin.connect();
  try { loopback(admin);if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_battle_tests'")).rowCount)await admin.query("CREATE DATABASE brawl_battle_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'"); }
  finally{await admin.end();}
  target.pathname="/brawl_battle_tests";
  const db=new Client({connectionString:target.href});await db.connect();t.after(()=>db.end());loopback(db);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role");
  await db.query(fs.readFileSync(path.join(root,"supabase/schema.sql"),"utf8"));
  await db.query("ALTER TABLE battle_history ADD COLUMN owner_user_id uuid");
  const migrations=fs.readdirSync(path.join(root,"supabase/migrations")).filter(name=>/^20260916\d{4}_.*\.sql$/.test(name)).sort();
  for(const filename of migrations.filter(name=>name<'202609160014_'))await db.query(fs.readFileSync(path.join(root,"supabase/migrations",filename),"utf8"));
  await db.query("INSERT INTO battle_history(player_tag,battle_time,mode,trophy_change) VALUES('#LEGACY',now()-interval '1 hour','megaBoss',0)");
  const legacyVersion=(await db.query("SELECT xmin::text FROM battle_history")).rows[0].xmin;
  const migration=fs.readFileSync(path.join(root,"supabase/migrations/202609160014_battle_metadata.sql"),"utf8");
  await db.query(migration);await db.query(migration);
  const now=Date.now(),at=new Date(now-3600000).toISOString(),since=new Date(now-30*86400000).toISOString(),until=new Date(now+30000).toISOString();
  const reset=async()=>{
    await db.query("TRUNCATE members,member_history,activity_log,club_events,battle_history,daily_stats,player_tracking,brawler_snapshots,notifications,sync_runs,sync_leases,membership_change_events,notification_outbox,member_activity_state,player_brawler_state,sync_battle_coverage,sync_battle_gaps RESTART IDENTITY CASCADE");
    await db.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('notifications_enabled','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  };
  const acquire=async()=> (await db.query("SELECT acquire_sync_run('#CLUB','manual','full',NULL,NULL) x")).rows[0].x;
  const member={player_tag:"#A",player_name:"لاعب",role:"member",trophies:100,highest_trophies:100,exp_level:1,brawlers_count:1,solo_victories:0,duo_victories:0,trio_victories:0};
  const battle=extra=>({player_tag:"#A",battle_time:at,mode:"gemGrab",map:"Map",result:"victory",trophy_change:8,is_star_player:false,...extra});
  const payload=battles=>({members:[member],battles,brawlers:[],battle_observations:[{player_tag:"#A",success:true,battle_times:battles.map(row=>row.battle_time)}],battle_logs_complete:true,ranked_attempted:true,ranked_complete:true});
  const commit=async(run,body)=>(await db.query("SELECT commit_sync_snapshot($1,$2,$3) x",[run.run_id,run.fence,body])).rows[0].x;
  const row=async()=> (await db.query("SELECT *,xmin::text version FROM battle_history ORDER BY battle_time LIMIT 1")).rows[0];
  const daily=async()=> (await db.query("SELECT battles,wins,losses,trophies_gained,trophies_lost,xmin::text version FROM daily_stats ORDER BY date")).rows;
  const facets=async(mode=null,context=null,tags=["#A"],player=null)=>(await db.query("SELECT battle_feed_facets($1,$2,$3,$4,$5,$6) x",[tags,since,until,player,mode,context])).rows[0].x;

  await t.test("additive migration preserves old row identities, ambiguous zeroes and unknown event metadata",async()=>{
    const legacy=await row();assert.equal(legacy.version,legacyVersion);assert.equal(legacy.trophy_change,0);
    for(const field of ["battle_type","event_id","event_mode_id","event_mode","battle_mode","placement_rank","trophy_change_reported"])assert.equal(legacy[field],null);
  });

  await t.test("old payloads preserve unknown provenance; fresh enrichment is idempotent and never doubles daily totals",async()=>{
    await reset();await commit(await acquire(),payload([battle({})]));
    assert.equal((await row()).trophy_change_reported,null);
    const before=await daily();
    const fresh=battle({battle_type:"ranked",event_id:0,event_mode_id:0,event_mode:"gemGrab",battle_mode:"gemGrab",placement_rank:1,trophy_change_reported:true});
    const run=await acquire(),body=payload([fresh]);await commit(run,body);
    const observed=await row();assert.equal(observed.battle_type,"ranked");assert.equal(observed.event_id,0);assert.equal(observed.event_mode_id,0);assert.equal(observed.trophy_change_reported,true);
    assert.deepEqual(await daily(),before,"Metadata-only changes must not touch daily row versions or totals");
    await commit(run,body);assert.equal((await row()).version,observed.version);
    await commit(await acquire(),body);assert.equal((await row()).version,observed.version);assert.deepEqual(await daily(),before);
    await commit(await acquire(),payload([battle({trophy_change:0})]));
    assert.equal((await row()).trophy_change,8,"An older writer's synthetic0 cannot replace a confirmed value");
    assert.equal((await row()).trophy_change_reported,true);assert.equal((await row()).event_mode_id,0);
    assert.equal((await db.query("SELECT last_observation_status FROM sync_battle_coverage")).rows[0].last_observation_status,"observed");
    for(const key of ["last_ranked_attempt_time","last_ranked_sync_time","last_full_sync_time","last_battle_sync_time"])assert.equal((await db.query("SELECT value FROM settings WHERE key=$1",[key])).rowCount,1);
  });

  await t.test("missing points stay NULL, confirmed zero stays zero, omissions preserve known values",async()=>{
    await reset();const missing=battle({trophy_change:null,trophy_change_reported:false,battle_type:"soloRanked"});
    await commit(await acquire(),payload([missing]));assert.equal((await row()).trophy_change,null);assert.equal((await row()).trophy_change_reported,false);
    await commit(await acquire(),payload([{...missing,trophy_change:0,trophy_change_reported:true}]));
    assert.equal((await row()).trophy_change,0);assert.equal((await row()).trophy_change_reported,true);
    await commit(await acquire(),payload([{...missing,battle_type:null}]));
    assert.equal((await row()).trophy_change,0);assert.equal((await row()).trophy_change_reported,true);assert.equal((await row()).battle_type,"soloRanked");
  });

  await t.test("nonladder reported points never inflate trophies while legacy unknown-type history remains compatible",async()=>{
    await reset();const types=[["challenge",1],["ranked",10],[null,5],["soloRanked",50],["friendly",5],["futureType",7]];
    const rows=types.map(([battle_type,trophy_change],i)=>battle({battle_time:new Date(Date.parse(at)+i*1000).toISOString(),battle_type,trophy_change,trophy_change_reported:battle_type!==null}));
    await commit(await acquire(),payload(rows));
    assert.deepEqual((await daily()).map(({battles,wins,losses,trophies_gained,trophies_lost})=>({battles,wins,losses,trophies_gained,trophies_lost})),[{battles:6,wins:6,losses:0,trophies_gained:15,trophies_lost:0}]);
    assert.equal((await db.query("SELECT trophies_gained,total_battles FROM player_tracking")).rows[0].trophies_gained,15);
    assert.equal((await db.query("SELECT sum(trophy_change)::int n FROM battle_history")).rows[0].n,78,"Raw source values remain stored");
  });

  await t.test("new commit retains stale-fence rejection and complete rollback on a late constraint failure",async()=>{
    await reset();const old=await acquire();await db.query("UPDATE sync_leases SET expires_at=now()-interval '1 second'");const current=await acquire();
    await assert.rejects(commit(old,payload([battle({battle_type:"ranked"})])),/stale_sync_fence/);
    assert.equal((await db.query("SELECT count(*)::int n FROM battle_history")).rows[0].n,0);
    const body=payload([battle({battle_type:"ranked",trophy_change_reported:true})]);body.brawlers=[{player_tag:"#A",brawler_id:1,brawler_name:"X".repeat(200),power_level:1,trophies:100,rank:1}];
    await assert.rejects(commit(current,body),/value too long/);
    for(const table of ["battle_history","members","daily_stats","sync_battle_coverage"])assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0,table);
    assert.equal((await db.query("SELECT run_id FROM sync_leases")).rows[0].run_id,current.run_id);
    assert.equal((await commit(current,payload([battle({})]))).success,true);
  });

  await t.test("SQL mode and type classifiers match the shared catalog including zero IDs and unknown future values",async()=>{
    const {normalizeBattleMode,describeBattleContext}=loadTypeScript("src/lib/battle-catalog.ts");
    const modes=JSON.parse(fs.readFileSync(path.join(root,"src/lib/battle-modes.json"),"utf8"));
    for(const mode of modes){
      const result=(await db.query("SELECT battle_feed_mode($1) by_name,battle_feed_mode('internal',$2) by_id",[mode.key.toUpperCase(),mode.id-48000000])).rows[0];
      assert.equal(result.by_name,normalizeBattleMode(mode.key));assert.equal(result.by_id,mode.key);
    }
    for(const [raw,id] of [["airHockey",null],["deathmatch",null],["tagTeam",null],["duoShowdown",38],["internal",0],["futureMode",9999]])assert.equal((await db.query("SELECT battle_feed_mode($1,$2) x",[raw,id])).rows[0].x,normalizeBattleMode(raw,id));
    for(const battle_type of [null,"ranked","soloRanked","teamRanked","CHALLENGE","championshipChallenge","friendly","megaPig","tournament","clubLeague","casual","future"])assert.equal((await db.query("SELECT battle_feed_context($1) x",[battle_type])).rows[0].x,describeBattleContext({battle_type}).key);
  });

  await t.test("full facets reach beyond1500 rows, respect range/player/mode and page RPC is bounded with private columns excluded",async()=>{
    await reset();
    await db.query("INSERT INTO battle_history(player_tag,battle_time,mode,battle_type) SELECT '#A',$1::timestamptz-i*interval '1 second','brawlBall','ranked' FROM generate_series(1,1600)i",[until]);
    await db.query("INSERT INTO battle_history(player_tag,battle_time,mode,battle_type,event_mode_id,owner_user_id) VALUES('#A',$1::timestamptz-interval '20 days','megaBoss',NULL,NULL,'00000000-0000-0000-0000-000000000001'),('#B',$1::timestamptz-interval '19 days','airHockey','soloRanked',45,NULL),('#A',$1::timestamptz-interval '31 days','duels','friendly',NULL,NULL),('#FORMER',$1::timestamptz-interval '1 hour','heist','challenge',NULL,NULL)",[until]);
    const all=await facets(null,null,["#A","#B"]);assert.equal(all.total,1602);assert.equal(all.observationCount,1602);
    assert.deepEqual(all.modes,[{key:"brawlBall",count:1600},{key:"brawlHockey",count:1},{key:"megaBoss",count:1}]);
    const hockey=await facets("airHockey",null,["#A","#B"]);assert.equal(hockey.total,1);assert.deepEqual(hockey.contexts,[{key:"ranked",count:1}]);
    assert.equal((await facets(null,"unknown")).total,1);assert.equal((await facets(null,null,["#A","#B"],"#B")).total,1);
    await db.query("SET ROLE service_role");
    try{
      const page=(await db.query("SELECT * FROM battle_feed_page($1,$2,$3,NULL,'airHockey','ranked',NULL,0,1)",[["#A","#B"],since,until])).rows;
      assert.equal(page.length,1);assert.equal(page[0].mode,"brawlHockey");assert.equal(page[0].event_mode_id,45);assert.equal(Object.hasOwn(page[0],"owner_user_id"),false);
      assert.equal((await db.query("SELECT * FROM battle_feed_page($1,$2,$3,NULL,NULL,NULL,NULL,0,200)",[["#A"],since,until])).rowCount,200);
      await assert.rejects(db.query("SELECT * FROM battle_feed_page($1,$2,$3,NULL,NULL,NULL,NULL,0,201)",[["#A"],since,until]),/invalid_battle_feed_page/);
      await assert.rejects(db.query("SELECT battle_feed_facets($1,$2::timestamptz-interval '91 days',$2)",[["#A"],until]),/invalid_battle_feed_filter/);
    }finally{await db.query("RESET ROLE");}
  });

  await t.test("anonymous and ordinary authenticated roles cannot call feed RPCs or read legacy ownership IDs",async()=>{
    for(const role of ["anon","authenticated"]){await db.query(`SET ROLE ${role}`);try{
      for(const sql of ["SELECT * FROM battle_feed_page(ARRAY['#A'],now()-interval '1 day',now())","SELECT battle_feed_facets(ARRAY['#A'],now()-interval '1 day',now())","SELECT owner_user_id FROM battle_history","SELECT commit_sync_snapshot(gen_random_uuid(),1,'{}')"])await assert.rejects(db.query(sql),error=>error.code==="42501");
      assert.ok((await db.query("SELECT player_tag FROM battle_history LIMIT 1")).rowCount>0);
    }finally{await db.query("RESET ROLE");}}
  });
});
