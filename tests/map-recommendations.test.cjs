const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, elements, textContent, action, i18n } = require('./helpers/client-renderer.cjs');
const mapMocks = { ...componentMocks, '@/components/brawl-image': { BrawlImage:'BrawlImage' }, '@/components/ui/sheet': { ...componentMocks['@/components/ui/sheet'], SheetTrigger:'SheetTrigger' } };
const { matchEventMap, rankMapPicks } = loadTypeScript('src/lib/map-recommendations.ts');
const brawler = (id, winRate) => ({ id, name:'Brawler '+id, winRate, pickRate:null, sampleSize:null, adjustedWinRate:null, imageUrl:'https://cdn.brawlify.com/brawlers/borders/'+id+'.png' });
const map = overrides => ({mapId:15000007,mode:'gemGrab',name:'Hard Rock Mine',statsBand:'high',imageUrl:'https://cdn.brawlify.com/maps/regular/15000007.png',sourceUrl:'https://brawlify.com/maps/15000007',statsSource:{name:'BrawlTools',url:'https://api.brawltools.net/docs',official:false},statsPeriod:null,statsUpdatedAt:'2026-09-18T08:00:00Z',statsFetchedAt:'2026-09-18T08:02:00Z',winRateKind:'provider',statsStatus:'available',mapTotalMatches:36053,sampleSize:null,sampleUnit:null,brawlers:[],...overrides});

test('recommendations join exact map IDs and mode aliases, never same names or different formats', () => {
  const event = {id:15000007,map:'Hard Rock Mine',mode:'gemGrab'};
  assert.equal(matchEventMap(event,[map({mapId:15000008})]),null);
  assert.equal(matchEventMap(event,[map({mode:'soloShowdown'})]),null);
  assert.equal(matchEventMap(event,[map({})]).mapId,event.id);
  assert.equal(matchEventMap({...event,mode:'airHockey'},[map({mode:'brawlHockey'})]).mode,'brawlHockey');
  assert.equal(matchEventMap({...event,mode:'duoShowdown'},[map({mode:'soloShowdown'})]),null);
});

test('provider shortlists need no invented samples; invalid numeric rates are rejected and real zero retained', () => {
  const rows=[brawler(1,100),brawler(2,0),brawler(3,75),brawler(4,75),brawler(5,null),brawler(6,NaN),brawler(7,Infinity),brawler(8,-1),brawler(9,101),brawler(10,'80'),brawler(11,undefined)];
  const before=JSON.stringify(rows);
  assert.deepEqual(Array.from(rankMapPicks(rows),row=>row.id),[1,3,4,2]);
  assert.equal(JSON.stringify(rows),before);
  assert.ok(rankMapPicks(rows).every(row=>row.sampleSize===null));
});

test('provider rates keep honest labels and put map totals and timestamps in closed source details', async () => {
  const renderer=hookRenderer();
  const {GameMapPicks}=loadTypeScript('src/components/game-map-detail.tsx',{...mapMocks,react:renderer.react});
  const source=map({brawlers:[brawler(16000000,0),brawler(16000109,75.23)]});
  const tree=await renderer.render(()=>GameMapPicks({map:source,loading:false}));
  assert.match(textContent(tree),/Recommended brawlers.*Source win rate/);
  assert.match(textContent(tree),/75\.2%/);assert.match(textContent(tree),/0%/);
  assert.doesNotMatch(textContent(tree),/results per brawler|1,000\+|600\+|Most played|Ninja|guarantee|1st place/);
  const details=elements(tree).find(node=>node.type==='details');assert.ok(details);assert.notEqual(details.props.open,true);
  assert.match(textContent(details),/higher bracket.*thresholds are not published/);
  assert.match(textContent(details),/Per-brawler sample sizes, pick rates and the reporting period are not provided/);
  assert.match(textContent(details),/Map total reported by source: 36,053/);
  assert.match(textContent(details),/not a sample count for any brawler or bracket/);
  assert.match(textContent(details),/Source snapshot: 2026-09-18T08:00:00Z/);
  assert.match(textContent(details),/Retrieved: 2026-09-18T08:02:00Z/);
  assert.ok(elements(details).some(node=>node.props?.href==='https://api.brawltools.net/docs'));
  const cosmo=elements(tree).find(node=>node.type==='BrawlImage'&&node.props.src.includes('28001337'));
  assert.ok(cosmo,'Verified Cosmo avatar replaces cached broken bordered portraits');
  assert.equal(cosmo.props.width,36);
});

test('top three expand to at most ten; a different map starts compact', async () => {
  const renderer=hookRenderer();
  const {GameMapPicks}=loadTypeScript('src/components/game-map-detail.tsx',{...mapMocks,react:renderer.react});
  const source=map({brawlers:Array.from({length:12},(_,index)=>brawler(16000000+index,80-index))});
  let tree=await renderer.render(()=>GameMapPicks({map:source,loading:false}));
  assert.equal(elements(tree).filter(node=>node.type==='li').length,3);
  action(tree,'More brawlers')();tree=await renderer.render(()=>GameMapPicks({map:source,loading:false}));
  assert.equal(elements(tree).filter(node=>node.type==='li').length,10);
  assert.equal(elements(tree).find(node=>node.type==='button').props['aria-expanded'],true);
  tree=await renderer.render(()=>GameMapPicks({map:{...source,mapId:15000008},loading:false}));
  assert.equal(elements(tree).filter(node=>node.type==='li').length,3);
});

test('missing or invalid statistics stay unavailable rather than creating a rate or fake sample', async () => {
  const renderer=hookRenderer();
  const {GameMapPicks}=loadTypeScript('src/components/game-map-detail.tsx',{...mapMocks,react:renderer.react});
  for(const source of [null,map({brawlers:[brawler(16000000,null)]}),map({winRateKind:null,brawlers:[brawler(16000000,100)]}),map({brawlers:[brawler(16000000,200)],mapTotalMatches:null})]){
    const tree=await renderer.render(()=>GameMapPicks({map:source,loading:false}));
    assert.match(textContent(tree),/No recommendations available/);
    assert.doesNotMatch(textContent(tree),/\d+%/);
    assert.equal(elements(tree).filter(node=>node.type==='li').length,0);
  }
  let tree=await renderer.render(()=>GameMapPicks({map:null,loading:true}));
  assert.ok(elements(tree).some(node=>node.props?.role==='status'&&textContent(node)==='Loading map picks...'));
  tree=await renderer.render(()=>GameMapPicks({map:map({mapTotalMatches:0}),loading:false}));
  assert.match(textContent(tree),/Map total reported by source: 0/,'An explicit provider map total of zero remains zero');
});

test('all Showdown formats show provider-ranked names without unverified percentages and keep stale warnings visible', async () => {
  const renderer=hookRenderer();
  const {GameMapPicks}=loadTypeScript('src/components/game-map-detail.tsx',{...mapMocks,react:renderer.react});
  for(const mode of ['soloShowdown','duoShowdown','trioShowdown','SoloShowdown','soloShowdownLimbo','loadedShowdown','loadedDuoShowdown']){
    const source=map({mode,statsStatus:'stale',brawlers:[{...brawler(16000000,22.5),name:'Lower source rank'},{...brawler(16000001,80),name:'First source rank'}]});
    const tree=await renderer.render(()=>GameMapPicks({map:source,loading:false}));
    const rows=elements(tree).filter(node=>node.type==='li');assert.equal(rows.length,2);
    assert.match(textContent(rows[0]),/First source rank/);
    assert.doesNotMatch(textContent(tree),/\d+%|Source win rate|1st place/);
    const details=elements(tree).find(node=>node.type==='details');
    assert.match(textContent(details),/Showdown percentages are hidden.*definition of a win is unverified/);
    const warning=elements(tree).find(node=>node.type==='p'&&/Saved stats/.test(textContent(node)));
    assert.ok(warning);assert.ok(!elements(details).includes(warning),'Delayed update warning remains outside collapsed details');
  }
});

test('map art is contained, opens an accessible large view and falls back when the CDN image fails', async () => {
  const renderer=hookRenderer();
  const {GameMapImage}=loadTypeScript('src/components/game-map-detail.tsx',{...mapMocks,react:renderer.react});
  let tree=await renderer.render(()=>GameMapImage({map:map({}),name:'Hard Rock Mine',loading:false}));
  const image=elements(tree).find(node=>node.type==='Image');assert.match(image.props.className,/object-contain/);assert.match(image.props.alt,/Hard Rock Mine/);
  const open=elements(tree).find(node=>node.type==='button');assert.match(open.props['aria-label'],/Enlarge/);
  assert.ok(elements(tree).some(node=>node.type==='SheetTrigger'&&node.props.asChild),'The opener participates in dialog focus restoration');
  elements(tree).find(node=>node.type==='Sheet').props.onOpenChange(true);
  tree=await renderer.render(()=>GameMapImage({map:map({}),name:'Hard Rock Mine',loading:false}));
  assert.equal(elements(tree).find(node=>node.type==='Sheet').props.open,true);
  image.props.onError();tree=await renderer.render(()=>GameMapImage({map:map({}),name:'Hard Rock Mine',loading:false}));
  assert.match(textContent(tree),/Map image unavailable/);assert.ok(!elements(tree).some(node=>node.type==='Image'));
});

test('Arabic source limits are translated and the image drawer follows RTL', async () => {
  const {arMapPicks}=loadTypeScript('src/lib/i18n/ar-map-picks.ts');
  const renderer=hookRenderer();
  const locale={...i18n,direction:'rtl',locale:'ar',t:(key,values)=>i18n.t(arMapPicks[key]??key,values)};
  const {GameMapPicks,GameMapImage}=loadTypeScript('src/components/game-map-detail.tsx',{...mapMocks,react:renderer.react,'@/components/locale-provider':{useI18n:()=>locale}});
  let tree=await renderer.render(()=>GameMapPicks({map:map({mode:'duoShowdown',brawlers:[brawler(16000000,50)]}),loading:false}));
  assert.match(textContent(tree),/البراولرز المقترحون/);assert.match(textContent(tree),/تعريف الفوز لدى المصدر غير مؤكد/);
  assert.match(textContent(tree),/حجم العينة لكل براولر/);assert.match(textContent(tree),/وقت لقطة المصدر/);
  assert.doesNotMatch(textContent(tree),/higher bracket|sample sizes|Source snapshot|\d+%/);
  tree=await renderer.render(()=>GameMapImage({map:map({}),name:'Hard Rock Mine',loading:false}));
  assert.equal(elements(tree).find(node=>node.type==='SheetContent').props.side,'left');
});
