const test=require('node:test');const assert=require('node:assert/strict');const{loadTypeScript}=require('./helpers/load-typescript.cjs');
const{hookRenderer,componentMocks,elements,textContent,action}=require('./helpers/client-renderer.cjs');
class FixedDate extends Date { constructor(...args){super(...(args.length?args:['2026-09-16T12:00:00Z']));} static now(){return Date.parse('2026-09-16T12:00:00Z');} }
test('game interface retains category controls and discards late ranking responses after region changes',async()=>{
  const renderer=hookRenderer();let finishGlobal;const global=new Promise(resolve=>{finishGlobal=resolve;});
  const snapshot=data=>({data,fetchedAt:'2026-09-16T12:00:00Z',stale:false,refreshing:false});
  const Page=loadTypeScript('src/app/game/page.tsx',{...componentMocks,react:renderer.react,'@/lib/client-data-cache':{fetchJsonCached:async url=>{
    if(url.includes('events'))return snapshot([{slotId:1,id:15000000,startTime:'2026-09-16T08:00:00Z',endTime:'2026-09-17T08:00:00Z',mode:'brawlBall',map:'Test map'}]);
    if(url.includes('region=TN'))return snapshot([{tag:'#PYLQ',name:'Tunisia fixture',rank:1,trophies:1000,memberCount:null,clubName:null}]);
    return global;
  }}},{Date:FixedDate,document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},setInterval:()=>1,clearInterval(){}}).default;
  let tree=await renderer.render(Page);assert.match(textContent(tree),/Test map/);assert.match(textContent(tree),/Ends in/);
  action(tree,'Trophy rankings')();tree=await renderer.render(Page);
  const region=elements(tree).find(e=>e.type==='select'&&e.props.value==='global');assert.ok(region);region.props.onChange({target:{value:'TN'}});
  tree=await renderer.render(Page);assert.match(textContent(tree),/Tunisia fixture/);
  finishGlobal(snapshot([{tag:'#QQQQ',name:'Stale global fixture',rank:1,trophies:9999,memberCount:null,clubName:null}]));
  tree=await renderer.render(Page);assert.doesNotMatch(textContent(tree),/Stale global fixture/);assert.match(textContent(tree),/Tunisia fixture/);
  assert.ok(elements(tree).some(e=>e.props?.href==='/analysis?map=Test%20map&mode=brawlBall'));
});

test('game marks expired events immediately on return to a visible tab while refresh is still pending',async()=>{
  const renderer=hookRenderer(),listeners=new Set(),requests=[];let now=Date.parse('2026-09-16T12:00:00Z'),eventReads=0;
  class MovingDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const document={visibilityState:'visible',addEventListener(type,listener){if(type==='visibilitychange')listeners.add(listener);},removeEventListener(type,listener){listeners.delete(listener);}};
  const snapshot=data=>({data,fetchedAt:'2026-09-16T12:00:00Z',stale:false,refreshing:false});
  const Page=loadTypeScript('src/app/game/page.tsx',{...componentMocks,react:renderer.react,'@/lib/client-data-cache':{fetchJsonCached:async url=>{
    requests.push(url);if(!url.includes('events'))return snapshot([]);
    if(++eventReads>1)return new Promise(()=>{});
    return snapshot([{slotId:1,id:15000000,startTime:'2026-09-16T08:00:00Z',endTime:'2026-09-16T12:01:00Z',mode:'brawlBall',map:'Expiry fixture'}]);
  }}},{Date:MovingDate,document,setInterval:()=>1,clearInterval(){}}).default;
  let tree=await renderer.render(Page);assert.match(textContent(tree),/Ends in/);
  document.visibilityState='hidden';for(const listener of listeners)listener();
  now=Date.parse('2026-09-16T12:30:00Z');document.visibilityState='visible';for(const listener of listeners)listener();
  tree=await renderer.render(Page);assert.match(textContent(tree),/Event ended/);
  assert.equal(requests.filter(url=>url.includes('kind=clubs')).length,0,'Hidden rankings are not fetched or refreshed');
  action(tree,'Trophy rankings')();tree=await renderer.render(Page);
  assert.equal(requests.filter(url=>url.includes('kind=clubs')).length,1);
  document.visibilityState='hidden';for(const listener of listeners)listener();
  document.visibilityState='visible';for(const listener of listeners)listener();
  await renderer.render(Page);
  assert.equal(requests.filter(url=>url.includes('kind=clubs')).length,2,'Active club rankings recover on visibility without waiting five minutes');
  assert.equal(eventReads,2,'Visibility changes in rankings leave Maps paused');
});

test('a late failed game refresh does not replace a more recent successful event response',async()=>{
  const renderer=hookRenderer();let rejectOld,reads=0;const old=new Promise((resolve,reject)=>{rejectOld=reject;});
  const snapshot=data=>({data,fetchedAt:'2026-09-16T12:00:00Z',stale:false,refreshing:false});
  const Page=loadTypeScript('src/app/game/page.tsx',{...componentMocks,react:renderer.react,'@/lib/client-data-cache':{fetchJsonCached:async url=>{
    if(!url.includes('events'))return snapshot([]);if(++reads===1)return old;
    return snapshot([{slotId:1,id:15000000,startTime:'2026-09-16T08:00:00Z',endTime:'2026-09-17T08:00:00Z',mode:'brawlBall',map:'Fresh event fixture'}]);
  }}},{Date:FixedDate,document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},setInterval:()=>1,clearInterval(){}}).default;
  let tree=await renderer.render(Page);elements(tree).find(node=>node.type==='Button'&&textContent(node)==='Refresh').props.onClick();
  tree=await renderer.render(Page);assert.match(textContent(tree),/Fresh event fixture/);
  rejectOld(new Error('Old failure'));tree=await renderer.render(Page);
  assert.match(textContent(tree),/Fresh event fixture/);assert.doesNotMatch(textContent(tree),/Game data temporarily unavailable/);
});

test('failed rankings offer an immediate retry for the same selection with a pending state',async()=>{
  const renderer=hookRenderer();let attempts=0,finish;const pending=new Promise(resolve=>{finish=resolve;});const calls=[];
  const snapshot=data=>({data,fetchedAt:'2026-09-16T12:00:00Z',stale:false,refreshing:false});
  const Page=loadTypeScript('src/app/game/page.tsx',{...componentMocks,react:renderer.react,'@/lib/client-data-cache':{fetchJsonCached:async(url,options)=>{
    if(url.includes('events'))return snapshot([]);calls.push({url,options});if(++attempts===1)throw Error('Unavailable');return pending;
  }}},{Date:FixedDate,document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},setInterval:()=>1,clearInterval(){}}).default;
  let tree=await renderer.render(Page);action(tree,'Trophy rankings')();tree=await renderer.render(Page);assert.match(textContent(tree),/Game data temporarily unavailable/);
  let retry=elements(tree).find(node=>node.type==='Button'&&textContent(node)==='Retry');assert.ok(retry,'Rankings need an immediate retry without switching filters or waiting five minutes');
  retry.props.onClick();tree=await renderer.render(Page);
  retry=elements(tree).find(node=>node.type==='Button'&&textContent(node)==='Retry');assert.equal(retry.props.disabled,true);
  assert.equal(calls.length,2);assert.equal(calls[1].url,'/api/game?kind=clubs&region=global');assert.equal(calls[1].options.force,true);
  finish(snapshot([{tag:'#PYLQ',name:'Recovered ranking',rank:1,trophies:1000,memberCount:null,clubName:null}]));tree=await renderer.render(Page);
  assert.match(textContent(tree),/Recovered ranking/);assert.doesNotMatch(textContent(tree),/Game data temporarily unavailable/);
});

test('game polls only the selected view and reopening Maps expires cached events before its pending refresh',async()=>{
  const renderer=hookRenderer(),timers=new Map(),listeners=new Set(),requests=[];
  let timerId=0,eventReads=0,now=Date.parse('2026-09-16T12:00:00Z');
  class MovingDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const document={visibilityState:'visible',addEventListener(type,listener){if(type==='visibilitychange')listeners.add(listener);},removeEventListener(type,listener){listeners.delete(listener);}};
  const snapshot=data=>({data,fetchedAt:'2026-09-16T12:00:00Z',stale:false,refreshing:false});
  const Page=loadTypeScript('src/app/game/page.tsx',{...componentMocks,react:renderer.react,'@/lib/client-data-cache':{fetchJsonCached:async url=>{
    requests.push(url);
    if(!url.includes('events'))return snapshot([{tag:'#CLUB',name:'Saved ranking',rank:1,trophies:1000,memberCount:30,clubName:null}]);
    if(++eventReads>1)return new Promise(()=>{});
    return snapshot([{slotId:1,id:15000000,startTime:'2026-09-16T08:00:00Z',endTime:'2026-09-16T12:01:00Z',mode:'brawlBall',map:'Saved map'}]);
  }}},{Date:MovingDate,document,setInterval:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;},clearInterval:id=>timers.delete(id)}).default;
  let tree=await renderer.render(Page);
  assert.deepEqual(requests,['/api/game?kind=events']);
  assert.deepEqual([...timers.values()].map(timer=>timer.delay).sort((a,b)=>a-b),[30_000,60_000]);
  action(tree,'Trophy rankings')();tree=await renderer.render(Page);
  assert.deepEqual([...timers.values()].map(timer=>timer.delay),[300_000]);
  assert.equal(listeners.size,1,'Only the selected view keeps a visibility listener');
  assert.match(textContent(tree),/Saved ranking/);
  now=Date.parse('2026-09-16T12:30:00Z');
  for(const timer of timers.values())timer.callback();tree=await renderer.render(Page);
  assert.equal(eventReads,1,'Polling rankings does not reload hidden Maps');
  const rankingReads=requests.filter(url=>url.includes('kind=clubs')).length;
  action(tree,'Current maps')();tree=await renderer.render(Page);
  assert.equal(eventReads,2);
  const visibleMaps=elements(tree).find(node=>node.props?.['aria-labelledby']==='rotation-heading');
  assert.equal(visibleMaps.props.hidden,false);assert.match(textContent(visibleMaps),/Saved map.*Event ended/);
  assert.deepEqual([...timers.values()].map(timer=>timer.delay).sort((a,b)=>a-b),[30_000,60_000]);
  for(const timer of timers.values())timer.callback();await renderer.render(Page);
  assert.equal(requests.filter(url=>url.includes('kind=clubs')).length,rankingReads,'Reactivated Maps leave ranking polls paused');
  assert.match(textContent(tree),/Saved ranking/,'Switching views preserves already loaded data');
});
