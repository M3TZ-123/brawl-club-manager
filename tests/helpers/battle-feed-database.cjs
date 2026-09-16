const assert = require("node:assert/strict");
const { loadTypeScript } = require("./load-typescript.cjs");
const { normalizeBattleMode, describeBattleContext } = loadTypeScript("src/lib/battle-catalog.ts");

// An in-memory transport fixture for route tests. The SQL implementation and
// its limits/permissions are independently exercised against real PostgreSQL.
function battleFeedRpc(rows, calls = []) {
  return async (name, args) => {
    assert.ok(["battle_feed_page", "battle_feed_facets"].includes(name), `Unexpected RPC ${name}`);
    calls.push({ name, args });
    const mode = row => normalizeBattleMode(row.event_mode || row.battle_mode || row.mode, row.event_mode_id);
    const context = row => describeBattleContext(row).key;
    const scoped = rows.filter(row => args.p_player_tags.includes(row.player_tag)
      && (!args.p_player || row.player_tag === args.p_player)
      && row.battle_time >= args.p_since && row.battle_time <= args.p_until);
    const filtered = scoped.filter(row => (!args.p_mode || mode(row) === normalizeBattleMode(args.p_mode))
      && (!args.p_context || context(row) === args.p_context));
    if (name === "battle_feed_facets") {
      const counts = (getKey, input = scoped) => [...input.reduce((result, row) => result.set(getKey(row), (result.get(getKey(row)) || 0) + 1), new Map())]
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => ({ key, count }));
      return { data: { modes: counts(mode), contexts: counts(context, scoped.filter(row => !args.p_mode || mode(row) === normalizeBattleMode(args.p_mode))), total: filtered.length, observationCount: scoped.length }, error: null };
    }
    assert.ok(args.p_limit > 0 && args.p_limit <= 200);
    return { data: filtered.filter(row => !args.p_at || row.battle_time === args.p_at)
      .sort((a, b) => b.battle_time.localeCompare(a.battle_time) || a.player_tag.localeCompare(b.player_tag))
      .slice(args.p_offset, args.p_offset + args.p_limit).map(row => ({ ...row, mode: mode(row) })), error: null };
  };
}
module.exports = { battleFeedRpc };
