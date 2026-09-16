const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {Client}=require("pg");
const source=process.env.ANALYSIS_TEST_DATABASE_URL||process.env.SECURITY_TEST_DATABASE_URL||process.env.SYNC_TEST_DATABASE_URL;
const root=path.resolve(__dirname,"../..");
const now="2026-09-16T12:00:00.000Z";
const ago=days=>new Date(Date.parse(now)-days*86400000).toISOString();

test("club analysis and readiness use real bounded PostgreSQL aggregates and private permissions",{skip:!source},async t=>{
  const url=new URL(source);assert.ok(["postgres:","postgresql:"].includes(url.protocol));assert.ok(["127.0.0.1","localhost","[::1]"].includes(url.hostname));
  assert.match(url.pathname,/^\/brawl_[a-z_]+_tests$/);assert.equal(url.search,"");assert.equal(url.hash,"");
  const loopback=db=>assert.ok(["127.0.0.1","::1"].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/i,"")));
  url.pathname="/postgres";const admin=new Client({connectionString:url.href});await admin.connect();
  try{loopback(admin);if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_analysis_tests'")).rowCount)await admin.query("CREATE DATABASE brawl_analysis_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");}finally{await admin.end();}
  url.pathname="/brawl_analysis_tests";const db=new Client({connectionString:url.href});await db.connect();t.after(()=>db.end());loopback(db);
  assert.equal((await db.query("SELECT current_database() name")).rows[0].name,"brawl_analysis_tests");
  await db.query("DROP SCHEMA public CASCADE;CREATE SCHEMA public;GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role");
  await db.query(fs.readFileSync(path.join(root,"supabase/schema.sql"),"utf8"));
  await db.query("ALTER TABLE members ADD COLUMN owner_user_id uuid;ALTER TABLE battle_history ADD COLUMN owner_user_id uuid,ADD COLUMN private_future text");
  const migrationDir=path.join(root,"supabase/migrations");
  const files=fs.readdirSync(migrationDir).filter(name=>/^20260916\d{4}_.*\.sql$/.test(name)&&name<"202609160022_").sort();
  assert.ok(files.some(name=>name.startsWith("202609160020_")),"Progress schema020 must exist before analysis021");
  for(const file of files)await db.query(fs.readFileSync(path.join(migrationDir,file),"utf8"));
  await db.query(fs.readFileSync(path.join(migrationDir,"202609160021_club_analysis.sql"),"utf8"));
  await db.query(fs.readFileSync(path.join(migrationDir,"202609160026_analysis_team_reads.sql"),"utf8"));
  await db.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB'),('scheduler_token','SECRET'),('api_key','SECRET') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  await db.query("INSERT INTO members(player_tag,player_name,trophies,owner_user_id) VALUES('#A','علي',1000,'00000000-0000-0000-0000-000000000001'),('#B','B',1000,NULL),('#D','D',1000,NULL),('#EMPTY','Empty',1000,NULL),('#FORMER','Former',1000,NULL)");
  await db.query("INSERT INTO member_history(player_tag,player_name,is_current_member,notes) SELECT player_tag,player_name,player_tag<>'#FORMER','SECRET' FROM members;INSERT INTO member_history(player_tag,player_name,is_current_member)VALUES('#MISSING','Missing',true)");
  const analysis=async(days=7,context=null,mode=null,map=null,brawler=null,pNow=now)=>(await db.query("SELECT club_analysis_read($1,$2,$3,$4,$5,$6) data",[days,pNow,context,mode,map,brawler])).rows[0].data;
  const ready=async(brawler=null,min=0,search=null,offset=0,limit=100,pNow=now)=>(await db.query("SELECT club_readiness_read($1,$2,$3,$4,$5,$6) data",[pNow,brawler,min,search,offset,limit])).rows[0].data;
  const team=[[{tag:"#A"},{tag:"#B"},{tag:"#C"}],[{tag:"#D"},{tag:"#X"},{tag:"#Y"}]];
  const add=async(tag,time,extra={})=>{
    const row={mode:"gemGrab",event_mode:null,event_mode_id:null,map:"Map",brawler_name:"Shelly",result:"victory",battle_type:"ranked",duration_seconds:null,teams_json:null,...extra};
    await db.query("INSERT INTO battle_history(player_tag,battle_time,mode,event_mode,event_mode_id,map,brawler_name,result,battle_type,duration_seconds,teams_json,private_future) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'SECRET')",[tag,time,row.mode,row.event_mode,row.event_mode_id,row.map,row.brawler_name,row.result,row.battle_type,row.duration_seconds,row.teams_json==null?null:JSON.stringify(row.teams_json)]);
  };

  await t.test("same-team pairs deduplicate member observations and never include club opponents or solo lists",async()=>{
    await db.query("TRUNCATE battle_history");
    for(const tag of ["#A","#B"])await add(tag,ago(0.25),{teams_json:tag==="#B"?[team[1],team[0]]:team,duration_seconds:120});
    await add("#D",ago(0.25),{teams_json:team,result:"defeat",duration_seconds:120});
    await add("#A",ago(0.2),{teams_json:[{tag:"#A"},{tag:"#B"}],mode:"soloShowdown"});
    await add("#A",ago(0.1),{teams_json:[[{tag:"#B"},{tag:"#D"}],[{tag:"#X"}]]});
    const data=await analysis();assert.equal(data.summary.observations,5);assert.equal(data.pairs.length,1);
    assert.deepEqual([data.pairs[0].player1.tag,data.pairs[0].player2.tag],["#A","#B"]);assert.equal(data.pairs[0].matches,1);assert.equal(data.pairs[0].wins,1);
    assert.equal(data.coverage.pairEligibleObservations,2);assert.equal(data.coverage.teamObservations,3);
    assert.equal(data.summary.durationObservations,3);assert.equal(data.summary.recordedDurationSeconds,360);assert.equal(data.summary.averageDurationSeconds,120);
    assert.equal(data.hourly.find(row=>row.hour===6).observations,3);assert.equal(data.hourly.length,24);
    assert.equal(data.summary.unknownResults,0);assert.doesNotMatch(JSON.stringify(data),/owner_user_id|private_future|SECRET|notes|api_key/);
  });

  await t.test("conflicting same-team results become unknown, malformed teams and duplicate tags do not invent partnerships",async()=>{
    await db.query("TRUNCATE battle_history");await add("#A",ago(0.25),{teams_json:team});await add("#B",ago(0.25),{teams_json:team,result:"defeat"});
    for(const [i,raw] of ["{broken",[[{tag:"#A"},{tag:"#A"},{tag:"#B"}]],{players:[{tag:"#A"},{tag:"#B"}]},[[{tag:"#A"},{}]],[]].entries())await add("#A",new Date(Date.parse(now)-i*1000-10000).toISOString(),{teams_json:raw});
    const data=await analysis();assert.equal(data.pairs.length,1);assert.equal(data.pairs[0].matches,1);assert.equal(data.pairs[0].unknownResults,1);assert.equal(data.pairs[0].winRate,null);
  });

  await t.test("partially enriched context/event metadata cannot double-count the same observed clubmate pair",async()=>{
    await db.query("TRUNCATE battle_history");await add("#A",ago(0.25),{teams_json:team,battle_type:"friendly"});await add("#B",ago(0.25),{teams_json:team,battle_type:null});
    await db.query("UPDATE battle_history SET event_id=15000001 WHERE player_tag='#A'");
    const data=await analysis();assert.equal(data.pairs.length,1);assert.equal(data.pairs[0].matches,1);assert.equal(data.pairs[0].context,"friendly");
    await db.query("UPDATE battle_history SET battle_type='soloRanked' WHERE player_tag='#B'");
    const conflicting=await analysis();assert.equal(conflicting.pairs.length,1);assert.equal(conflicting.pairs[0].matches,1);assert.equal(conflicting.pairs[0].context,"unknown","Contradictory explicit categories cannot produce two invented matches");
  });

  await t.test("category/mode/map/brawler filters agree with complete period facets and explicit unknown outcomes",async()=>{
    await db.query("TRUNCATE battle_history");
    for(const [i,type] of ["ranked","soloRanked","teamRanked","friendly","casual","megaPig","tournament","challenge"].entries())await add("#A",new Date(Date.parse(now)-i*1000).toISOString(),{battle_type:type,map:i%2?"Other":"Map",brawler_name:i%2?"Colt":"Shelly",result:i%3===0?"draw":i%3===1?"unknown":"victory",mode:i===0?"airHockey":"duoShowdown",event_mode_id:i===0?null:38});
    const all=await analysis(),filtered=await analysis(7,"ranked","trioShowdown","Other","Colt");
    assert.equal(all.summary.observations,8);assert.equal(filtered.summary.observations,1);
    assert.deepEqual(filtered.facets,all.facets);assert.equal(all.facets.contexts.find(row=>row.key==="ladder").count,1);assert.equal(all.facets.contexts.find(row=>row.key==="ranked").count,2);
    assert.equal(all.facets.contexts.find(row=>row.key==="unknown").count,1);assert.equal(all.facets.contexts.find(row=>row.key==="friendly").count,1);
    assert.equal(all.facets.modes.find(row=>row.key==="brawlHockey").count,1);assert.equal(all.facets.modes.find(row=>row.key==="trioShowdown").count,7);
    assert.equal(filtered.summary.winRate,null);assert.equal(filtered.summary.durationObservations,0);assert.equal(filtered.summary.averageDurationSeconds,null);
    assert.equal((await analysis(7,null,"airHockey")).summary.observations,1);
  });

  await t.test("all five rolling boundaries exclude future, old, former and orphan observations",async()=>{
    for(const days of [1,3,7,30,90]){
      await db.query("TRUNCATE battle_history");await add("#A",ago(days));await add("#A",now,{duration_seconds:0});
      await db.query("INSERT INTO battle_history(player_tag,battle_time) VALUES('#A',$1::timestamptz-interval '1 microsecond'),('#A',$2::timestamptz+interval '1 microsecond'),('#FORMER',$2),('#MISSING',$2)",[ago(days),now]);
      const data=await analysis(days);assert.equal(data.summary.observations,2);assert.equal(data.coverage.currentPlayers,4);
      assert.equal(data.summary.durationObservations,1);assert.equal(data.summary.recordedDurationSeconds,0);assert.equal(data.summary.averageDurationSeconds,0);
      assert.equal(Date.parse(data.coverage.earliestBattleAt),Date.parse(ago(days)));assert.equal(Date.parse(data.coverage.latestBattleAt),Date.parse(now));
    }
  });

  await t.test("coverage reports observed baselines, stale or missing monitoring and only overlapping retained possible gaps",async()=>{
    const run=(await db.query("INSERT INTO sync_runs(club_tag,source,scope,fence,status) VALUES('#CLUB','manual','full',1,'succeeded') RETURNING id")).rows[0].id;
    for(const [tag,baseline,checked] of [["#A",ago(100),now],["#B",ago(2),now],["#D",ago(20),ago(3)]])await db.query("INSERT INTO sync_battle_coverage(club_tag,player_tag,baseline_started_at,last_observed_at,last_attempt_at,last_observation_status,last_run_id) VALUES('#CLUB',$1,$2,$3,$3,'observed',$4)",[tag,baseline,checked,run]);
    await db.query("INSERT INTO sync_battle_gaps(club_tag,player_tag,run_id,detected_at,gap_start_at,gap_end_at,previous_observed_at,window_size,scope) VALUES('#CLUB','#A',$1,$2,$3,$4,$3,25,'full'),('#CLUB','#B',$1,$2,$5,$6,$5,25,'full'),('#OTHER','#D',$1,$2,$3,$4,$3,25,'full')",[run,now,ago(3),ago(2),ago(20),ago(19)]);
    const data=await analysis(7);assert.equal(data.coverage.status,"possible_gap");assert.equal(data.coverage.possibleGapCount,1);assert.equal(data.coverage.affectedPlayers,1);
    assert.equal(data.coverage.monitoredPlayers,3);assert.equal(data.coverage.fullPeriodMonitoredPlayers,1);assert.equal(data.coverage.stalePlayers,2);assert.equal(data.coverage.completeHistory,false);assert.equal(data.coverage.retainedGapWindowDays,28);
    assert.equal((await analysis(1)).coverage.possibleGapCount,0);assert.equal((await analysis(90)).coverage.possibleGapCount,2);
    await db.query("UPDATE settings SET value='%23club' WHERE key='club_tag'");assert.equal((await analysis(7)).coverage.possibleGapCount,1);
    await db.query("UPDATE settings SET value='#CLUB' WHERE key='club_tag'");
  });

  await t.test("readiness uses the current roster, exact NULL equipment semantics, literal search and stable bounded pagination",async()=>{
    await db.query("ALTER TABLE player_brawler_details ADD COLUMN private_future text");
    const rows=[["#A",16000000,"Shelly",11,null,[],null,now],["#A",16000001,"Colt",8,[],[],[],now],["#B",16000000,"Shelly",9,[{id:1,name:"Gadget"}],[],[],ago(1)],["#B",16000002,"Future",11,[],[],[],"2999-01-01"],["#FORMER",16000000,"Shelly",11,[],[],[],now]];
    for(const [tag,id,name,power,gadgets,stars,gears,observed] of rows)await db.query("INSERT INTO player_brawler_details(player_tag,brawler_id,brawler_name,power_level,trophies,rank,highest_trophies,gadgets,star_powers,gears,observed_at,field_checked_at,private_future) VALUES($1,$2,$3,$4,0,1,NULL,$5,$6,$7,$8,$9,'SECRET')",[tag,id,name,power,gadgets===null?null:JSON.stringify(gadgets),JSON.stringify(stars),gears===null?null:JSON.stringify(gears),observed,JSON.stringify({power_level:now})]);
    const data=await ready();assert.equal(data.total,3);assert.equal(data.members.length,4);assert.equal(data.members.find(row=>row.tag==="#EMPTY").brawlersObserved,0);
    assert.equal(data.members.find(row=>row.tag==="#A").power11,1);assert.equal(data.members.find(row=>row.tag==="#B").power9Plus,1);
    const ali=data.rows.find(row=>row.player.tag==="#A"&&row.brawler.id===16000000);assert.equal(ali.gadgets,null);assert.deepEqual(ali.starPowers,[]);assert.equal(ali.gears,null);assert.equal(ali.highestTrophies,null);
    const filtered=await ready(16000000,9);assert.equal(filtered.total,2);assert.deepEqual(filtered.members,data.members);assert.deepEqual(filtered.brawlers,data.brawlers);
    assert.equal((await ready(null,0,"علي")).total,2);assert.equal((await ready(null,0,"%")).total,0);
    const first=await ready(null,0,null,0,1),second=await ready(null,0,null,1,1);assert.notDeepEqual(first.rows[0],second.rows[0]);assert.equal((await ready(null,0,null,100,1)).rows.length,0);
    assert.doesNotMatch(JSON.stringify(data),/private_future|SECRET|owner_user_id|notes/);
  });

  await t.test("100k observation ceiling is explicit rather than silently claiming complete facets or history",async()=>{
    await db.query("BEGIN");try{
      await db.query("TRUNCATE battle_history");
      await db.query("INSERT INTO battle_history(player_tag,battle_time,mode,map,result,battle_type) SELECT '#A',$1::timestamptz-i*interval '1 second','gemGrab','Map','victory','ranked' FROM generate_series(0,100000)i",[now]);
      const data=await analysis(7);assert.equal(data.summary.observations,100000);assert.equal(data.limits.truncated,true);assert.equal(data.coverage.truncated,true);assert.equal(data.coverage.completeHistory,false);assert.equal(data.facets.modes[0].count,100000);
      assert.ok(Buffer.byteLength(JSON.stringify(data))<25000,"Aggregate response must not ship raw retained battle rows");
    }finally{await db.query("ROLLBACK");}
  });

  await t.test("invalid ranges fail closed and only service role can execute the analytics RPCs",async()=>{
    for(const days of [0,2,91,null])await assert.rejects(analysis(days),error=>error.code==="22023");
    await assert.rejects(analysis(7,"casual"),error=>error.code==="22023");await assert.rejects(analysis(7,null,null,null,null,"infinity"),error=>error.code==="22023");
    await assert.rejects(ready(null,12),error=>error.code==="22023");await assert.rejects(ready(null,0,null,0,201),error=>error.code==="22023");
    const functions=(await db.query("SELECT proname,prosecdef,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('club_analysis_read','club_readiness_read')")).rows;
    assert.equal(functions.length,2);for(const fn of functions){assert.equal(fn.prosecdef,true);assert.ok(fn.proconfig.includes("search_path=pg_catalog, pg_temp"));}
    for(const role of ["anon","authenticated","service_role"]){await db.query(`SET ROLE ${role}`);try{
      if(role==="service_role"){assert.ok((await analysis()).summary);assert.equal((await ready()).total,3);}
      else{await assert.rejects(analysis(),error=>error.code==="42501");await assert.rejects(ready(),error=>error.code==="42501");}
    }finally{await db.query("RESET ROLE");}}
  });
});
