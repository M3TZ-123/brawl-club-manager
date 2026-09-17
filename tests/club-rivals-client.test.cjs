const test=require('node:test');const assert=require('node:assert/strict');
const {loadTypeScript}=require('./helpers/load-typescript.cjs');
const {hookRenderer,componentMocks,elements,textContent}=require('./helpers/client-renderer.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function fixture(reply){
  const renderer=hookRenderer(),cleanups=new Set(),requests=[];let isAdmin=true,invalidated=0,reloaded=0;
  const react={...renderer.react,useEffect:(effect,deps)=>renderer.react.useEffect(()=>{const cleanup=effect();if(cleanup)cleanups.add(cleanup);return()=>{cleanups.delete(cleanup);cleanup?.();};},deps)};
  const data={clubTag:'#CLUB',rivals:[{tag:'#PYLQ',profile:{name:'Rival',description:'',rosterTrophies:1,memberCount:1,medianTrophies:1,requiredTrophies:0},fetchedAt:null,stale:false,history:[]}],ranks:[],rankingAt:null,rankingStale:false};
  const Page=loadTypeScript('src/app/rivals/page.tsx',{...componentMocks,react,
    '@/hooks/use-admin-session':{useAdminSession:()=>({isAdmin})},
    '@/components/club-ranking-summary':{ClubRankingSummary:'ClubRankingSummary'},
    '@/components/club-rivals-comparison':{ClubRivalsComparison:'ClubRivalsComparison'},
    '@/components/use-feature-resource':{useFeatureResource:url=>({data:url?.startsWith('/api/club-rivals')?data:null,loading:false,error:false,reload:async()=>{reloaded++;}})},
    '@/lib/client-data-cache':{invalidateJsonCache(){invalidated++;}},
    '@/lib/client-fetch':{fetchJsonWithTimeout:async(url,init)=>{const request={url,body:JSON.parse(init.body),signal:init.signal};requests.push(request);return reply(request);}},
  },{Error}).default;
  return{requests,render:()=>renderer.render(Page),setAdmin:value=>{isAdmin=value;},unmount(){for(const cleanup of cleanups)cleanup();cleanups.clear();},effects:()=>({invalidated,reloaded})};
}
const tagInput=tree=>elements(tree).find(node=>node.type==='input'&&node.props.placeholder==='#XXXXXXXX');

test('removing a rival preserves an unrelated typed tag and a completed add cannot erase a newer draft',async()=>{
  const pending=deferred();let writes=0;const page=fixture(()=>++writes===1?{}:pending.promise);
  let tree=await page.render();tagInput(tree).props.onChange({target:{value:'#NEXT'}});tree=await page.render();
  elements(tree).find(node=>node.type==='ClubRivalsComparison').props.onUnfollow('#PYLQ');tree=await page.render();assert.equal(tagInput(tree).props.value,'#NEXT');
  const submit=elements(tree).find(node=>node.type==='form').props.onSubmit;submit({preventDefault(){}});submit({preventDefault(){}});tree=await page.render();
  assert.equal(page.requests.length,2,'Only one add mutation can be pending');
  tagInput(tree).props.onChange({target:{value:'#AFTER'}});tree=await page.render();pending.resolve({});tree=await page.render();
  assert.equal(tagInput(tree).props.value,'#AFTER');assert.equal(page.requests[1].body.tag,'#NEXT');assert.deepEqual(page.effects(),{invalidated:2,reloaded:2});
});

test('rival mutations abort on access loss or unmount and delayed success cannot refresh or clear the form',async()=>{
  for(const boundary of ['logout','unmount']){
    const pending=deferred(),page=fixture(()=>pending.promise);let tree=await page.render();tagInput(tree).props.onChange({target:{value:'#NEXT'}});tree=await page.render();
    elements(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await page.render();
    if(boundary==='logout'){page.setAdmin(false);await page.render();}else page.unmount();
    assert.equal(page.requests[0].signal.aborted,true);pending.resolve({});await page.render();assert.deepEqual(page.effects(),{invalidated:0,reloaded:0});
  }
});

test('failed rival mutation unlocks a retry while preserving the typed tag',async()=>{
  const page=fixture(()=>Promise.reject(new Error('Request timed out. Please try again.')));let tree=await page.render();tagInput(tree).props.onChange({target:{value:'#NEXT'}});tree=await page.render();
  elements(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=await page.render();
  assert.match(textContent(tree),/Request timed out/);assert.equal(tagInput(tree).props.value,'#NEXT');assert.equal(elements(tree).find(node=>node.type==='Button'&&textContent(node)==='Follow club').props.disabled,false);
  assert.deepEqual(page.effects(),{invalidated:0,reloaded:0});
});
