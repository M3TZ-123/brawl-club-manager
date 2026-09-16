const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { readOnlyDatabase } = require("./helpers/read-only-database.cjs");

const timestamp = "2026-09-16T12:00:00.000Z";
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [timestamp])); } static now() { return Date.parse(timestamp); } }
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const ids = page => page.notifications.map(row => row.id);
function load(notifications) {
  return loadTypeScript("src/app/api/notifications/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/supabase-admin": { supabaseAdmin: readOnlyDatabase({ notifications }) },
  }, { Date: FixedDate });
}
async function page(route, values = {}) {
  const params = new URLSearchParams({ limit: "2", ...values });
  const response = await route.GET(new Request(`http://fixture/api/notifications?${params}`));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}

test("unread cursor paging cannot skip rows when another tab marks an earlier row read", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: 5 - index, type: "join", is_read: false,
    created_at: new Date(Date.parse(timestamp) - index * 60_000).toISOString() }));
  const route = load(rows), first = await page(route, { unreadOnly: "true", range: "7d" });
  assert.deepEqual(ids(first), [5, 4]); assert.equal(first.nextOffset, 2);
  rows[0].is_read = true;
  rows.push({ id: 6, type: "join", is_read: false, created_at: timestamp });
  const second = await page(route, { unreadOnly: "true", range: "7d", cursor: first.nextCursor, offset: "2" });
  assert.deepEqual(ids(second), [3, 2]); assert.equal(second.nextOffset, null); assert.equal(second.unreadCount, 5);
  const last = await page(route, { unreadOnly: "true", range: "7d", cursor: second.nextCursor });
  assert.deepEqual(ids(last), [1]); assert.equal(last.nextCursor, null);
  assert.deepEqual([...ids(first), ...ids(second), ...ids(last)], [5, 4, 3, 2, 1]);
});

test("all-notification cursors retain exact microseconds and descending ID ties despite new rows or deletion", async () => {
  const at = "2026-09-16T11:00:00.123456+00:00";
  const rows = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, is_read: index % 2 === 0, created_at: at }));
  const route = load(rows), first = await page(route);
  assert.deepEqual(ids(first), [7, 6]);
  assert.deepEqual(JSON.parse(Buffer.from(first.nextCursor, "base64url").toString()), { at, id: 6 });
  rows.splice(rows.findIndex(row => row.id === 7), 1);
  rows.push({ id: 8, created_at: at, is_read: false });
  const collected = ids(first); let cursor = first.nextCursor;
  while (cursor) { const next = await page(route, { cursor }); collected.push(...ids(next)); cursor = next.nextCursor; }
  assert.deepEqual(collected, [7, 6, 5, 4, 3, 2, 1]);
});

test("legacy undated notifications remain traversable before dated records", async () => {
  const rows = [1, 2, 3].map(id => ({ id, created_at: null }));
  rows.push({ id: 99, created_at: timestamp }, { id: 98, created_at: "2026-09-16T11:00:00Z" });
  const route = load(rows), first = await page(route);
  assert.deepEqual(ids(first), [3, 2]);
  assert.deepEqual(JSON.parse(Buffer.from(first.nextCursor, "base64url").toString()), { at: null, id: 2 });
  const second = await page(route, { cursor: first.nextCursor }); assert.deepEqual(ids(second), [1, 99]);
  const last = await page(route, { cursor: second.nextCursor }); assert.deepEqual(ids(last), [98]); assert.equal(last.nextCursor, null);
});

test("cursor pagination combines range, type and unread filters while keeping legacy offsets valid", async () => {
  const rows = Array.from({ length: 105 }, (_, index) => ({ id: index + 1, type: "promotion", is_read: false, created_at: timestamp }));
  rows.push({ id: 200, type: "join", is_read: false, created_at: timestamp },
    { id: 201, type: "promotion", is_read: true, created_at: timestamp },
    { id: 202, type: "promotion", is_read: false, created_at: "2025-01-01T00:00:00Z" },
    { id: 203, type: "promotion", is_read: false, created_at: "2027-01-01T00:00:00Z" });
  const route = load(rows), filters = { limit: "100", types: "promotion,demotion", unreadOnly: "true", range: "7d" };
  const first = await page(route, filters); assert.equal(first.notifications.length, 100); assert.equal(first.unreadCount, 108);
  const cursorPage = await page(route, { ...filters, cursor: first.nextCursor });
  const offsetPage = await page(route, { ...filters, offset: String(first.nextOffset) });
  assert.deepEqual(ids(cursorPage), [5, 4, 3, 2, 1]); assert.deepEqual(ids(cursorPage), ids(offsetPage));
  assert.equal(cursorPage.nextCursor, null); assert.equal(offsetPage.nextOffset, null);
});

test("malformed cursors are rejected before any database query and cannot inject a filter", async () => {
  const route = loadTypeScript("src/app/api/notifications/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/supabase-admin": { supabaseAdmin: { from() { assert.fail("Invalid cursor must not query the database"); } } },
  }, { Date: FixedDate });
  const valid = { at: timestamp, id: 1 };
  for (const cursor of ["", "***", "A".repeat(513), Buffer.from("{").toString("base64url"),
    ...[null, [], {}, { id: 1 }, { ...valid, id: "1" }, { ...valid, id: 0 }, { ...valid, id: 1.5 },
      { ...valid, id: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, id: 2_147_483_648 }, { ...valid, at: "not a date" },
      { ...valid, at: "2026-02-30T12:00:00Z" }, { ...valid, at: "0000-01-01T00:00:00Z" },
      { ...valid, at: "2026-09-16T12:00:00+16:00" },
      { ...valid, at: timestamp + ",id.gt.0" }].map(encode)]) {
    const response = await route.GET(new Request(`http://fixture/api/notifications?cursor=${encodeURIComponent(cursor)}`));
    assert.equal(response.status, 400, cursor); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Invalid notification cursor" });
  }
});
