const test=require('node:test');
const assert=require('node:assert/strict');
const {loadTypeScript}=require('./helpers/load-typescript.cjs');

test('public provider requests have fixed hosts, GET only, no redirects, credentials or arbitrary destinations',async()=>{
 const calls=[];const http=loadTypeScript('src/lib/map-http.ts',{}, {fetch:async(url,options)=>{calls.push({url,options});return new Response('{}',{headers:{'Content-Type':'application/json'}});}});
 const signal=new AbortController().signal;await http.mapProviderJson('catalog',signal);await http.mapProviderJson('stats',signal);
 assert.deepEqual(calls.map(c=>c.url),['https://api.brawlapi.com/v1/maps','https://api.brawltools.net/maps']);
 for(const {options}of calls){assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);assert.equal(options.body,undefined);}
 await assert.rejects(http.mapProviderJson('https://attacker.invalid',signal));assert.equal(calls.length,2);
});
test('rate limits, invalid content and oversized responses fail without exposing response bodies',async()=>{
 for(const response of [new Response('PRIVATE_ERROR',{status:429,headers:{'Content-Type':'application/json'}}),new Response('PRIVATE_ERROR',{headers:{'Content-Type':'text/html'}}),new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'9000000'}}),new Response('x'.repeat(1500001),{headers:{'Content-Type':'application/json'}})]){
  const http=loadTypeScript('src/lib/map-http.ts',{}, {fetch:async()=>response});
  await assert.rejects(http.mapProviderJson('catalog',new AbortController().signal),error=>!String(error).includes('PRIVATE_ERROR'));
 }
});
test('HTTP errors retain only sanitized stage and status and never retry in a tight loop',async()=>{
 let calls=0;const http=loadTypeScript('src/lib/map-http.ts',{}, {fetch:async()=>{calls++;return new Response('PRIVATE_ERROR',{status:429,headers:{'Content-Type':'application/json'}});}});
 await assert.rejects(http.mapProviderJson('stats',new AbortController().signal),error=>error.stage==='stats'&&error.reason==='http'&&error.status===429&&!String(error).includes('PRIVATE_ERROR'));
 assert.equal(calls,1);
});
test('provider work has a hard deadline even if the client ignores AbortSignal',async()=>{
 const http=loadTypeScript('src/lib/map-http.ts');let signal;
 await assert.rejects(http.boundedMapWork(value=>{signal=value;return new Promise(()=>{});},10),error=>error.reason==='timeout');
 assert.equal(signal.aborted,true);assert.equal(await http.boundedMapWork(async()=>42,1000),42);
});
