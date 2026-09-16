const test=require('node:test');const assert=require('node:assert/strict');
const{loadTypeScript}=require('./helpers/load-typescript.cjs');
const{hookRenderer,componentMocks,windowMock,elements,textContent,action}=require('./helpers/client-renderer.cjs');
test('calendar links preserve the exact member and UTC day through the battle feed initial read',async()=>{
  const{activityCellLink}=loadTypeScript('src/lib/club-intelligence.ts');
  const calendarRenderer=hookRenderer();const href=activityCellLink('#PYLQ','2026-08-04');
  const calendar={observedParticipations:2,recordedDays:1,days:['2026-08-04','2026-08-05'],rows:[{playerTag:'#PYLQ',playerName:'Player',cells:[{day:'2026-08-04',battles:2,coverage:'monitored',href},{day:'2026-08-05',battles:null,coverage:'before_tracking',href:activityCellLink('#PYLQ','2026-08-05')}]}]};
  const{ClubActivityCalendar}=loadTypeScript('src/components/club-activity-calendar.tsx',{...componentMocks,react:calendarRenderer.react,'@/components/club-intelligence-panel':{ClubIntelligencePanel:'Panel',useClubIntelligence:()=>({data:{calendar},loading:false,error:false})}});
  const calendarTree=await calendarRenderer.render(()=>ClubActivityCalendar({range:'90d'}));
  const cells=elements(calendarTree).filter(e=>e.props?.href?.startsWith('/battle-feed?'));assert.equal(cells.length,2);assert.match(cells[1].props['aria-label'],/Unknown.*Before monitoring baseline/);assert.equal(textContent(cells[1]),'—');
  const requests=[],renderer=hookRenderer();const Page=loadTypeScript('src/app/battle-feed/page.tsx',{...componentMocks,react:renderer.react,'@/lib/client-data-cache':{fetchJsonCached:async url=>{requests.push(url);return{matches:[],members:[],modes:[],contexts:[],total:0,nextOffset:null};}}},{window:{...windowMock,location:{search:new URL(cells[0].props.href,'https://club.test').search}},document:windowMock}).default;
  let tree=await renderer.render(Page);assert.equal(requests.length,1);const params=new URL(requests[0],'https://club.test').searchParams;assert.equal(params.get('player'),'#PYLQ');assert.equal(params.get('date'),'2026-08-04');assert.match(textContent(tree),/2026-08-04.*UTC/);
  action(tree,'Clear date filter')();tree=await renderer.render(Page);const reset=new URL(requests.at(-1),'https://club.test').searchParams;assert.equal(reset.get('date'),null);assert.equal(reset.get('player'),'#PYLQ');assert.equal(reset.get('range'),'7d');
});
test('primary navigation stays visible and private destinations remain gated in secondary groups',async()=>{
  const renderer=hookRenderer();let isAdmin=false,pathname='/members/%23PYLQ';
  const react={...renderer.react,createContext:()=>({Provider:'Provider'}),useContext:()=>({isOpen:true,close(){},toggle(){}})};
  const state={sidebarOpen:true,toggleSidebar(){},setSidebarOpen(){},clubName:'Club',lastSyncTime:null,clubTag:'#PYLQ',apiKeyConfigured:true,loadSettingsFromDB(){}};
  const store=Object.assign(selector=>selector?selector(state):state,{getState:()=>state});
  const{LayoutWrapper}=loadTypeScript('src/components/layout-wrapper.tsx',{...componentMocks,react,'next/navigation':{usePathname:()=>pathname},'@/lib/store':{useAppStore:store},'@/hooks/use-admin-session':{useAdminSession:()=>({isAdmin,isLoading:false})},'@/components/sync-health':{useSyncHealth:()=>({})}},{window:{...windowMock,matchMedia:()=>({matches:false})}});
  const render=()=>renderer.render(()=>{const layout=LayoutWrapper({children:null});const sidebar=elements(layout).find(e=>e.type?.name==='SimpleSidebar');assert.ok(sidebar);return sidebar.type(sidebar.props);});
  let tree=await render();const group=(tree,name)=>elements(tree).find(e=>e.type==='details'&&textContent(e.props.children[0])===name);
  assert.equal(elements(tree).filter(e=>e.type==='details').length,2);
  assert.equal(group(tree,'More club tools').props.open,false);
  assert.equal(elements(tree).find(e=>e.props?.href==='/members').props['aria-current'],'page');
  for(const section of elements(tree).filter(e=>e.type==='details'))assert.equal(elements(section).some(e=>e.props?.href==='/members'),false,'Primary Members link is never hidden in a disclosure');
  let links=elements(tree).filter(e=>e.props?.href).map(e=>e.props.href);assert.ok(links.includes('/club-planning'));for(const href of ['/reviews','/settings','/recruitment'])assert.equal(links.includes(href),false);
  isAdmin=true;pathname='/recruitment';tree=await render();links=elements(tree).filter(e=>e.props?.href).map(e=>e.props.href);for(const href of ['/reviews','/settings','/recruitment'])assert.ok(links.includes(href));assert.equal(group(tree,'Management').props.open,true);
});
test('roster comparison has its own explicit period and passes each selected range to the growth panel',async()=>{
  const renderer=hookRenderer();const{ClubGrowthPeriod}=loadTypeScript('src/components/club-growth-period.tsx',{...componentMocks,react:renderer.react,'@/components/club-growth':{ClubGrowth:'ClubGrowth'}});
  let tree=await renderer.render(ClubGrowthPeriod);assert.match(textContent(tree),/Roster comparison period/);assert.equal(elements(tree).find(e=>e.type==='ClubGrowth').props.range,'7d');
  for(const range of ['30d','90d']){elements(tree).find(e=>e.type==='select').props.onChange({target:{value:range}});tree=await renderer.render(ClubGrowthPeriod);assert.equal(elements(tree).find(e=>e.type==='ClubGrowth').props.range,range);}
});
async function reportImage({planning,report={},locale='en'}={}){
  const renderer=hookRenderer(),drawn=[],downloads=[],context={fillRect(){},fillText(text,x,y){drawn.push({text,x,y});}};
  const{translate}=loadTypeScript('src/lib/i18n/messages.ts');const i18n={...require('./helpers/client-renderer.cjs').i18n,locale,direction:locale==='ar'?'rtl':'ltr',t:(text,values)=>translate(text,locale,values)};
  const canvas={getContext:()=>context,toBlob:callback=>callback(new Blob(['png'],{type:'image/png'}))};const document={fonts:{ready:Promise.resolve()},createElement:type=>type==='canvas'?canvas:{click(){downloads.push({href:this.href,download:this.download});}}};
  const{ClubReportCard}=loadTypeScript('src/components/club-report-card.tsx',{...componentMocks,react:renderer.react,'@/components/locale-provider':{useI18n:()=>i18n},'@/lib/store':{useAppStore:selector=>selector({clubName:'Test club'})},'@/components/use-feature-resource':{useFeatureResource:url=>{assert.equal(url,'/api/club-planning?overview=1&public=1');return planning||{data:{goals:[],events:[]},error:false,loading:false};}}},{document,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},setTimeout:fn=>{fn();return 0;}});
  const value={generatedAt:'2026-09-16T12:00:00Z',period:{start:'2026-09-10T00:00:00Z',end:'2026-09-16T12:00:00Z'},summary:{totalMembers:30,totalTrophies:100000,weeklyBattles:0,weeklyWins:0,weeklyWinRate:0},private_notes:'SECRET',...report};
  let tree=await renderer.render(()=>ClubReportCard({report:value}));action(tree,locale==='ar'?translate('Download report image','ar'):'Download report image')();tree=await renderer.render(()=>ClubReportCard({report:value}));assert.doesNotMatch(textContent(tree),/Report image could not/);const link=elements(tree).find(e=>e.type==='a'&&e.props.download);assert.ok(link,'Generated image has an explicit browser download link');assert.equal(link.props.href,'blob:test');downloads.push(link.props);return{drawn:drawn.map(r=>r.text),positions:drawn,context,downloads,canvas};
}
test('report image preserves unknown coverage and zero-observation win share without exposing private fields',async()=>{
  const image=await reportImage();assert.equal(image.downloads.length,1);assert.equal(image.canvas.width,1200);assert.equal(image.canvas.height,900);assert.ok(image.drawn.includes('—'));assert.ok(image.drawn.includes('Trophy progress coverage: Unknown/30 members'));assert.ok(image.drawn.includes('No current club goals.'));assert.doesNotMatch(image.drawn.join('\n'),/SECRET|0%/);assert.ok(image.positions.every(row=>row.y<900));
});
test('report image omits ended goals and does not present failed or deferred observations as current',async()=>{
  const future=new Date(Date.now()+86400000).toISOString(),past=new Date(Date.now()-86400000).toISOString();const goals=[{title:'Ended goal',status:'active',endsAt:past,progress:1,target:2},{title:'Current goal',status:'active',endsAt:future,progress:null,target:2,limited:true,notes:'SECRET'}, {title:'Archived goal',status:'archived',endsAt:future,progress:2,target:2}];
  const success=await reportImage({planning:{data:{goals},error:false,loading:false}});assert.ok(success.drawn.some(text=>text==='Current goal: Unknown / 2 · Limited observations'));assert.doesNotMatch(success.drawn.join('\n'),/Ended goal|Archived goal|SECRET/);
  for(const planning of [{data:{goals},error:true,loading:false},{data:{goals,refreshDeferred:true},error:false,loading:false},{data:{goals},error:false,loading:true}]){const image=await reportImage({planning});assert.ok(image.drawn.includes('Goal observations unavailable'));assert.doesNotMatch(image.drawn.join('\n'),/Current goal:/);}
});
test('Arabic report images use RTL drawing and translated public labels',async()=>{
  const image=await reportImage({locale:'ar'});assert.equal(image.context.direction,'rtl');assert.equal(image.context.textAlign,'right');assert.ok(image.drawn.includes('بطاقة تقرير النادي'));assert.ok(image.downloads[0].download.startsWith('club-report-ar-'));assert.ok(image.positions.filter(r=>r.text==='Test club').every(r=>r.x===1136));
});
