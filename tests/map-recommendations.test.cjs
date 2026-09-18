const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { hookRenderer, componentMocks, elements, textContent } = require('./helpers/client-renderer.cjs');
const mapMocks = { ...componentMocks, '@/components/ui/sheet': { ...componentMocks['@/components/ui/sheet'], SheetTrigger:'SheetTrigger' } };
const { matchEventMap, rankMapPicks } = loadTypeScript('src/lib/map-recommendations.ts');
const brawler = (id, winRate, pickRate, sampleSize) => ({ id, name:`Brawler ${id}`, winRate, pickRate, sampleSize, adjustedWinRate:null, imageUrl:`https://cdn.brawlify.com/brawlers/borderless/${id}.png` });
const map = overrides => ({mapId:15000007,mode:'gemGrab',name:'Hard Rock Mine',imageUrl:'https://cdn.brawlify.com/maps/regular/15000007.png',sourceUrl:'https://brawlify.com/maps/15000007',statsSource:{name:'Brawl Time Ninja',url:'https://brawltime.ninja',official:false},statsPeriod:null,statsUpdatedAt:null,statsFetchedAt:null,winRateKind:'victory',statsStatus:'available',sampleSize:2500,sampleUnit:'player_results',brawlers:[],...overrides});

test('recommendations join exact map IDs and mode aliases, never same names or different formats', () => {
  const event = {id:15000007,map:'Hard Rock Mine',mode:'gemGrab'};
  assert.equal(matchEventMap(event,[map({mapId:15000008})]),null);
  assert.equal(matchEventMap(event,[map({mode:'soloShowdown'})]),null);
  assert.equal(matchEventMap(event,[map({})]).mapId,event.id);
  assert.equal(matchEventMap({...event,mode:'airHockey'},[map({mode:'brawlHockey'})]).mode,'brawlHockey');
});

test('map picks exclude tiny or unknown samples and retain real zero rates without mutating the source', () => {
  const rows=[brawler(1,100,1,9),brawler(2,80,8,null),brawler(3,65,5,1000),brawler(4,70,2,500),brawler(5,0,20,800),brawler(6,null,null,800)];
  const before=JSON.stringify(rows);
  assert.deepEqual(Array.from(rankMapPicks(rows,'winRate'),row=>row.id),[4,3,5]);
  assert.deepEqual(Array.from(rankMapPicks(rows,'pickRate'),row=>row.id),[5,3,4]);
  assert.equal(JSON.stringify(rows),before);
});

test('map recommendations show sample sizes and source details, with no invented rates for missing maps', async () => {
  const renderer=hookRenderer();
  const {GameMapPicks}=loadTypeScript('src/components/game-map-detail.tsx',{...mapMocks,react:renderer.react});
  let tree=await renderer.render(()=>GameMapPicks({map:map({brawlers:[brawler(16000000,0,8,500),brawler(16000001,75.23,20,1000)]}),order:'winRate',loading:false}));
  assert.match(textContent(tree),/75\.2%/);assert.match(textContent(tree),/0%/);assert.match(textContent(tree),/1,000 results/);
  assert.ok(elements(tree).some(node=>node.type==='details'&&textContent(node).includes('Stats details')));
  tree=await renderer.render(()=>GameMapPicks({map:null,order:'winRate',loading:false}));
  assert.match(textContent(tree),/No recent stats/);assert.doesNotMatch(textContent(tree),/0%|100%/);
  tree=await renderer.render(()=>GameMapPicks({map:map({brawlers:[brawler(1,100,100,4)]}),order:'winRate',loading:false}));
  assert.match(textContent(tree),/Not enough recorded results/);assert.doesNotMatch(textContent(tree),/100%/);
});

test('map art is contained, opens an accessible large view and falls back when the CDN image fails', async () => {
  const renderer=hookRenderer();
  const {GameMapImage}=loadTypeScript('src/components/game-map-detail.tsx',{...mapMocks,react:renderer.react});
  let tree=await renderer.render(()=>GameMapImage({map:map({}),name:'Hard Rock Mine',loading:false}));
  const image=elements(tree).find(node=>node.type==='Image');assert.match(image.props.className,/object-contain/);assert.match(image.props.alt,/Hard Rock Mine/);
  const open=elements(tree).find(node=>node.type==='button');assert.match(open.props['aria-label'],/Enlarge/);
  assert.ok(elements(tree).some(node=>node.type==='SheetTrigger'&&node.props.asChild),'The opener participates in dialog focus restoration');
  const sheet=elements(tree).find(node=>node.type==='Sheet');sheet.props.onOpenChange(true);
  tree=await renderer.render(()=>GameMapImage({map:map({}),name:'Hard Rock Mine',loading:false}));
  assert.equal(elements(tree).find(node=>node.type==='Sheet').props.open,true);
  image.props.onError();tree=await renderer.render(()=>GameMapImage({map:map({}),name:'Hard Rock Mine',loading:false}));
  assert.match(textContent(tree),/Map image unavailable/);assert.ok(!elements(tree).some(node=>node.type==='Image'));
});

test('Showdown uses first-place labels and delayed stats retain a visible warning', async () => {
  const renderer=hookRenderer();
  const {GameMapPicks}=loadTypeScript('src/components/game-map-detail.tsx',{...mapMocks,react:renderer.react});
  const source=map({mode:'soloShowdown',winRateKind:'first_place',statsStatus:'stale',brawlers:[brawler(16000000,22.5,8,1000)]});
  let tree=await renderer.render(()=>GameMapPicks({map:source,order:'winRate',loading:false}));
  assert.match(textContent(tree),/Highest first-place rates/);assert.match(textContent(tree),/22\.5%.*1st place/);assert.match(textContent(tree),/Saved stats .*update delayed/);
  tree=await renderer.render(()=>GameMapPicks({map:{...source,winRateKind:null,brawlers:[brawler(16000000,null,8,1000)]},order:'winRate',loading:false}));
  assert.match(textContent(tree),/Win rates unavailable/);assert.doesNotMatch(textContent(tree),/0%/);
});
