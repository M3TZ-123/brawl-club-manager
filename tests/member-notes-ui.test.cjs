const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { hookRenderer, componentMocks, elements, textContent, action } = require("./helpers/client-renderer.cjs");
const find = (tree, type) => { const found = elements(tree).find(node => node.type === type); assert.ok(found, `Missing ${type}`); return found; };
const initial = { player_tag: "#OLD", status: "pending", notes: "Earlier reason", follow_up_at: null, updated_at: "2026-09-16T09:10:11.123456+00:00" };
function harness({ review = initial, read, patch, activityStatus } = {}) {
  const renderer = hookRenderer(), requests = [], events = [];
  let open = true;
  const loaded = loadTypeScript("src/components/member-review.tsx", {
    ...componentMocks, react: renderer.react,
    "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: true }) },
    "@/lib/client-data-cache": { invalidateJsonCache() {} },
  }, {
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      if (options.method === "PATCH") return patch ? patch(JSON.parse(options.body), options) : Response.json({ review: { ...review, ...JSON.parse(options.body), updated_at: "2026-09-16T10:00:00.654321+00:00" } });
      if (url.startsWith("/api/member-reviews?")) return read ? read() : Response.json({ review });
      return Response.json({ error: "Former profile unavailable" }, { status: 404 });
    },
    window: { dispatchEvent: event => events.push(event.type) }, CustomEvent: class { constructor(type) { this.type = type; } },
  });
  const member = { player_tag: "#OLD", player_name: "Former member", activity_status: activityStatus, is_current_member: false, first_seen: "2025-01-01", times_joined: 2, times_left: 2, last_left_at: "2026-09-01" };
  return { requests, events, close: () => { open = false; }, render: () => renderer.render(() => loaded.MemberReviewSheet({ member, open, onOpenChange() {} })) };
}

test("former-member notes remain editable without a live profile and save the exact revision", async () => {
  const page = harness({ activityStatus: "minimal" }); let tree = await page.render();
  assert.equal(find(tree, "textarea").props.value, "Earlier reason");
  assert.match(textContent(tree), /Observed joins: 2 · Observed departures: 2/);
  assert.match(textContent(tree), /Last recorded departure/);
  assert.match(textContent(tree), /Departure reasons are entered manually/);
  assert.match(textContent(tree), /Recent activity: Low activity/);
  assert.deepEqual(elements(find(tree, "select")).filter(node => node.type === "option").map(node => [node.props.value, textContent(node)]), [["pending", "Pending"], ["reviewed", "Reviewed"], ["follow_up", "Follow up"]]);
  find(tree, "textarea").props.onChange({ target: { value: "Left to join friends" } }); tree = await page.render();
  await action(tree, "Save review")(); tree = await page.render();
  const sent = JSON.parse(page.requests.find(request => request.method === "PATCH").body);
  assert.equal(sent.expected_updated_at, initial.updated_at);
  assert.equal(sent.notes, "Left to join friends");
  assert.equal(sent.status, "pending");
  assert.match(textContent(tree), /Review saved/);
  find(tree, "textarea").props.onChange({ target: { value: "A second draft" } }); tree = await page.render();
  assert.doesNotMatch(textContent(tree), /Review saved/);
  await action(tree, "Save review")();
  assert.equal(JSON.parse(page.requests.at(-1).body).expected_updated_at, "2026-09-16T10:00:00.654321+00:00");
});

test("a conflict preserves the draft and requires an explicit saved-version or draft decision", async () => {
  for (const choice of ["Keep my draft", "Use saved version"]) {
    let reads = 0, saves = 0;
    const latest = { ...initial, notes: "Saved by another admin", status: "reviewed", updated_at: "2026-09-16T10:00:00.987654+00:00" };
    const page = harness({ read: () => Response.json({ review: reads++ ? latest : initial }), patch: body => ++saves === 1
      ? Response.json({ error: "Review changed. Reload before saving." }, { status: 409 })
      : Response.json({ review: { ...latest, ...body } }) });
    let tree = await page.render();
    find(tree, "textarea").props.onChange({ target: { value: "My departure reason" } }); tree = await page.render();
    await action(tree, "Save review")(); tree = await page.render();
    assert.equal(find(tree, "textarea").props.value, "My departure reason");
    assert.match(textContent(tree), /Saved by another admin/);
    assert.equal(elements(tree).find(node => node.type === "Button" && textContent(node) === "Save review").props.disabled, true);
    await action(tree, "Save review")(); assert.equal(saves, 1);
    action(tree, choice)(); tree = await page.render();
    const expected = choice === "Keep my draft" ? "My departure reason" : latest.notes;
    assert.equal(find(tree, "textarea").props.value, expected);
    await action(tree, "Save review")();
    const sent = JSON.parse(page.requests.at(-1).body);
    assert.equal(sent.notes, expected); assert.equal(sent.expected_updated_at, latest.updated_at);
  }
});

test("saving prevents duplicate submissions and late completion after closing has no side effects", async () => {
  let finish;
  const page = harness({ patch: () => new Promise(resolve => { finish = resolve; }) });
  let tree = await page.render(); const save = action(tree, "Save review");
  const pending = save(); await save(); tree = await page.render();
  assert.equal(page.requests.filter(request => request.method === "PATCH").length, 1);
  assert.equal(find(tree, "textarea").props.disabled, true);
  assert.equal(find(tree, "select").props.disabled, true);
  page.close(); await page.render();
  assert.equal(page.requests.find(request => request.method === "PATCH").signal.aborted, true);
  finish(Response.json({ review: initial })); await pending;
  assert.equal(page.events.length, 0);
});

test("a malformed private read never opens an empty notes editor", async () => {
  const page = harness({ read: () => Response.json({ success: true }) });
  const tree = await page.render();
  assert.match(textContent(tree), /Review unavailable/);
  assert.equal(elements(tree).some(node => node.type === "textarea"), false);
});

test("public notes entry point links to admin sign-in without reading private notes", async () => {
  const renderer = hookRenderer();
  const { MemberReviewButton } = loadTypeScript("src/components/member-review.tsx", { ...componentMocks, react: renderer.react,
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: false }) } });
  const tree = await renderer.render(() => MemberReviewButton({ member: { player_tag: "#OLD", player_name: "Former member" } }));
  assert.equal(find(tree, "Link").props.href, "/reviews?member=%23OLD");
  assert.equal(textContent(tree), "Member notes");
  assert.equal(elements(tree).some(node => node.type?.name === "MemberReviewSheet"), false);
});
