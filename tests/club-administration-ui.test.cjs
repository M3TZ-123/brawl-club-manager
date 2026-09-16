const test=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {loadTypeScript}=require('./helpers/load-typescript.cjs');
const {hookRenderer,componentMocks,elements,textContent,action}=require('./helpers/client-renderer.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function hooks(){const base=hookRenderer(),cleanups=new Set();return{...base,react:{...base.react,useEffect(fn,deps){base.react.useEffect(()=>{const cleanup=fn();if(cleanup)cleanups.add(cleanup);return()=>{cleanups.delete(cleanup);cleanup?.();};},deps);}},unmount(){for(const cleanup of cleanups)cleanup();cleanups.clear();}};}
function harness(path,name,props,response){
  const main=hooks(),requests=[],events=[];let active=main;
  const react=new Proxy({},{get:(_,key)=>(...args)=>active.react[key](...args)});
  const Component=loadTypeScript(path,{...componentMocks,react,'@/lib/client-fetch':{fetchJsonWithTimeout:async(url,options={})=>{const request={url,method:options.method||'GET',body:options.body&&JSON.parse(options.body),signal:options.signal};requests.push(request);return response(request,requests);}}},{Error,crypto:{randomUUID},window:{dispatchEvent:event=>events.push(event)},CustomEvent:class{constructor(type){this.type=type;}}})[name];
  return{requests,events,unmount:()=>main.unmount(),render(){active=main;return main.render(()=>Component(props));},mountCard(element){const renderer=hooks();let current=element.props;return{unmount:()=>renderer.unmount(),setProps:value=>{current=value;},render(){active=renderer;return renderer.render(()=>element.type(current));}};}};
}
const input=(tree,label)=>{const node=elements(tree).find(node=>node.type==='label'&&textContent(node).startsWith(label));assert.ok(node,`Missing label ${label}`);return elements(node).find(node=>['Input','input','textarea','select'].includes(node.type));};
const button=(tree,label)=>elements(tree).find(node=>node.type==='Button'&&textContent(node)===label);
const card=tree=>elements(tree).find(node=>node.type?.name==='ApplicationCard');
const info={club_tag:'#CLUB',recruitment_open:true,min_trophies:1000,min_power11:3,min_ranked_points:null,language:'العربية',availability:'Evening'};
const administration={decisions:[],nextCursor:null,absences:[],departures:[{id:randomUUID(),occurred_at:'2026-09-16T12:00:00Z',source:'recorded'}],departuresLimited:false};
const application=(overrides={})=>({id:randomUUID(),player_tag:'#PYLQ',message:'طلب',language:'العربية',availability:'Evening',status:'pending',private_notes:'Saved note',version:1,created_at:'2026-09-16T00:00:00Z',updated_at:'2026-09-16T00:00:00Z',...overrides});

test('join page stays closed without a form and a failed public read has a usable retry',async()=>{
  let reads=0;const page=harness('src/app/join/page.tsx','default',{},()=>++reads===1?Promise.reject(new Error('offline')):{...info,recruitment_open:false});
  let tree=await page.render();assert.match(textContent(tree),/Applications are temporarily unavailable/);assert.equal(elements(tree).some(node=>node.type==='form'),false);
  action(tree,'Retry')();tree=await page.render();assert.match(textContent(tree),/Applications are currently closed/);assert.equal(elements(tree).some(node=>node.type==='form'),false);assert.equal(page.requests.length,2);
});

test('join retries preserve entered details and request identity; acknowledgement does not trigger a profile fetch or invitation',async()=>{
  let writes=0;const page=harness('src/app/join/page.tsx','default',{},request=>request.method==='GET'?info:++writes===1?Promise.reject(new Error('Try again')):{accepted:true});
  let tree=await page.render();assert.equal(button(tree,'Submit application').props.disabled,true);
  input(tree,'Player tag').props.onChange({target:{value:'#PYLQ'}});input(tree,'Application message').props.onChange({target:{value:'My application'}});input(tree,"I agree to share").props.onChange({target:{checked:true}});tree=await page.render();
  await elements(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=await page.render();assert.equal(input(tree,'Player tag').props.value,'#PYLQ');assert.equal(input(tree,'Application message').props.value,'My application');assert.match(textContent(tree),/Try again/);
  await elements(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=await page.render();
  const posts=page.requests.filter(row=>row.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].body.request_id,posts[1].body.request_id);assert.equal(posts[0].body.consent,true);assert.equal(elements(tree).some(node=>node.type==='form'),false);assert.match(textContent(tree),/Application received/);assert.ok(page.requests.every(row=>row.url==='/api/join'));
});

test('dated entries bind the chosen departure and keep the draft and request id after an uncertain save',async()=>{
  let writes=0;const page=harness('src/components/member-administration.tsx','MemberAdministrationPanel',{playerTag:'#PYLQ',isCurrent:false},request=>request.method==='GET'?administration:++writes===1?Promise.reject(new Error('Try again')):{success:true});
  let tree=await page.render();assert.equal(button(tree,'Declare absence'),undefined);
  input(tree,'Entry type').props.onChange({target:{value:'departure_reason'}});tree=await page.render();input(tree,'Entry text').props.onChange({target:{value:'Known reason'}});tree=await page.render();assert.equal(button(tree,'Add dated entry').props.disabled,true);
  input(tree,'Exact recorded departure').props.onChange({target:{value:administration.departures[0].id}});tree=await page.render();action(tree,'Add dated entry')();tree=await page.render();assert.equal(input(tree,'Entry text').props.value,'Known reason');assert.match(textContent(tree),/Try again/);
  action(tree,'Add dated entry')();tree=await page.render();const posts=page.requests.filter(row=>row.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].body.request_id,posts[1].body.request_id);assert.equal(posts[1].body.departure_event_id,administration.departures[0].id);assert.equal(posts[1].body.author,undefined);assert.equal(input(tree,'Entry text').props.value,'');assert.equal(page.events.length,1);
});

test('leaving the member editor aborts an in-flight decision and suppresses late parent notifications',async()=>{
  const pending=deferred();const page=harness('src/components/member-administration.tsx','MemberAdministrationPanel',{playerTag:'#PYLQ',isCurrent:true},request=>request.method==='GET'?administration:pending.promise);
  let tree=await page.render();assert.ok(button(tree,'Declare absence'));input(tree,'Entry text').props.onChange({target:{value:'Draft'}});tree=await page.render();action(tree,'Add dated entry')();await page.render();page.unmount();assert.ok(page.requests.every(row=>row.signal.aborted));pending.resolve({success:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(page.events.length,0);assert.equal(page.requests.length,2);
});

test('criteria conflicts keep the draft and exact revision until an explicit reload',async()=>{
  let reads=0;const saved={...info,grace_hours:24,version:1,updated_at:'2026-09-16T00:00:00Z'};
  const page=harness('src/components/club-administration-settings.tsx','ClubAdministrationSettings',{},request=>request.method==='GET'?{settings:{...saved,version:++reads,grace_hours:reads===1?24:72}}:Promise.reject(new Error('This record changed. Reload before saving.')));
  let tree=await page.render();input(tree,'New member grace hours').props.onChange({target:{value:'48'}});tree=await page.render();action(tree,'Save administration settings')();tree=await page.render();assert.equal(input(tree,'New member grace hours').props.value,48);assert.match(textContent(tree),/This record changed/);assert.equal(page.requests.find(row=>row.method==='PATCH').body.version,1);assert.equal(page.events.length,0);
  action(tree,'Reload saved settings')();tree=await page.render();assert.equal(input(tree,'New member grace hours').props.value,72);assert.equal(page.requests.length,3);
});

test('application drafts keep their baseline revision across reloads and require explicit replacement after a conflict',async()=>{
  const original=application();const page=harness('src/components/recruitment-applications.tsx','RecruitmentApplications',{onCandidate(){}},request=>request.method==='GET'?{applications:[original],total:1,nextCursor:null}:Promise.reject(new Error('This record changed. Reload before saving.')));
  const workspace=await page.render(),originalCard=card(workspace),editor=page.mountCard(originalCard);let tree=await editor.render();input(tree,'Private notes').props.onChange({target:{value:'Unsaved draft'}});tree=await editor.render();
  editor.setProps({...originalCard.props,application:{...original,version:2,private_notes:'Other admin'}});tree=await editor.render();assert.equal(input(tree,'Private notes').props.value,'Unsaved draft');assert.match(textContent(tree),/Your draft is preserved/);
  action(tree,'Save application review')();tree=await editor.render();const save=page.requests.find(row=>row.method==='PATCH');assert.equal(save.body.version,1);assert.equal(save.body.private_notes,'Unsaved draft');assert.equal(input(tree,'Private notes').props.value,'Unsaved draft');
  action(tree,'Load saved review')();tree=await editor.render();assert.equal(input(tree,'Private notes').props.value,'Other admin');assert.equal(originalCard.key,original.id);
});

test('saving an application invalidates an older list read and cursor pagination retains the correct boundary after removal',async()=>{
  const original=application(),later=application({player_tag:'#GGRR'}),oldRead=deferred();let reads=0;
  const page=harness('src/components/recruitment-applications.tsx','RecruitmentApplications',{onCandidate(){}},request=>request.method==='GET'?(++reads===1?{applications:[original],total:2,nextCursor:'boundary'}:reads===2?oldRead.promise:{applications:[later],total:null,nextCursor:null}):{application:{...original,status:'reviewing',version:2}});
  let workspace=await page.render();const editor=page.mountCard(card(workspace));let tree=await editor.render();input(tree,'Application status').props.onChange({target:{value:'reviewing'}});tree=await editor.render();
  action(workspace,'Reload list')();await page.render();action(tree,'Save application review')();await editor.render();workspace=await page.render();assert.equal(card(workspace),undefined);
  oldRead.resolve({applications:[original],total:2,nextCursor:'wrong'});workspace=await page.render();assert.equal(card(workspace),undefined);
  action(workspace,'Load More')();workspace=await page.render();assert.match(page.requests.at(-1).url,/cursor=boundary/);assert.equal(card(workspace).props.application.id,later.id);
});

test('an application card never adds a candidate or updates its parent after logout/unmount',async()=>{
  const original=application(),pending=deferred();let candidates=0;
  const page=harness('src/components/recruitment-applications.tsx','RecruitmentApplications',{onCandidate(){candidates++;}},request=>request.method==='GET'?{applications:[original],total:1,nextCursor:null}:pending.promise);
  const workspace=await page.render(),editor=page.mountCard(card(workspace));const tree=await editor.render();action(tree,'Add to watchlist')();await editor.render();editor.unmount();page.unmount();assert.ok(page.requests.every(row=>row.signal.aborted));pending.resolve({candidate:{}});await new Promise(resolve=>setImmediate(resolve));assert.equal(candidates,0);
});
