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

test("failed images have a labeled stable-size fallback and a new URL is tried again",async()=>{
 const renderer=hookRenderer(); const {BrawlImage}=loadTypeScript("src/components/brawl-image.tsx",{react:renderer.react,"next/image":"Image"});
 let src="https://cdn.example/missing.png"; const render=()=>renderer.render(()=>BrawlImage({src,alt:"New brawler",width:32,height:32}));
 let tree=await render(); assert.equal(tree.type,"Image"); tree.props.onError(); tree=await render();
 assert.equal(tree.type,"span"); assert.equal(tree.props.role,"img"); assert.equal(tree.props["aria-label"],"New brawler");
 assert.equal(tree.props.style.width,32); assert.equal(textContent(tree),"N");
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
