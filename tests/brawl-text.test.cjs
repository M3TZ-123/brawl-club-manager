const test=require('node:test');const assert=require('node:assert/strict');
const {loadTypeScript}=require('./helpers/load-typescript.cjs');
const {hookRenderer,componentMocks,elements,textContent}=require('./helpers/client-renderer.cjs');
const {stripBrawlColorTags}=loadTypeScript('src/lib/brawl-text.ts');
const raw='WELCOME ✨ | <c00ffff>BE ACTIVE⚡CHAT 💬 & PLAY 🐖 OR 🚪</c>| <cff0000>3+ DAYS OFFLINE = 👋</c>| BE RESPECTFUL & ENJOY ! 🎉</c>';
const expected='WELCOME ✨ | BE ACTIVE⚡CHAT 💬 & PLAY 🐖 OR 🚪| 3+ DAYS OFFLINE = 👋| BE RESPECTFUL & ENJOY ! 🎉';
test('removes only recognized Brawl color tags, including the observed production description',()=>{
  assert.equal(stripBrawlColorTags(raw),expected);
  assert.equal(stripBrawlColorTags('<c1>مرحبًا 👋</c>\n<c12>أهلًا</c> <Cff00FF88>✨</C>'),'مرحبًا 👋\nأهلًا ✨');
  const arbitrary='<b>bold</b> <script>alert(1)</script> <img src=x> <c123>unknown</c123> <c1234567>seven</c1234567> <cnope>text</cnope> &lt;c1&gt;';
  assert.equal(stripBrawlColorTags(arbitrary),arbitrary);
  assert.equal(stripBrawlColorTags('plain العربية 🎉\ntext'),'plain العربية 🎉\ntext');
});
test('club identity and description history use plain cleaned text without changing raw observations',async()=>{
  const renderer=hookRenderer();const snapshot={club:{tag:'#PYLQ',metadata:{name:'Club',description:raw,type:'open',requiredTrophies:0},memberCount:30,openSeats:0,leaders:[],observedAt:'2026-09-16T00:00:00Z'},metadataHistory:[{id:'1',observedAt:'2026-09-16T00:00:00Z',before:{description:'<c1>قديم</c>'},after:{description:'<c00ff00>جديد</c> <b>نص</b>'},changedFields:['description']}]};
  const initial=JSON.stringify(snapshot);const {ClubIdentity}=loadTypeScript('src/components/club-identity.tsx',{...componentMocks,react:renderer.react,'@/components/club-intelligence-panel':{ClubIntelligencePanel:'Panel',useClubIntelligence:()=>({data:snapshot})}});
  const tree=await renderer.render(()=>ClubIdentity({showHistory:true}));const text=textContent(tree);assert.ok(text.includes(expected));assert.ok(text.includes('قديم → جديد <b>نص</b>'));assert.doesNotMatch(text,/<c00ffff>|<c1>|<\/c>/);assert.equal(JSON.stringify(snapshot),initial);assert.equal(elements(tree).some(e=>e.type==='b'||e.props?.dangerouslySetInnerHTML),false);
});
test('rival descriptions use the same cleaner and preserve literal HTML as text',async()=>{
  const renderer=hookRenderer(),description='<c1>منافس ✨</c> <img src=x>';const rival={tag:'#PYY',profile:{name:'Rival',description},history:[],stale:false};
  const Page=loadTypeScript('src/app/rivals/page.tsx',{...componentMocks,react:renderer.react,'@/components/club-trend-line':{ClubTrendLine:'Trend'},'@/hooks/use-admin-session':{useAdminSession:()=>({isAdmin:false})},'@/components/use-feature-resource':{useFeatureResource:url=>({data:url.startsWith('/api/club-rivals')?{clubTag:'#PYLQ',rivals:[rival],ranks:[]}:null,error:false,loading:false})}}).default;
  const tree=await renderer.render(Page);assert.ok(textContent(tree).includes('منافس ✨ <img src=x>'));assert.equal(rival.profile.description,description);assert.equal(elements(tree).some(e=>e.type==='img'||e.props?.dangerouslySetInnerHTML),false);
});
