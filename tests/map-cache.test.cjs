const test=require('node:test');
const assert=require('node:assert/strict');
const {AsyncLocalStorage}=require('node:async_hooks');
const {loadTypeScript}=require('./helpers/load-typescript.cjs');
globalThis.AsyncLocalStorage??=AsyncLocalStorage;
const {unstable_cache}=require('next/dist/server/web/spec-extension/unstable-cache');
const {workAsyncStorage}=require('next/dist/server/app-render/work-async-storage.external');
const {workUnitAsyncStorage}=require('next/dist/server/app-render/work-unit-async-storage.external');
const event={slotId:1,id:15000007,mode:'gemGrab',map:'Hard Rock Mine',startTime:'2026-09-18T00:00:00Z',endTime:'2026-09-19T08:00:00Z'};
const sourceMap=(extra={})=>({id:15000007,name:'Hard Rock Mine',gameMode:{scId:48000000,scHash:'gemGrab'},totalMatches:1000,winRateHigh:[{brawlerId:16000000,brawlerName:'Shelly',winRate:60}],winRateLow:[{brawlerId:16000001,brawlerName:'Colt',winRate:75}],...extra});
const artRow=(extra={})=>({id:15000007,name:'Hard Rock Mine',gameMode:{id:48000000},imageUrl:'https://cdn.brawlify.com/maps/regular/15000007.png',link:'https://brawlify.com/maps/15000007',...extra});
function harness(){
 let now=Date.parse('2026-09-18T02:00:00Z');
 const calls={catalog:0,stats:0,events:0},entries=new Map(),warnings=[];
 const state={failCatalog:false,failStats:false,timestamp:null,maps:[sourceMap()],art:[artRow(),artRow({id:15000008})],rotation:{data:[event],fetchedAt:new Date(now).toISOString(),stale:false,refreshing:false}};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const incrementalCache={generateSimpleCacheKey:async key=>key,get:async key=>{const saved=entries.get(key);return saved?{value:saved.value,isStale:now-saved.at>=saved.value.revalidate*1000}:null;},set:async(key,value)=>{entries.set(key,{value,at:now});}};
 const worker=()=>loadTypeScript('src/lib/map-cache.ts',{'next/cache':{unstable_cache},'./game-cache':{loadGameData:async kind=>{assert.equal(kind,'events');calls.events++;return state.rotation;}}},{Date:Clock,console:{...console,warn:(...args)=>warnings.push(args)},fetch:async(url,options)=>{
  assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,undefined);
  if(url==='https://api.brawlapi.com/v1/maps'){calls.catalog++;if(state.failCatalog)throw Error('PRIVATE_CATALOG');return new Response(JSON.stringify({list:state.art}),{headers:{'Content-Type':'application/json'}});}
  if(url==='https://api.brawltools.net/maps'){calls.stats++;if(state.failStats)return new Response('PRIVATE_FAILURE',{status:typeof state.failStats==='number'?state.failStats:503,headers:{'Content-Type':'application/json'}});return new Response(JSON.stringify({timestamp:state.timestamp??now/1000,data:state.maps}),{headers:{'Content-Type':'application/json'}});}
  throw Error('Unexpected provider request');
 }});
 const request=async(service,band)=>{
  const store={route:'/api/game-maps',incrementalCache,isDraftMode:false,isStaticGeneration:false};
  const result=await workAsyncStorage.run(store,()=>workUnitAsyncStorage.run({type:'request',phase:'render',url:{pathname:'/api/game-maps',search:''}},()=>service.loadMapSnapshot(band)));
  await Promise.all(Object.values(store.pendingRevalidates??{}));return result;
 };
 return{worker,request,calls,state,entries,warnings,advance:ms=>{now+=ms;}};
}
test('real Next hourly cache serves both bands/current maps and survives worker changes without provider fanout',async()=>{
 const h=harness(),worker=h.worker();
 const [high,low]=await Promise.all([h.request(worker),h.request(worker,'low')]);
 assert.equal(high.statsBand,'high');assert.equal(low.statsBand,'low');assert.equal(high.data.length,1);
 assert.equal(high.data[0].statsBand,'high');assert.equal(high.data[0].brawlers[0].winRate,60);assert.equal(low.data[0].brawlers[0].winRate,75);
 assert.equal(high.data[0].statsSource.name,'BrawlTools');assert.equal(high.data[0].winRateKind,'provider');assert.equal(high.data[0].mapTotalMatches,1000);
 assert.equal(high.data[0].sampleSize,null);assert.equal(high.data[0].sampleUnit,null);assert.equal(high.data[0].statsPeriod,null);assert.equal(high.data[0].brawlers[0].sampleSize,null);assert.equal(high.data[0].brawlers[0].pickRate,null);
 assert.equal(h.calls.catalog,1);assert.equal(h.calls.stats,1);assert.equal(h.entries.size,2);
 h.advance(301000);await h.request(worker);await h.request(h.worker(),'low');assert.equal(h.calls.stats,1);assert.equal(h.calls.catalog,1);
 for(const entry of h.entries.values())assert.equal(entry.value.revalidate,3600);
});
test('real Next failed refresh retains prior data and source snapshot time with an honest stale label',async t=>{
 t.mock.method(console,'error',()=>{});
 const h=harness(),worker=h.worker(),original=await h.request(worker);
 h.advance(3601000);h.state.failCatalog=h.state.failStats=true;
 const stale=await h.request(worker);assert.equal(stale.stale,true);assert.equal(stale.data[0].statsStatus,'stale');assert.equal(stale.data[0].statsUpdatedAt,original.data[0].statsUpdatedAt);assert.equal(stale.data[0].statsFetchedAt,original.data[0].statsFetchedAt);assert.equal(stale.data[0].brawlers[0].winRate,60);
 await h.request(worker,'low');assert.equal(h.calls.stats,2);assert.equal(h.calls.catalog,2);
 h.advance(301000);h.state.failCatalog=h.state.failStats=false;await h.request(worker);
 const updated=await h.request(worker);assert.equal(updated.stale,false);assert.notEqual(updated.data[0].statsUpdatedAt,original.data[0].statsUpdatedAt);
});
test('cold statistics failures preserve art and a single bounded cooldown shared by both bands',async()=>{
 const h=harness(),worker=h.worker();h.state.failStats=429;
 const failed=await h.request(worker);assert.equal(failed.data[0].statsStatus,'unavailable');assert.equal(failed.data[0].mapTotalMatches,null);assert.ok(failed.data[0].imageUrl);
 await h.request(worker,'low');assert.equal(h.calls.stats,1);assert.equal(h.warnings.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(h.warnings[0][1])),{stage:'stats',reason:'http',status:429});assert.doesNotMatch(JSON.stringify(h.warnings),/PRIVATE|http:|https:|Hard Rock/);
 h.advance(301000);h.state.failStats=false;assert.equal((await h.request(worker,'low')).data[0].statsStatus,'available');assert.equal(h.calls.stats,2);
});
test('an empty provider bulk response cannot overwrite a useful shared cache with empty statistics',async t=>{
 t.mock.method(console,'error',()=>{});
 const h=harness(),worker=h.worker(),original=await h.request(worker);
 h.advance(3601000);h.state.maps=[];
 const stale=await h.request(worker);assert.equal(stale.data[0].statsStatus,'stale');assert.equal(stale.data[0].brawlers[0].winRate,60);assert.equal(stale.data[0].statsFetchedAt,original.data[0].statsFetchedAt);
 assert.equal(h.warnings.at(-1)[1].reason,'invalid_data');
});
test('mode omission requires independent exact catalog ID/name/mode evidence, while source conflicts cannot be repaired',async()=>{
 for(const gameMode of [{name:'-'},null]){
  const h=harness();h.state.maps=[sourceMap({gameMode})];assert.equal((await h.request(h.worker())).data[0].statsStatus,'available');
 }
 for(const changes of [{name:'Another map'},{gameMode:{scId:48000002,scHash:'heist'}},{gameMode:{scId:48999999}},{id:15000008}]){
  const h=harness();h.state.maps=[sourceMap(changes)];const result=await h.request(h.worker());assert.equal(result.data[0].statsStatus,'unavailable');assert.equal(result.data[0].brawlers.length,0);
 }
 const missing=harness();missing.state.maps=[sourceMap({gameMode:{name:'-'}})];missing.state.failCatalog=true;assert.equal((await missing.request(missing.worker())).data[0].statsStatus,'unavailable');
 const wrongName=harness();wrongName.state.maps=[sourceMap({gameMode:{name:'-'}})];wrongName.state.art=[artRow({name:'Other map'})];assert.equal((await wrongName.request(wrongName.worker())).data[0].statsStatus,'unavailable');
});
test('unknown source snapshot dates remain unknown and stale, never replaced by retrieval time',async()=>{
 const h=harness();h.state.timestamp=0;const result=await h.request(h.worker());assert.equal(result.data[0].statsUpdatedAt,null);assert.ok(result.data[0].statsFetchedAt);assert.equal(result.data[0].statsStatus,'stale');
});
test('absent official rotation cannot be replaced by provider catalog or trigger a statistics fetch',async()=>{
 const h=harness();h.state.rotation={data:null,stale:true,refreshing:false,fetchedAt:null};const worker=h.worker();
 assert.equal((await h.request(worker)).data,null);assert.equal(h.calls.stats,0);
 h.state.rotation={data:[],stale:false,refreshing:false,fetchedAt:null};assert.equal((await h.request(worker)).data.length,0);assert.equal(h.calls.stats,0);
});
test('missing high-band results never silently fall back to another source band',async()=>{
 const h=harness();h.state.maps=[sourceMap({winRateHigh:null})];const worker=h.worker();
 const high=await h.request(worker),low=await h.request(worker,'low');assert.equal(high.data[0].statsStatus,'unavailable');assert.equal(high.data[0].brawlers.length,0);assert.equal(low.data[0].brawlers[0].winRate,75);assert.equal(h.calls.stats,1);
});
test('endpoint accepts only documented bands, rejects obsolete/external/duplicate filters before loading and hides errors',async()=>{
 const bands=[];const api=loadTypeScript('src/app/api/game-maps/route.ts',{'next/server':{NextResponse:{json:(value,options)=>new Response(JSON.stringify(value),options)}},'@/lib/map-cache':{loadMapSnapshot:async band=>{bands.push(band);return{data:[],statsBand:band};}}});
 for(const query of ['?trophies=1000','?band=1000','?band=','?band=high&band=low','?band=high&url=https://attacker.invalid','?map=15000007'])assert.equal((await api.GET(new Request('https://app.test/api/game-maps'+query))).status,400);
 assert.equal(bands.length,0);
 for(const query of ['','?band=high','?band=low']){const r=await api.GET(new Request('https://app.test/api/game-maps'+query));assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/s-maxage=60/);}
 assert.deepEqual(bands,['high','high','low']);
 const failed=loadTypeScript('src/app/api/game-maps/route.ts',{'next/server':{NextResponse:{json:(value,options)=>new Response(JSON.stringify(value),options)}},'@/lib/map-cache':{loadMapSnapshot:async()=>{throw Error('PRIVATE_PROVIDER');}}});
 const r=await failed.GET(new Request('https://app.test/api/game-maps'));assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'300');assert.doesNotMatch(await r.text(),/PRIVATE_PROVIDER/);
});
