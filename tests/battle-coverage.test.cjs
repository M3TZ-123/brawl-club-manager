const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { battleObservation, summarizeBattleCoverage } = loadTypeScript('src/lib/battle-coverage.ts');
const now = Date.parse('2026-09-16T12:00:00.000Z');
const item = battleTime => ({ battleTime, battle: { result: 'victory' } });

test('coverage observations preserve valid empty logs and canonicalize real source timestamps', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(battleObservation('#PLAYER', {items: []}, now))), {player_tag:'#PLAYER', success:true, battle_times:[]});
  const result=battleObservation('#PLAYER',{items:[item('20260916T115959.000Z'),item('20260916T115958.125Z'),item('20260916T115959Z')]},now);
  assert.equal(result.success,true);
  assert.deepEqual([...result.battle_times],['2026-09-16T11:59:58.000Z','2026-09-16T11:59:59.000Z']);
});

test('failed or malformed windows cannot establish coverage', () => {
  for(const log of [null,{}, {items:null},{items:[item('bad')]},{items:[item('20260230T120000.000Z')]},
    {items:[item('20260916T120200.000Z')]},{items:[{battleTime:'20260916T115959.000Z'}]},
    {items:Array.from({length:101},()=>item('20260916T115959.000Z'))}]) {
    assert.equal(battleObservation('#PLAYER',log,now).success,false);
  }
});

test('coverage summaries remain cautious for missing players and use the oldest accepted observation', () => {
  const rows=[{player_tag:'#A',baseline_started_at:'2026-09-16T10:00:00Z',last_observed_at:'2026-09-16T11:59:00Z'},
    {player_tag:'#B',baseline_started_at:'2026-09-16T10:00:00Z',last_observed_at:'2026-09-16T11:50:00Z'}];
  const all=summarizeBattleCoverage(['#A','#B','#A'],rows,now);
  assert.equal(all.status,'observed');assert.equal(all.monitoredPlayers,2);assert.equal(all.currentPlayers,2);
  assert.equal(all.lastCheckedAt,'2026-09-16T11:50:00.000Z');
  assert.equal(summarizeBattleCoverage(['#A','#B','#C'],rows,now).status,'unknown');
  assert.equal(summarizeBattleCoverage([],[],now).status,'unknown');
  assert.equal(summarizeBattleCoverage(['#A'],null,now).status,'unknown');
});

test('coverage summaries report possible gaps without exposing member details or claiming lost counts', () => {
  const row={player_tag:'#A',baseline_started_at:'2026-09-16T10:00:00Z',last_observed_at:'2026-09-16T11:59:00Z',
    possible_gap:true,last_gap_detected_at:'2026-09-16T11:58:00Z',private_field:'private-value'};
  const result=summarizeBattleCoverage(['#A'],[row,row,{...row,player_tag:'#OTHER'}],now);
  assert.equal(result.status,'possible_gap');assert.equal(result.affectedPlayers,1);assert.equal(result.windowDays,28);
  assert.equal(result.lastGapAt,'2026-09-16T11:58:00.000Z');
  assert.doesNotMatch(JSON.stringify(result),/#A|#OTHER|private|lost/);
  assert.equal(summarizeBattleCoverage(['#A'],[{...row,possible_gap:false,last_observed_at:'2099-01-01T00:00:00Z'}],now).status,'unknown');
});
