const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

module.exports = async function progressPerformanceChecks(db, t) {
  assert.equal((await db.query('SELECT current_database() name')).rows[0].name, 'brawl_progress_tests');
  const root = path.resolve(__dirname, '../../..');
  const definitions = ['202609160020_player_progress.sql', '202609160025_equipment_metadata_preservation.sql', '202609160027_progress_common_path.sql'].map(file => {
    const sql = fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8');
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.sync_apply_player_progress');
    const end = sql.indexOf('\nREVOKE ALL ON FUNCTION', start);
    assert.ok(start >= 0 && end > start); return [file.slice(8, 12), sql.slice(start, end)];
  });
  const members = Array.from({ length: 28 }, (_, i) => ({ player_tag: `#PERF${i}`, player_name: `Fixture${i}`, role: 'member', trophies: 106000,
    highest_trophies: 110000, exp_level: 250, brawlers_count: 106, solo_victories: 1000, duo_victories: 2000, trio_victories: 3000,
    ranked_profile_version: 1, ranked_provenance: {}, profile_progress: { exp_points: 300000, total_prestige_level: 5, fame: 10000, fame_tier_name: 'Global III' } }));
  const equipment = (base, count, gear = false) => Array.from({ length: count }, (_, id) => ({ id: base + id, name: `Fixture equipment ${id}`, ...(gear ? { level: 3 } : {}) }));
  const brawlers = members.flatMap(member => Array.from({ length: 106 }, (_, index) => ({ player_tag: member.player_tag, brawler_id: 16000000 + index,
    brawler_name: `BRAWLER${index}`, power_level: 11, trophies: 1000, rank: 35, gadgets_count: 2, star_powers_count: 2, gears_count: 7,
    progress: { highest_trophies: 1200, prestige_level: 1, current_win_streak: 0, max_win_streak: 15,
      gadgets: equipment(23000000 + index * 10, 2), star_powers: equipment(23002000 + index * 10, 2), gears: equipment(62000000, 7, true),
      hyper_charges: equipment(76000000 + index, 1), skin: { id: 29000000 + index, name: `Fixture skin ${index}` },
      buffies: { gadget: false, starPower: false, hyperCharge: false } } })));
  const body = { members, brawlers, battles: [], battle_logs_complete: true, ranked_complete: false,
    battle_observations: members.map(member => ({ player_tag: member.player_tag, success: true, battle_times: [] })) };
  const results = [];
  const commit = async () => {
    const run = (await db.query("SELECT acquire_sync_run('#CLUB','manual','full',NULL,NULL) x")).rows[0].x;
    assert.equal(run.acquired, true);
    const start = performance.now();
    const result = (await db.query('SELECT commit_sync_snapshot($1,$2,$3) x', [run.run_id, run.fence, body])).rows[0].x;
    assert.equal(result.success, true); assert.equal(result.synced, 28);
    return Math.round(performance.now() - start);
  };
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL statement_timeout='120s'");
    await db.query("UPDATE settings SET value='#CLUB' WHERE key='club_tag'");
    await commit();
    const identities = (await db.query("SELECT player_tag,brawler_id,xmin::text version FROM player_brawler_details WHERE player_tag LIKE '#PERF%' ORDER BY player_tag,brawler_id")).rows;
    assert.equal(identities.length, 2968);
    for (const [version, definition] of definitions) {
      await db.query(definition);
      const elapsed = [await commit(), await commit()];
      assert.deepEqual((await db.query("SELECT player_tag,brawler_id,xmin::text version FROM player_brawler_details WHERE player_tag LIKE '#PERF%' ORDER BY player_tag,brawler_id")).rows, identities);
      results.push({ version, unchanged_full_commit_ms: elapsed });
      t.diagnostic(JSON.stringify(results.at(-1)));
    }
    for (const [version, definition] of definitions) {
      await db.query(definition);
      for (const item of brawlers) item.trophies++;
      const elapsed = await commit();
      const result = results.find(row => row.version === version); result.all_trophies_changed_ms = elapsed;
      t.diagnostic(JSON.stringify({ version, all_trophies_changed_ms: elapsed }));
    }
    t.diagnostic(JSON.stringify({ players: 28, brawlers: brawlers.length, payload_bytes: Buffer.byteLength(JSON.stringify(body)), results }));
  } finally { await db.query('ROLLBACK'); }
};
