const test=require('node:test');const assert=require('node:assert/strict');
const {loadTypeScript}=require('./helpers/load-typescript.cjs');
const {hookRenderer,componentMocks,elements,textContent,action}=require('./helpers/client-renderer.cjs');
const {stripBrawlColorTags,formatBrawlName}=loadTypeScript('src/lib/brawl-text.ts');
const raw='WELCOME ✨ | <c00ffff>BE ACTIVE⚡CHAT 💬 & PLAY 🐖 OR 🚪</c>| <cff0000>3+ DAYS OFFLINE = 👋</c>| BE RESPECTFUL & ENJOY ! 🎉</c>';
const expected='WELCOME ✨ | BE ACTIVE⚡CHAT 💬 & PLAY 🐖 OR 🚪| 3+ DAYS OFFLINE = 👋| BE RESPECTFUL & ENJOY ! 🎉';
test('removes only recognized Brawl color tags, including the observed production description',()=>{
  assert.equal(stripBrawlColorTags(raw),expected);
  assert.equal(stripBrawlColorTags('<c1>مرحبًا 👋</c>\n<c12>أهلًا</c> <Cff00FF88>✨</C>'),'مرحبًا 👋\nأهلًا ✨');
  const arbitrary='<b>bold</b> <script>alert(1)</script> <img src=x> <c123>unknown</c123> <c1234567>seven</c1234567> <cnope>text</cnope> &lt;c1&gt;';
  assert.equal(stripBrawlColorTags(arbitrary),arbitrary);
  assert.equal(stripBrawlColorTags('plain العربية 🎉\ntext'),'plain العربية 🎉\ntext');
});

test('game names remove known color markup and use caller-localized fallbacks only for empty display text',()=>{
  for(const [rawName,plain] of [['🌴|<c3>HM</c>','🌴|HM'],['Zero<c9>Win</c>','ZeroWin'],['<c8>TRINITY</c>','TRINITY'],[' <Cff00FF88>نجوم ✨</C> ','نجوم ✨'],['A < B > C & Co.','A < B > C & Co.'],['<c123>Unknown</c123>','<c123>Unknown</c123>'],['<img src=x onerror=alert(1)>','<img src=x onerror=alert(1)>']]){
    assert.equal(formatBrawlName(rawName,'Club'),plain);
  }
  for(const empty of [null,undefined,'',' \t\n\u00a0 ','<c3> </c>'])assert.equal(formatBrawlName(empty,'النادي'),'النادي');
});

test('game club and player rankings show cleaned names and nonblank labels without mutating cached data',async()=>{
  const renderer=hookRenderer();
  const rows=[['#ONE','🌴|<c3>HM</c>'],['#TWO','Zero<c9>Win</c>'],['#THREE','<c8>TRINITY</c>'],['#FOUR',' \t\u00a0 '],['#FIVE','<img src=x>']].map(([tag,name],i)=>({tag,name,rank:i+1,trophies:1000,memberCount:null,clubName:'<c9>Related club</c>'}));
  const original=JSON.stringify(rows),snapshot=data=>({data,fetchedAt:'2026-09-17T00:00:00Z',stale:false,refreshing:false});
  const Page=loadTypeScript('src/app/game/page.tsx',{...componentMocks,react:renderer.react,'@/lib/client-data-cache':{fetchJsonCached:async url=>snapshot(url.includes('events')?[]:rows)}},{document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},setInterval:()=>1,clearInterval(){}}).default;
  let tree=await renderer.render(Page);action(tree,'Trophy rankings')();tree=await renderer.render(Page);
  const names=()=>elements(tree).filter(node=>node.type==='span'&&node.props.className==='font-medium break-words').map(textContent);
  assert.deepEqual(names(),['🌴|HM','ZeroWin','TRINITY','Club','<img src=x>']);
  assert.match(textContent(tree),/Related club/);assert.doesNotMatch(textContent(tree),/<c9>|<\/c>/);
  const kind=elements(tree).find(node=>node.type==='select'&&node.props.value==='clubs');kind.props.onChange({target:{value:'players'}});tree=await renderer.render(Page);
  assert.deepEqual(names(),['🌴|HM','ZeroWin','TRINITY','Player','<img src=x>']);
  assert.equal(elements(tree).some(node=>node.type==='img'||node.props?.dangerouslySetInnerHTML),false);
  assert.equal(JSON.stringify(rows),original);
});

test('rival comparisons, details and accessible labels use cleaned names including blank-name fallback',async()=>{
  const renderer=hookRenderer();
  const data={clubTag:'#OWN',region:'TN',rankingAt:null,rankingStale:false,rivals:[{tag:'#RIVAL',profile:{tag:'#RIVAL',name:'<c8>TRINITY</c>',description:''},fetchedAt:null,history:[],stale:false},{tag:'#BLANK',profile:{tag:'#BLANK',name:' \t ',description:''},fetchedAt:null,history:[],stale:false}],ranks:[]};
  const own={club:{tag:'#OWN',metadata:{name:'<c3> </c>'}},strength:{}};
  const original=JSON.stringify({data,own});
  const {ClubRivalsComparison}=loadTypeScript('src/components/club-rivals-comparison.tsx',{...componentMocks,react:renderer.react,'@/components/club-trend-line':{ClubTrendLine:'Trend'},'@/components/club-ranking-summary':{ClubRankingSummary:'RankingSummary'}});
  const render=()=>renderer.render(()=>ClubRivalsComparison({data,own,ownLoading:false,ownError:false,onRetryOwn(){},isAdmin:true,saving:false,onUnfollow(){}}));
  let tree=await render();const text=textContent(tree);
  assert.match(text,/Your club#OWN/);assert.match(text,/TRINITY#RIVAL/);assert.match(text,/Club#BLANK/);assert.doesNotMatch(text,/<c8>|<c3>|<\/c>/);
  elements(tree).find(node=>node.props?.['aria-label']==='Details for TRINITY').props.onClick();tree=await render();
  assert.ok(elements(tree).some(node=>node.props?.['aria-label']==='Stop following TRINITY'));
  assert.equal(elements(tree).find(node=>node.type==='RankingSummary').props.tag,'#RIVAL');
  elements(tree).find(node=>node.props?.['aria-label']==='Details for Club').props.onClick();tree=await render();
  assert.ok(elements(tree).some(node=>node.props?.['aria-label']==='Stop following Club'));
  assert.equal(elements(tree).find(node=>node.type==='RankingSummary').props.tag,'#BLANK');
  assert.doesNotMatch(textContent(tree),/<c8>|<c3>|<\/c>/);
  assert.equal(JSON.stringify({data,own}),original);
});
test('club identity and description history use plain cleaned text without changing raw observations',async()=>{
  const renderer=hookRenderer();const snapshot={club:{tag:'#PYLQ',metadata:{name:'Club',description:raw,type:'open',requiredTrophies:0},memberCount:30,openSeats:0,leaders:[],observedAt:'2026-09-16T00:00:00Z'},metadataHistory:[{id:'1',observedAt:'2026-09-16T00:00:00Z',before:{description:'<c1>قديم</c>'},after:{description:'<c00ff00>جديد</c> <b>نص</b>'},changedFields:['description']}]};
  const initial=JSON.stringify(snapshot);const {ClubIdentity}=loadTypeScript('src/components/club-identity.tsx',{...componentMocks,react:renderer.react,'@/components/club-intelligence-panel':{ClubIntelligencePanel:'Panel',useClubIntelligence:()=>({data:snapshot})}});
  const tree=await renderer.render(()=>ClubIdentity({showHistory:true}));const text=textContent(tree);assert.ok(text.includes(expected));assert.ok(text.includes('قديم → جديد <b>نص</b>'));assert.doesNotMatch(text,/<c00ffff>|<c1>|<\/c>/);assert.equal(JSON.stringify(snapshot),initial);assert.equal(elements(tree).some(e=>e.type==='b'||e.props?.dangerouslySetInnerHTML),false);
});
test('rival descriptions use the same cleaner and preserve literal HTML as text',async()=>{
  const renderer=hookRenderer(),description='<c1>منافس ✨</c> <img src=x>';const rival={tag:'#PYY',profile:{tag:'#PYY',name:'Rival',description},fetchedAt:null,history:[],stale:false};
  const data={clubTag:'#PYLQ',region:'TN',rankingAt:null,rankingStale:false,rivals:[rival],ranks:[]};
  const {ClubRivalsComparison}=loadTypeScript('src/components/club-rivals-comparison.tsx',{...componentMocks,react:renderer.react,'@/components/club-trend-line':{ClubTrendLine:'Trend'},'@/components/club-ranking-summary':{ClubRankingSummary:'RankingSummary'}});
  const render=()=>renderer.render(()=>ClubRivalsComparison({data,own:null,ownLoading:false,ownError:false,onRetryOwn(){},isAdmin:false,saving:false,onUnfollow(){}}));
  let tree=await render();assert.equal(textContent(tree).includes('منافس ✨ <img src=x>'),false);
  elements(tree).find(node=>node.props?.['aria-label']==='Details for Rival').props.onClick();tree=await render();
  assert.ok(textContent(tree).includes('منافس ✨ <img src=x>'));assert.equal(rival.profile.description,description);assert.equal(elements(tree).some(e=>e.type==='img'||e.props?.dangerouslySetInnerHTML),false);
});
