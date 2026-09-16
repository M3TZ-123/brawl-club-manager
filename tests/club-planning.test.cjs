const test=require('node:test');const assert=require('node:assert/strict');const{randomUUID}=require('node:crypto');
const{loadTypeScript}=require('./helpers/load-typescript.cjs');const{readOnlyDatabase}=require('./helpers/read-only-database.cjs');
const{hookRenderer,componentMocks,windowMock,elements,textContent}=require('./helpers/client-renderer.cjs');
const fixedNow=Date.parse('2026-09-16T12:00:00Z');
const sampleEvent={title:'September cup',kind:'mega_pig',cycleLabel:'September 2026',startsAt:'2026-09-16T10:00:00Z',endsAt:'2026-09-16T11:00:00Z',teamSize:1,ticketAllowance:15,status:'completed',notes:'PRIVATE EVENT'};
const sampleEntry={playerTag:'#AAA',team:1,slot:'starter',attendance:'present',wins:0,ticketsRemaining:null,observedAt:'2026-09-16T10:30:00Z',notes:'PRIVATE NOTE'};
const mutation={action:'save_event',id:null,version:0,event:sampleEvent,entries:[sampleEntry],reason:''};
test('planning input validates cycle boundaries, explicit unknowns, integer counts and starter capacity',()=>{
  const{planningInput}=loadTypeScript('src/lib/club-planning-input.ts');const result=planningInput(mutation,fixedNow);assert.equal(result.entries[0].wins,0);assert.equal(result.entries[0].ticketsRemaining,null);
  for(const value of [
    {...mutation,event:{...sampleEvent,endsAt:'2026-09-16T09:00:00Z'}},
    {...mutation,event:{...sampleEvent,startsAt:'2026-02-30T10:00:00Z'}},
    {...mutation,entries:[sampleEntry,{...sampleEntry}]},
    {...mutation,entries:[sampleEntry,{...sampleEntry,playerTag:'#BBB'}]},
    {...mutation,entries:[{...sampleEntry,wins:1.5}]},
    {...mutation,entries:[{...sampleEntry,wins:6,ticketsRemaining:10}]},
    {...mutation,entries:[{...sampleEntry,observedAt:'2026-09-16T11:30:00Z'}]},
    {...mutation,entries:[{...sampleEntry,observedAt:null}]},
    {...mutation,entries:[{...sampleEntry,source:'automatic'}]},
    {...mutation,event:{...sampleEvent,kind:'ranked',ticketAllowance:null}},
    {action:'create_goal',title:'Goal',metric:'trophies',cycle:'custom',target:1,endsAt:'2026-09-16T11:00:00Z'},
  ])assert.throws(()=>planningInput(value,fixedNow));
  assert.equal(planningInput({...mutation,entries:[sampleEntry,{...sampleEntry,playerTag:'#BBB',slot:'substitute'}]},fixedNow).entries.length,2);
});
const next={NextResponse:{json:Response.json}};const env={ADMIN_PASSWORD:'test-password',ADMIN_SESSION_SECRET:'test-secret',NODE_ENV:'test'};const globals={process:{env},Error};
const{createAdminSessionToken}=loadTypeScript('src/lib/admin-auth.ts',{'next/server':next},globals);
function request(path,{body,admin=false,origin='https://club.test'}={}){const req=new Request(`https://club.test${path}`,{method:body===undefined?'GET':'PATCH',headers:{origin,host:'club.test','content-type':'application/json',...(admin?{cookie:`brawlstatz_admin=${createAdminSessionToken()}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});Object.defineProperty(req,'nextUrl',{value:new URL(req.url)});return req;}
function routeFixture(){
  const id=randomUUID(),calls=[];
  const db={...readOnlyDatabase({settings:[{key:'club_tag',value:'#CLUB'}],club_goals:[{id,club_tag:'#CLUB',title:'Goal',metric:'trophies',cycle:'weekly',starts_at:'2026-09-16T00:00:00Z',ends_at:'2026-09-23T00:00:00Z',target:100,progress:null,status:'active',version:1,cohort_count:2,known_members:0,limited:true,possible_gap:false,achieved_at:null,refreshed_at:null,owner_user_id:'PRIVATE'}],club_planned_events:[{id,club_tag:'#CLUB',title:sampleEvent.title,kind:'mega_pig',cycle_label:'September',starts_at:sampleEvent.startsAt,ends_at:sampleEvent.endsAt,team_size:3,ticket_allowance:15,status:'completed',version:1,notes:'PRIVATE EVENT',updated_at:'2026-09-16T11:30:00Z',future_secret:'PRIVATE'}],member_history:[{player_tag:'#AAA',player_name:'Alpha',is_current_member:true}],club_event_entries:[{event_id:id,player_tag:'#AAA',player_name:'Alpha',team:1,slot:'starter',attendance:'present',wins:0,tickets_remaining:null,observed_at:sampleEntry.observedAt,notes:'PRIVATE NOTE',owner_user_id:'PRIVATE'}],club_event_revisions:[]}),rpc:async(name,args)=>{calls.push({name,args});return{data:id,error:null};}};
  const route=loadTypeScript('src/app/api/club-planning/route.ts',{'next/server':next,'@/lib/supabase-admin':{supabaseAdmin:db}},globals);return{route,db,id,calls};
}
test('public summaries never expose attendance, notes, members or future private columns',async()=>{
  const{route,id}=routeFixture();const response=await route.GET(request('/api/club-planning'));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('vary'),'Cookie');const data=await response.json();assert.equal(data.goals[0].progress,null);assert.equal(data.events.length,1);assert.equal(data.roster,undefined);assert.doesNotMatch(JSON.stringify(data),/PRIVATE|owner_user_id|notes|attendance|revisions/);
  assert.equal((await route.GET(request(`/api/club-planning?event=${id}`))).status,401);
  const privateData=await(await route.GET(request(`/api/club-planning?event=${id}`,{admin:true}))).json();assert.equal(privateData.eventDetail.entries[0].notes,'PRIVATE NOTE');assert.equal(privateData.eventDetail.entries[0].ticketsRemaining,null);assert.equal(privateData.eventDetail.entries[0].wins,0);assert.doesNotMatch(JSON.stringify(privateData),/owner_user_id|future_secret/);
  const forcedPublic=await(await route.GET(request('/api/club-planning?public=1',{admin:true}))).json();assert.equal(forcedPublic.roster,undefined);assert.equal(forcedPublic.events[0].notes,undefined);
});
test('mutations reject unauthenticated and cross-origin requests before storage and return safe conflicts',async()=>{
  const{route,calls,db,id}=routeFixture(),body={action:'archive_goal',id,version:1};
  assert.equal((await route.PATCH(request('/api/club-planning',{body}))).status,401);assert.equal((await route.PATCH(request('/api/club-planning',{body,admin:true,origin:'https://other.test'}))).status,403);assert.equal(calls.length,0);
  db.rpc=async()=>({data:null,error:{code:'40001',message:'PRIVATE DATABASE DIAGNOSTIC'}});const response=await route.PATCH(request('/api/club-planning',{body,admin:true}));assert.equal(response.status,409);assert.match((await response.json()).error,/draft is preserved/);
});
test('optional progress refresh failure preserves saved public summaries with an explicit deferred flag',async()=>{
  const{route,db}=routeFixture();db.rpc=async()=>({data:null,error:{code:'57014',message:'PRIVATE diagnostic'}});const response=await route.GET(request('/api/club-planning'));assert.equal(response.status,200);const value=await response.json();assert.equal(value.refreshDeferred,true);assert.equal(value.goals.length,1);assert.doesNotMatch(JSON.stringify(value),/PRIVATE|diagnostic/);
});
test('event editor keeps a draft after conflict and submits the exact loaded revision with manual nulls',async()=>{
  const renderer=hookRenderer(),calls=[];const event={...sampleEvent,id:randomUUID(),version:7,updatedAt:'2026-09-16T11:30:00Z'};
  const{ClubEventEditor}=loadTypeScript('src/components/club-event-editor.tsx',{...componentMocks,react:renderer.react,'@/lib/client-fetch':{fetchJsonWithTimeout:async(url,init)=>{calls.push(JSON.parse(init.body));throw new Error('Planning changed. Reload before saving. Your draft is preserved.');}}},{window:windowMock,Error});
  const props={event,data:{goals:[],events:[event],roster:[{tag:'#AAA',name:'Alpha'}],eventDetail:{id:event.id,entries:[{...sampleEntry,playerName:'Alpha'}],revisions:[]}},onSaved:()=>assert.fail('A failed mutation cannot close the editor'),onCancel(){}};
  let tree=await renderer.render(()=>ClubEventEditor(props));const note=elements(tree).find(e=>e.type==='textarea');note.props.onChange({target:{value:'My unsaved correction'}});tree=await renderer.render(()=>ClubEventEditor(props));elements(tree).find(e=>e.type==='form').props.onSubmit({preventDefault(){}});tree=await renderer.render(()=>ClubEventEditor(props));assert.equal(calls[0].version,7);assert.equal(calls[0].event.notes,'My unsaved correction');assert.equal(calls[0].entries[0].wins,0);assert.equal(calls[0].entries[0].ticketsRemaining,null);assert.equal(elements(tree).find(e=>e.type==='textarea').props.value,'My unsaved correction');assert.match(textContent(tree),/draft is preserved/);
});
test('planning requests abort on unmount and cannot apply a delayed private mutation',async()=>{
  const renderer=hookRenderer(),cleanups=[];const react={...renderer.react,useEffect:(effect,deps)=>renderer.react.useEffect(()=>{const cleanup=effect();cleanups.push(cleanup);return cleanup;},deps)};let finish,signal,saved=false;
  const{usePlanningMutation}=loadTypeScript('src/lib/club-planning-client.ts',{react,'@/lib/client-fetch':{fetchJsonWithTimeout:(_url,init)=>{signal=init.signal;return new Promise(resolve=>{finish=resolve;});}}});
  let state;await renderer.render(()=>{state=usePlanningMutation(()=>{saved=true;});return null;});const pending=state.save(mutation);cleanups.forEach(c=>c?.());assert.equal(signal.aborted,true);finish({id:'saved'});await pending;assert.equal(saved,false);
});
test('a newer planning read wins and failed reloads report failure without replacing saved data',async()=>{
  const renderer=hookRenderer(),requests=[];const{usePlanningResource}=loadTypeScript('src/lib/club-planning-client.ts',{react:renderer.react,'@/lib/client-fetch':{fetchJsonWithTimeout:(_url,init)=>new Promise((resolve,reject)=>requests.push({resolve,reject,signal:init.signal}))}},{Error});
  let state;const render=()=>renderer.render(()=>{state=usePlanningResource('/api/club-planning');return null;});await render();const newer=state.reload();assert.equal(requests[0].signal.aborted,true);requests[1].resolve({goals:[{title:'New'}],events:[]});assert.equal(await newer,true);requests[0].resolve({goals:[{title:'Old'}],events:[]});await render();assert.equal(state.data.goals[0].title,'New');
  const failed=state.reload();requests[2].reject(new Error('Unavailable'));assert.equal(await failed,false);await render();assert.equal(state.data.goals[0].title,'New');assert.equal(state.error,'Unavailable');
});
test('changing a goal or event URL immediately hides the previous record while the new read is pending',async()=>{
  const renderer=hookRenderer(),requests=[];const{usePlanningResource}=loadTypeScript('src/lib/club-planning-client.ts',{react:renderer.react,'@/lib/client-fetch':{fetchJsonWithTimeout:(url,init)=>new Promise(resolve=>requests.push({url,resolve,signal:init.signal}))}});let url='/api/club-planning?event=first',state;
  const render=()=>renderer.render(()=>{state=usePlanningResource(url);return null;});await render();requests[0].resolve({events:[{id:'first',notes:'private first'}],goals:[]});await render();assert.equal(state.data.events[0].id,'first');url='/api/club-planning?event=second';await render();assert.equal(state.data,null);assert.equal(state.loading,true);assert.equal(requests[0].signal.aborted,true);requests[1].resolve({events:[{id:'second'}],goals:[]});await render();assert.equal(state.data.events[0].id,'second');
});
test('public planning workspace hides editors and exposes only public summary actions',async()=>{
  const renderer=hookRenderer();const resources={goals:[],events:[],roster:[{tag:'#PRIVATE',name:'Should not be rendered'}]};const{PlanningWorkspace}=loadTypeScript('src/app/club-planning/page.tsx',{...componentMocks,react:renderer.react,'@/hooks/use-admin-session':{useAdminSession:()=>({isAdmin:false})},'@/lib/client-fetch':{fetchJsonWithTimeout:async()=>resources}}, {window:windowMock});
  const tree=await renderer.render(()=>PlanningWorkspace({isAdmin:false}));assert.doesNotMatch(textContent(tree),/Should not be rendered/);assert.match(textContent(tree),/Sign in to plan goals and events/);assert.equal(elements(tree).filter(e=>e.type==='form').length,0);
});
test('changing administrator access remounts the planning workspace instead of retaining private drafts',async()=>{
  const renderer=hookRenderer();let isAdmin=true;
  const Page=loadTypeScript('src/app/club-planning/page.tsx',{...componentMocks,react:renderer.react,'@/hooks/use-admin-session':{useAdminSession:()=>({isAdmin})},'@/lib/client-fetch':{fetchJsonWithTimeout:async()=>({goals:[],events:[]})}},{window:windowMock}).default;
  const admin=await renderer.render(Page);const before=elements(admin).find(e=>e.props?.isAdmin===true);assert.equal(before.key,'admin');isAdmin=false;const publicTree=await renderer.render(Page);const after=elements(publicTree).find(e=>e.props?.isAdmin===false);assert.equal(after.key,'public');
});
