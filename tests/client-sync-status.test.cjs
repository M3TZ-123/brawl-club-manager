const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const timestamp = "2026-09-16T00:02:54.119Z";
const status = lastSuccessAt => ({lastSuccessAt,lastAttemptAt:timestamp,lastOutcome:"succeeded",expectedIntervalMinutes:30,freshness:"fresh",running:false});
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise,resolve}; }
function target() { const events = new Map(); return {events,addEventListener(type,listener) {if (!events.has(type)) events.set(type,new Set()); events.get(type).add(listener);},removeEventListener(type,listener) {events.get(type)?.delete(listener);},dispatchEvent(event) {for (const listener of [...(events.get(event.type)||[])]) listener(event);}}; }
function fixture(initial = "2026-09-15T23:40:07.824Z") {
  const window = target(), document = {...target(),visibilityState:"visible"}, timers = new Map(), requests = [], writes = [], emitted = [];
  let response = status(timestamp), nextTimer = 0;
  const state = {lastSyncTime:initial,setLastSyncTime(value) {state.lastSyncTime = value;}};
  window.setInterval = (callback,ms) => {assert.equal(ms,60000);timers.set(++nextTimer,callback);return nextTimer;};
  window.clearInterval = id => timers.delete(id);
  window.localStorage = {setItem: (key,value) => writes.push({key,value})};
  window.addEventListener("club-data-updated",event => emitted.push(event.detail));
  const syncStatusModule = loadTypeScript("src/lib/client-sync-status.ts", {
    "@/lib/store": {useAppStore:{getState:()=>state}},
    "@/lib/client-data-cache": {invalidateJsonCache() {},fetchJsonCached: async (url,options) => {requests.push({url,options}); if(response instanceof Error) throw response; return response;}},
  }, {window,document,CustomEvent:class {constructor(type,options={}) {this.type=type;this.detail=options.detail;}}});
  return {module:syncStatusModule,state,window,document,timers,requests,writes,emitted,setResponse(value) {response=value;}};
}

test("sidebar and health consumers share one poll and replace even a newer persisted timestamp with the server value", async () => {
  const f=fixture("2026-09-16T01:51:37.000Z");
  let notifications=0;
  const stops=[1,2,3].map(()=>f.module.subscribeSyncHealth(()=>notifications++));
  assert.equal(f.timers.size,1);
  await settle();
  assert.equal(f.requests.length,1);
  assert.equal(f.state.lastSyncTime,timestamp);
  assert.equal(f.module.getSyncHealth().lastSuccessAt,timestamp);
  assert.equal(notifications,3);
  assert.equal(f.emitted.length,1);
  assert.equal(f.emitted[0].source,"sync-status");
  assert.equal(f.writes[0].value,timestamp);
  f.timers.values().next().value(); await settle();
  assert.equal(f.requests.length,2);
  assert.equal(f.emitted.length,1,"An unchanged marker must not cause page reload loops");
  stops[0]();stops[1]();assert.equal(f.timers.size,1);stops[2]();assert.equal(f.timers.size,0);
  f.window.dispatchEvent({type:"focus"});await settle();assert.equal(f.requests.length,2);
});

test("focus and tab visibility refresh current server status without duplicating requests",async()=>{
  const f=fixture();const stop=f.module.subscribeSyncHealth(()=>{});await settle();
  f.document.visibilityState="hidden";f.timers.values().next().value();f.window.dispatchEvent({type:"focus"});await settle();assert.equal(f.requests.length,1);
  f.document.visibilityState="visible";
  const pending=deferred();f.setResponse(pending.promise);
  f.window.dispatchEvent({type:"focus"});f.document.dispatchEvent({type:"visibilitychange"});
  assert.equal(f.requests.length,2);
  pending.resolve(status("2026-09-16T00:10:00Z"));await settle();
  assert.equal(f.state.lastSyncTime,"2026-09-16T00:10:00.000Z");stop();
});

test("another tab's storage message is only a hint and cannot supply the displayed timestamp",async()=>{
  const f=fixture();const stop=f.module.subscribeSyncHealth(()=>{});await settle();
  f.setResponse(status("2026-09-16T00:15:00Z"));
  f.window.dispatchEvent({type:"storage",key:"brawl-club-manager-sync-updated",newValue:"2099-01-01T00:00:00Z"});await settle();
  assert.equal(f.requests.length,2);
  assert.equal(f.state.lastSyncTime,"2026-09-16T00:15:00.000Z");
  f.window.dispatchEvent({type:"storage",key:"unrelated"});await settle();assert.equal(f.requests.length,2);stop();
});

test("a successful sync during an old status request queues one read and cannot roll the timestamp back",async()=>{
  const f=fixture();const pending=deferred();f.setResponse(pending.promise);const stop=f.module.subscribeSyncHealth(()=>{});
  f.state.setLastSyncTime(timestamp);
  f.window.dispatchEvent({type:"club-data-updated",detail:{syncTime:timestamp}});
  f.setResponse(status(timestamp));pending.resolve(status("2026-09-15T23:40:07.824Z"));await settle();
  assert.equal(f.requests.length,2);
  assert.equal(f.state.lastSyncTime,timestamp);
  assert.equal(f.module.getSyncHealth().lastSuccessAt,timestamp);stop();
});

test("failed reads preserve the last known success; an authoritative reset clears it",async()=>{
  const f=fixture();const stop=f.module.subscribeSyncHealth(()=>{});await settle();
  f.setResponse(new Error("Offline"));await f.module.refreshSyncHealth();
  assert.equal(f.module.getSyncHealth(),null);assert.equal(f.state.lastSyncTime,timestamp);
  f.setResponse({...status(null),freshness:"never"});await f.module.refreshSyncHealth();
  assert.equal(f.state.lastSyncTime,null);assert.equal(f.module.getSyncHealth().lastSuccessAt,null);stop();
});

test("persisted timestamps are neither saved nor restored, while locale and theme preferences survive",()=>{
  let options;
  const {useAppStore}=loadTypeScript("src/lib/store.ts",{"zustand/middleware":{persist:(initializer,configuration)=>{options=configuration;return initializer;}}});
  const state=useAppStore.getState();
  assert.equal(Object.hasOwn(options.partialize({...state,lastSyncTime:timestamp}),"lastSyncTime"),false);
  const restored=options.merge({lastSyncTime:"2099-01-01T00:00:00Z",locale:"ar",theme:"light"},state);
  assert.equal(restored.lastSyncTime,null);assert.equal(restored.locale,"ar");assert.equal(restored.theme,"light");
});

test("an old settings response cannot overwrite a newer server status accepted while it was in flight",async()=>{
  const pending=deferred();
  const {useAppStore}=loadTypeScript("src/lib/store.ts",{"zustand/middleware":{persist:initializer=>initializer}},{fetch:()=>pending.promise});
  const load=useAppStore.getState().loadSettingsFromDB();
  useAppStore.getState().setLastSyncTime(timestamp);
  pending.resolve(Response.json({club_tag:"#A",api_key_configured:"true",last_sync_time:"2026-09-15T23:40:07.824Z"}));
  await load;assert.equal(useAppStore.getState().lastSyncTime,timestamp);
});
