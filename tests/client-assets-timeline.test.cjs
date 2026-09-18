const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, action } = require("./helpers/client-renderer.cjs");
function target() { const listeners=new Map(); return {addEventListener(type,callback){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(callback);},removeEventListener(type,callback){listeners.get(type)?.delete(callback);},dispatchEvent(event){for(const callback of [...listeners.get(event.type)||[]])callback(event);}}; }
const event = (id,name) => ({id,eventType:"role_change",occurredAt:"2026-09-16T00:00:00Z",source:"recorded",before:null,after:{player_name:name,role:"member"}});

test("bundled brawler IDs resolve names without an HTTP catalog and preserve explicit overrides",()=>{
 const {getBrawlerIconFromMap}=loadTypeScript("src/lib/brawl-assets.ts");
 assert.equal(getBrawlerIconFromMap("SHELLY",{}),"https://cdn.brawlify.com/brawlers/borderless/16000000.png");
 assert.equal(getBrawlerIconFromMap("8-bit",{}),"https://cdn.brawlify.com/brawlers/borderless/16000027.png");
 assert.equal(getBrawlerIconFromMap("SHELLY",{SHELLY:"https://example.test/custom.png"}),"https://example.test/custom.png");
 assert.equal(getBrawlerIconFromMap("Future unknown brawler",{}),null);
});

test("verified Cosmo portraits use its catalog-linked avatar while ordinary styles and explicit overrides stay intact",()=>{
 const {getBrawlerPortraitUrl,getBrawlerIconFromMap}=loadTypeScript("src/lib/brawl-assets.ts");
 const cosmo="https://cdn.brawlify.com/profile-icons/regular/28001337.png";
 assert.equal(getBrawlerPortraitUrl(16000109),cosmo);assert.equal(getBrawlerPortraitUrl(16000109,"borders"),cosmo);
 assert.equal(getBrawlerIconFromMap("COSMO",{}),cosmo);
 assert.equal(getBrawlerIconFromMap("COSMO",{COSMO:"https://example.test/custom.png"}),"https://example.test/custom.png");
 assert.equal(getBrawlerIconFromMap("Cosmo",{cosmo:"https://example.test/normalized.png"}),"https://example.test/normalized.png");
 assert.equal(getBrawlerPortraitUrl(16000000),"https://cdn.brawlify.com/brawlers/borderless/16000000.png");
 assert.equal(getBrawlerPortraitUrl(16000000,"borders"),"https://cdn.brawlify.com/brawlers/borders/16000000.png");
 for(const id of [null,undefined,0,-1,1.5,NaN,Infinity,28001337])assert.equal(getBrawlerPortraitUrl(id),null);
});

test("map statistics apply the verified portrait without another upstream catalog request",()=>{
 const {normalizeMapStatistics,mapBandBrawlers}=loadTypeScript("src/lib/map-statistics.ts");
 const result=normalizeMapStatistics({data:[{id:15000007,name:"Hard Rock Mine",gameMode:{scId:48000000,scHash:"gemGrab"},totalMatches:1000,winRateHigh:[{brawlerId:16000109,brawlerName:"Cosmo",winRate:60}]}]},Date.parse("2026-09-18T13:00:00Z"));
 const [brawler]=mapBandBrawlers(result.maps[0],"high");
 assert.equal(brawler.id,16000109);assert.equal(brawler.imageUrl,"https://cdn.brawlify.com/profile-icons/regular/28001337.png");
 assert.equal(brawler.sampleSize,null);assert.equal(brawler.winRate,60);
});

test("missing portrait IDs show an SVG without making an empty image request",async()=>{
 const renderer=hookRenderer();const {BrawlImage}=loadTypeScript("src/components/brawl-image.tsx",{react:renderer.react,"next/image":"Image","lucide-react":{ImageOff:"ImageOff"}});
 const tree=await renderer.render(()=>BrawlImage({src:null,alt:"",width:48,height:48}));
 assert.equal(tree.type,"span");assert.equal(tree.props["aria-hidden"],true);assert.equal(elements(tree).some(node=>node.type==="Image"),false);
 assert.equal(elements(tree).some(node=>node.type==="ImageOff"),true);
});

test("failed images have a labeled stable-size fallback and a new URL is tried again",async()=>{
 const renderer=hookRenderer(); const {BrawlImage}=loadTypeScript("src/components/brawl-image.tsx",{react:renderer.react,"next/image":"Image","lucide-react":{ImageOff:"ImageOff"}});
 let src="https://cdn.example/missing.png"; const render=()=>renderer.render(()=>BrawlImage({src,alt:"New brawler",width:32,height:32}));
 let tree=await render(); assert.equal(tree.type,"Image"); tree.props.onError(); tree=await render();
 assert.equal(tree.type,"span"); assert.equal(tree.props.role,"img"); assert.equal(tree.props["aria-label"],"New brawler");
 assert.equal(tree.props.style.width,32); assert.equal(tree.props.style.height,32); assert.equal(textContent(tree),"");
 assert.equal(elements(tree).find(node=>node.type==="ImageOff").props["aria-hidden"],"true");
 src="https://cdn.example/available.png"; tree=await render(); assert.equal(tree.type,"Image"); assert.equal(tree.props.src,src);
});

test("timeline ignores an old player's response and refreshes only relevant visible data",async()=>{
 const renderer=hookRenderer(), window=target(), document={...target(),visibilityState:"visible"}, requests=[];
 const {MembershipTimeline}=loadTypeScript("src/components/membership-timeline.tsx",{...componentMocks,react:renderer.react,
  "@/lib/client-data-cache":{fetchJsonCached:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))},
 },{window,document});
 let tag="#OLD"; const render=()=>renderer.render(()=>MembershipTimeline({playerTag:tag}));
 await render(); tag="#NEW"; await render(); assert.equal(requests.length,2);
 requests[1].resolve({events:[event("new","Current player")],nextCursor:"opaque"}); let tree=await render();
 requests[0].resolve({events:[event("old","Wrong player")],nextCursor:null}); tree=await render();
 assert.match(textContent(tree),/Current player/); assert.doesNotMatch(textContent(tree),/Wrong player/);
 window.dispatchEvent({type:"club-data-updated",detail:{datasets:["ranked","battles"]}}); await render(); assert.equal(requests.length,2);
 document.visibilityState="hidden"; window.dispatchEvent({type:"club-data-updated",detail:{datasets:["roster"]}}); await render(); assert.equal(requests.length,2);
 document.visibilityState="visible"; document.dispatchEvent({type:"visibilitychange"}); assert.equal(requests.length,3);
 assert.equal(requests[2].options.force,true); assert.equal(new URL(requests[2].url,"http://fixture").searchParams.has("cursor"),false);
 requests[2].resolve({events:[event("latest","Updated player")],nextCursor:"next"}); tree=await render();
 assert.match(textContent(tree),/Updated player/); assert.doesNotMatch(textContent(tree),/Current player/);
 const more=action(tree,"Load More")(); requests[3].resolve({events:[event("latest","Updated player"),event("older","Older event")],nextCursor:null}); await more;
 tree=await render(); assert.equal(elements(tree).filter(element=>element.type==="article").length,2,"Overlapping pages do not duplicate timeline events");
});
