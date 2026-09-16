const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Client}=require('pg');
const source=process.env.ANALYSIS_TEST_DATABASE_URL||process.env.SECURITY_TEST_DATABASE_URL||process.env.SYNC_TEST_DATABASE_URL;
const root=path.resolve(__dirname,'../..');

test('set-based team validation preserves historical evidence and private function permissions',{skip:!source},async t=>{
  const url=new URL(source);assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
  assert.match(url.pathname,/^\/brawl_[a-z_]+_tests$/);assert.equal(url.search,'');assert.equal(url.hash,'');
  const loopback=db=>assert.ok(['127.0.0.1','::1'].includes(db.connection.stream.remoteAddress.replace(/^::ffff:/i,'')));
  url.pathname='/postgres';const admin=new Client({connectionString:url.href});await admin.connect();
  try{loopback(admin);if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='brawl_analysis_team_tests'")).rowCount)await admin.query("CREATE DATABASE brawl_analysis_team_tests ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");}finally{await admin.end();}
  url.pathname='/brawl_analysis_team_tests';const db=new Client({connectionString:url.href});await db.connect();t.after(()=>db.end());loopback(db);
  assert.equal((await db.query('SELECT current_database() name')).rows[0].name,'brawl_analysis_team_tests');
  await db.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public;GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role');
  const previous=fs.readFileSync(path.join(root,'supabase/migrations/202609160021_club_analysis.sql'),'utf8')
    .split('CREATE OR REPLACE FUNCTION public.analysis_team')[1].split('CREATE OR REPLACE FUNCTION public.analysis_stats')[0];
  assert.ok(previous.includes('FOR v_team IN'),'The historical comparison must retain the original algorithm');
  await db.query('CREATE OR REPLACE FUNCTION public.analysis_team_previous'+previous);
  const migration=fs.readFileSync(path.join(root,'supabase/migrations/202609160026_analysis_team_reads.sql'),'utf8');
  await db.query(migration);await db.query(migration);
  const team=[[{tag:'#A'},{tag:'#B'},{tag:'#C'}],[{tag:'#D'},{tag:'#X'},{tag:'#Y'}]];
  const check=async(raw,player='#A')=>(await db.query('SELECT analysis_team($1::jsonb,$2) value',[raw===undefined?null:JSON.stringify(raw),player])).rows[0].value;

  await t.test('legacy wrappers and normalization retain exact teammates and never return opponents as own team',async()=>{
    const expected={own:['#A','#B','#C'],participants:['#A','#B','#C','#D','#X','#Y']};
    for(const value of [team,{teams:team},JSON.stringify(team),JSON.stringify({teams:team}),[[{tag:' b '},{tag:' #a '},{tag:'#C'}],team[1]]])assert.deepEqual(await check(value),expected);
    assert.deepEqual((await check(team,'#D')).own,['#D','#X','#Y']);
    assert.equal(await check(team,'#ABSENT'),null);assert.equal(await check(team,'#a'),null);assert.equal(await check(team,null),null);
    assert.deepEqual(await check([[{tag:'#A'}]]),{own:['#A'],participants:['#A']});
  });

  await t.test('flat, malformed, duplicate, oversized and invalid-tag data do not manufacture team evidence',async()=>{
    const longTeam=Array.from({length:21},(_,i)=>({tag:i?'#T'+i:'#A'}));
    const values=[undefined,null,true,5,{},[],[[]],team.flat(),[team[0],{}],{players:team.flat()},'{broken',JSON.stringify(JSON.stringify(team)),
      [[{tag:'#A'},{tag:'#A'}]],[[{tag:'#A'}],[{tag:' a '}]],[[{tag:'#A'},{}]],[[{tag:'#A'},null]],
      [[{tag:'#A'},{tag:123}]],[[{tag:'#A'},{tag:['#B']}]],[[{tag:'#A'},{tag:{value:'#B'}}]],
      [[{tag:'#A'},{tag:''}]],[[{tag:'#A'},{tag:'#'}]],[[{tag:'#A'},{tag:'#é'}]],[[{tag:'#A'},{tag:'#A B'}]],
      [[{tag:'#A'},{tag:'#'+'Z'.repeat(21)}]],[longTeam],Array.from({length:21},(_,i)=>[{tag:i?'#T'+i:'#A'}]),
      [longTeam.slice(0,20),Array.from({length:20},(_,i)=>({tag:'#Q'+i})),[{tag:'#LAST'}]]];
    for(const value of values)assert.equal(await check(value),null,JSON.stringify(value));
    const forty=[Array.from({length:20},(_,i)=>({tag:i?'#T'+i:'#A'})),Array.from({length:20},(_,i)=>({tag:'#Q'+i}))];
    assert.equal((await check(forty)).participants.length,40);assert.equal((await check(forty)).own.length,20);
    assert.equal((await check(Array.from({length:20},(_,i)=>[{tag:i?'#T'+i:'#A'}]))).participants.length,20);
  });

  await t.test('old and new validators are equivalent across deterministic mixed valid and corrupt observations',async()=>{
    let seed=2616;const random=limit=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%limit;};
    const fixtures=[];
    for(let i=0;i<600;i++){
      let tag=0;let raw=Array.from({length:1+random(10)},()=>Array.from({length:1+random(8)},()=>({tag:'#T'+tag++,ignored:{id:123}})));
      const player=i%7===0?'#MISSING':'#T'+random(tag);
      switch(i%12){
        case 0:raw[0][0].tag=42;break;
        case 1:raw[0].push({...raw[0][0]});break;
        case 2:raw[0][0].tag=' #t0 ';break;
        case 3:raw.push([]);break;
        case 4:raw[0][0].tag='#BAD!';break;
        case 5:raw=raw.flat();break;
        case 6:raw.push(null);break;
        case 7:delete raw[0][0].tag;break;
        case 8:raw[0][0].tag='Z'.repeat(20);break;
      }
      if(i%4===0)raw={teams:raw};if(i%5===0)raw=JSON.stringify(raw);
      fixtures.push({raw,player});
    }
    fixtures.push({raw:null,player:'#A'},{raw:'{invalid',player:'#A'},{raw:team,player:null},{raw:team,player:'#D'});
    const results=(await db.query("SELECT ordinality id,analysis_team_previous(value->'raw',value->>'player') previous,analysis_team(value->'raw',value->>'player') current FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY",[JSON.stringify(fixtures)])).rows;
    assert.equal(results.length,604);let valid=0;
    for(const result of results){assert.deepEqual(result.current,result.previous,'Fixture '+result.id);if(result.current)valid++;}
    assert.ok(valid>30,'Equivalence must include valid observations, not only NULL results');
    assert.ok(valid<500,'Equivalence must include rejected malformed observations');
  });

  await t.test('read-only helper attributes and service-only execution remain unchanged after reapplication',async()=>{
    const fn=(await db.query("SELECT provolatile,proparallel,prosecdef,proconfig FROM pg_proc WHERE oid='public.analysis_team(jsonb,text)'::regprocedure")).rows[0];
    assert.equal(fn.provolatile,'i');assert.equal(fn.proparallel,'s');assert.equal(fn.prosecdef,false);assert.ok(fn.proconfig.includes('search_path=pg_catalog, pg_temp'));
    for(const role of ['anon','authenticated','service_role']){await db.query(`SET ROLE ${role}`);try{
      if(role==='service_role')assert.deepEqual((await check(team)).own,['#A','#B','#C']);
      else await assert.rejects(check(team),error=>error.code==='42501');
    }finally{await db.query('RESET ROLE');}}
  });
});
