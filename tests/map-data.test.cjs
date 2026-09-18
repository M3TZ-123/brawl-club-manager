const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const data = loadTypeScript('src/lib/map-data.ts');
const stats = loadTypeScript('src/lib/map-statistics.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const now = Date.parse('2026-09-18T02:00:00Z');
const brawler = (extra={}) => ({brawlerId:16000000,brawlerName:'Shelly',winRate:66.67,brawlerIcon:'https://attacker.invalid/icon',...extra});
const row = (extra={}) => ({id:15000007,name:'Hard Rock Mine',gameMode:{scId:48000000,scHash:'gemGrab'},totalMatches:10000,winRateHigh:[brawler()],winRateLow:[brawler({brawlerId:16000001,brawlerName:'Colt',winRate:75})],...extra});
const payload = rows => ({timestamp:now/1000,data:rows});
const artwork = (extra={}) => ({id:15000007,name:'Hard Rock Mine',gameMode:{id:48000000},imageUrl:'https://cdn.brawlify.com/maps/regular/15000007.png',link:'https://brawlify.com/maps/15000007',...extra});

test('source bands are finite and never pretend to be an exact trophy or Ranked cutoff',()=>{
 assert.equal(data.parseMapStatsBand(undefined),'high');assert.equal(data.parseMapStatsBand(null),'high');
 assert.equal(data.parseMapStatsBand('high'),'high');assert.equal(data.parseMapStatsBand('low'),'low');
 for(const value of ['', '1000','600','all','HIGH',1000,true,{}])assert.equal(data.parseMapStatsBand(value),null);
});
test('artwork catalog projects identity and allowlisted images only, ignoring source statistics',()=>{
 const result=data.normalizeMapCatalog({list:[artwork({stats:[{winRate:100}],secret:'PRIVATE'})]})[0];
 assert.deepEqual(Object.keys(result).sort(),['imageUrl','mapId','mode','name','sourceUrl']);
 assert.equal(result.mode,'gemGrab');assert.equal(result.imageUrl,'https://cdn.brawlify.com/maps/regular/15000007.png');
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|winRate|stats/);
 for(const imageUrl of ['https://attacker.invalid/a','https://cdn.brawlify.com/maps/regular/15000008.png','https://cdn.brawlify.com@attacker.invalid/a'])assert.equal(data.normalizeMapCatalog({list:[artwork({imageUrl})]})[0].imageUrl,null);
 assert.equal(data.normalizeMapCatalog({list:[artwork({gameMode:{id:48999999}})]}).length,0);
 assert.throws(()=>data.normalizeMapCatalog({list:[artwork(),artwork()]}));
});
test('documented BrawlTools percentages remain percentages, while unavailable per-brawler samples and usage stay null',()=>{
 const normalized=stats.normalizeMapStatistics(payload([row({secret:'PRIVATE'})]),now);
 assert.equal(normalized.sourceTimestamp,'2026-09-18T02:00:00.000Z');
 assert.equal(normalized.maps[0].mapTotalMatches,10000);
 const high=stats.mapBandBrawlers(normalized.maps[0],'high')[0],low=stats.mapBandBrawlers(normalized.maps[0],'low')[0];
 assert.equal(high.winRate,66.67);assert.equal(low.winRate,75);
 assert.equal(high.sampleSize,null);assert.equal(high.pickRate,null);assert.equal(high.adjustedWinRate,null);
 assert.equal(high.imageUrl,'https://cdn.brawlify.com/brawlers/borders/16000000.png');
 assert.doesNotMatch(JSON.stringify(normalized),/PRIVATE|attacker|Icon/);
});
test('Showdown retains the reported percentage without interpreting it as first-place probability',()=>{
 for(const [mode,id]of[['soloShowdown',48000006],['duoShowdown',48000009],['trioShowdown',48000038]]){
  const result=stats.normalizeMapStatistics(payload([row({gameMode:{scId:id,scHash:mode}})]),now).maps[0];
  assert.equal(result.mode,mode);assert.equal(stats.mapBandBrawlers(result,'high')[0].winRate,66.67);
  assert.equal(stats.mapBandBrawlers(result,'high')[0].sampleSize,null);
 }
});
test('missing mode metadata is distinct from a contradictory explicit mode',()=>{
 const result=stats.normalizeMapStatistics(payload([row({gameMode:{name:'-'}})]),now).maps[0];assert.equal(result.mode,null);
 const conflict=stats.normalizeMapStatistics(payload([row({gameMode:{scId:48000000,scHash:'heist'}})]),now).maps[0];assert.equal(conflict.mode,'!conflicting-mode');
 for(const gameMode of [{scId:48999999},{scId:'48000000'},{scHash:''}])assert.equal(stats.normalizeMapStatistics(payload([row({gameMode})]),now).maps[0].mode,'!conflicting-mode');
});
test('source timestamps cannot fabricate match-observation time or normalize future dates to now',()=>{
 for(const timestamp of [undefined,null,0,-1,'1789700000',now/1000+1]){
  assert.equal(stats.normalizeMapStatistics({...payload([row()]),timestamp},now).sourceTimestamp,null);
 }
});
test('missing bands and counts stay unknown, explicit empty lists and genuine zero rates remain distinct',()=>{
 const r=stats.normalizeMapStatistics(payload([row({totalMatches:null,winRateHigh:null,winRateLow:[]})]),now).maps[0];
 assert.equal(r.mapTotalMatches,null);assert.equal(stats.mapBandBrawlers(r,'high'),null);assert.deepEqual(plain(stats.mapBandBrawlers(r,'low')),[]);
 const zero=stats.normalizeMapStatistics(payload([row({totalMatches:0,winRateHigh:[brawler({winRate:0})]})]),now).maps[0];
 assert.equal(zero.mapTotalMatches,0);assert.equal(stats.mapBandBrawlers(zero,'high')[0].winRate,0);
 for(const rate of [null,'66.67',-1,101,true,{}]){
  const result=stats.normalizeMapStatistics(payload([row({winRateHigh:[brawler({winRate:rate})]})]),now).maps[0];
  assert.equal(stats.mapBandBrawlers(result,'high')[0].winRate,null);
 }
});
test('malformed legacy entries are isolated and duplicate identities are quarantined without invented replacements',()=>{
 const result=stats.normalizeMapStatistics(payload([row(),row({id:15000384,winRateLow:[brawler({brawlerId:null,brawlerName:'16000109',winRate:90.91}),brawler()]}),row({id:15001323,name:null})]),now);
 assert.equal(result.maps.length,2);assert.equal(result.maps[0].high[0].winRate,66.67);assert.equal(result.maps[1].low.length,1);assert.equal(result.maps[1].low[0].id,16000000);
 assert.equal(stats.normalizeMapStatistics(payload([row(),row(),row({id:15000008})]),now).maps.length,1);
 assert.equal(stats.normalizeMapStatistics(payload([row({winRateHigh:[brawler(),brawler()]})]),now).maps[0].high.length,0);
 assert.equal(stats.normalizeMapStatistics(payload([row({winRateHigh:Array(11).fill(brawler())})]),now).maps[0].high,null);
 for(const value of [{},payload([]),payload([row({id:1})]),payload([row({name:null})]),payload([row(),row()]),payload(Array(3001).fill(row()))])assert.throws(()=>stats.normalizeMapStatistics(value,now));
 assert.throws(()=>stats.mapBandBrawlers(stats.normalizeMapStatistics(payload([row()]),now).maps[0],'1000'));
});
