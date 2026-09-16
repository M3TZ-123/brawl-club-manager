const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, action } = require("./helpers/client-renderer.cjs");

const candidate = (values = {}) => ({ player_tag: "#PYLQ", version: 1, status: "watching", notes: "Saved note", profile: null, profile_checked_at: null, ...values });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function rendererWithUnmount() {
  const base = hookRenderer(), cleanups = new Set();
  return { ...base, react: { ...base.react, useEffect(callback, dependencies) {
    base.react.useEffect(() => { const cleanup = callback(); if (cleanup) cleanups.add(cleanup); return () => { cleanups.delete(cleanup); cleanup?.(); }; }, dependencies);
  } }, unmount() { for (const cleanup of cleanups) cleanup(); cleanups.clear(); } };
}
function harness(response) {
  const main = rendererWithUnmount(), requests = [];
  let active = main;
  const react = new Proxy({}, { get: (_, key) => (...args) => active.react[key](...args) });
  const Page = loadTypeScript("src/app/recruitment/page.tsx", {
    ...componentMocks, react,
    "@/lib/client-fetch": { fetchJsonWithTimeout: async (url, options = {}) => {
      const request = { url, method: options.method || "GET", signal: options.signal, body: options.body && JSON.parse(options.body) };
      requests.push(request); return response(request, requests);
    } },
  }).default;
  const workspace = elements(Page()).find(node => node.type?.name === "RecruitmentWorkspace").type;
  return {
    requests, unmount: () => main.unmount(),
    render() { active = main; return main.render(workspace); },
    mountCard(element) {
      const child = rendererWithUnmount(); let props = element.props;
      return { unmount: () => child.unmount(), setProps(next) { props = next; }, render() { active = child; return child.render(() => element.type(props)); } };
    },
  };
}
const card = tree => elements(tree).find(node => node.type?.name === "CandidateCard");
const textarea = tree => elements(tree).find(node => node.type === "textarea");

test("recruitment profile refresh preserves unsaved notes/status and uses a stable card key", async () => {
  const page = harness(request => request.method === "GET" ? { candidates: [candidate()] } : { candidate: candidate({ version: 2, profile_checked_at: "2026-09-16T12:00:00Z" }) });
  const initial = await page.render(), initialCard = card(initial), editor = page.mountCard(initialCard);
  let tree = await editor.render();
  textarea(tree).props.onChange({ target: { value: "Unsaved private draft" } }); tree = await editor.render();
  elements(tree).find(node => node.type === "select").props.onChange({ target: { value: "shortlisted" } }); tree = await editor.render();
  action(tree, "Load profile")(); tree = await editor.render();
  const updated = await page.render(); assert.equal(card(updated).key, initialCard.key);
  editor.setProps(card(updated).props); tree = await editor.render();
  assert.equal(textarea(tree).props.value, "Unsaved private draft");
  assert.equal(elements(tree).find(node => node.type === "select").props.value, "shortlisted");
  action(tree, "Save")(); await editor.render();
  const save = page.requests.find(request => request.method === "PATCH");
  assert.equal(save.body.version, 2); assert.equal(save.body.notes, "Unsaved private draft"); assert.equal(save.body.status, "shortlisted");
});

test("recruitment follows reloaded saved fields when the editor has no draft and locks edits during a save", async () => {
  const pending = deferred();
  const page = harness(request => request.method === "GET" ? { candidates: [candidate()] } : pending.promise);
  const workspace = await page.render(), editor = page.mountCard(card(workspace));
  let tree = await editor.render();
  editor.setProps({ ...card(workspace).props, candidate: candidate({ version: 2, notes: "New server note", status: "contacted" }) });
  tree = await editor.render(); assert.equal(textarea(tree).props.value, "New server note");
  assert.equal(elements(tree).find(node => node.type === "select").props.value, "contacted");
  textarea(tree).props.onChange({ target: { value: "My edit" } }); tree = await editor.render();
  const save = action(tree, "Save"); save(); save(); tree = await editor.render();
  assert.equal(page.requests.filter(request => request.method === "PATCH").length, 1);
  assert.equal(textarea(tree).props.disabled, true); assert.equal(elements(tree).find(node => node.type === "select").props.disabled, true);
  pending.resolve({ candidate: candidate({ version: 3, notes: "My edit", status: "contacted" }) }); await editor.render();
});

test("an older recruitment reload cannot remove a newly added candidate", async () => {
  const oldReload = deferred(); let reads = 0;
  const page = harness(request => request.method === "GET" ? (++reads === 1 ? { candidates: [candidate()] } : oldReload.promise) : { candidate: candidate({ player_tag: "#QQQQ", notes: "", version: 1 }) });
  let tree = await page.render(); action(tree, "Reload list")(); tree = await page.render();
  elements(tree).find(node => node.type === "Input" && node.props.placeholder === "#...").props.onChange({ target: { value: "#QQQQ" } }); tree = await page.render();
  await elements(tree).find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); tree = await page.render();
  assert.equal(elements(tree).filter(node => node.type?.name === "CandidateCard").length, 2);
  oldReload.resolve({ candidates: [candidate()] }); tree = await page.render();
  assert.equal(elements(tree).filter(node => node.type?.name === "CandidateCard").length, 2);
  assert.match(textContent(tree), /2 candidates/);
});

test("leaving the private workspace aborts reads/writes and late responses cannot update its parent", async () => {
  const pending = deferred(), changes = [], errors = [];
  const page = harness(request => request.method === "GET" ? { candidates: [candidate()] } : pending.promise);
  const workspace = await page.render(), original = card(workspace);
  const editor = page.mountCard({ ...original, props: { ...original.props, onChange: value => changes.push(value), onError: value => errors.push(value) } });
  const tree = await editor.render(); action(tree, "Load profile")(); await editor.render();
  editor.unmount(); page.unmount();
  assert.ok(page.requests.every(request => request.signal.aborted));
  pending.resolve({ candidate: candidate({ version: 2 }) }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(changes.length, 0); assert.deepEqual(errors, [""]);
});

test("a failed initial recruitment read ends loading and leaves a usable retry", async () => {
  const page = harness(() => Promise.reject(new Error("Candidate list unavailable")));
  const tree = await page.render();
  assert.match(textContent(tree), /Candidate list unavailable/);
  assert.equal(elements(tree).filter(node => node.props?.role === "status").length, 0);
  const reload = elements(tree).find(node => node.type === "Button" && textContent(node) === "Reload list");
  assert.equal(reload.props.disabled, false);
  const add = elements(tree).find(node => node.type === "Button" && textContent(node) === "Add candidate");
  assert.equal(add.props.disabled, true);
});

test("switching recruitment views preserves candidate input and mounted private editors", async () => {
  const page=harness(()=>({candidates:[candidate()]}));
  let tree=await page.render();
  const tagInput=value=>elements(value).find(node=>node.type==='Input'&&node.props.placeholder==='#...');
  const applicationList=value=>elements(value).find(node=>node.type?.name==='RecruitmentApplications');
  const originalCard=card(tree);assert.equal(applicationList(tree),undefined);
  tagInput(tree).props.onChange({target:{value:'#UNSAVED'}});tree=await page.render();
  action(tree,'Applications')();tree=await page.render();
  assert.ok(applicationList(tree));assert.equal(card(tree).key,originalCard.key);
  assert.equal(elements(tree).find(node=>node.type==='section'&&elements(node).some(child=>child.type?.name==='CandidateCard')).props.hidden,true);
  action(tree,'Recruitment settings')();tree=await page.render();
  assert.ok(applicationList(tree),'visited application editors remain mounted while hidden');
  action(tree,'Candidates')();tree=await page.render();
  assert.equal(tagInput(tree).props.value,'#UNSAVED');assert.equal(card(tree).key,originalCard.key);
  assert.equal(page.requests.length,1,'view changes do not repeat candidate reads');
});
