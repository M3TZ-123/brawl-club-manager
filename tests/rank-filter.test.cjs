const test=require('node:test');
const assert=require('node:assert/strict');
const {loadTypeScript}=require('./helpers/load-typescript.cjs');
const {rankMatches}=loadTypeScript('src/lib/rank-filter.ts');
test('missing rank is distinct from an observed Unranked result',()=>{
  for(const rank of [null,undefined,'',' ']){assert.equal(rankMatches(rank,'unknown'),true);assert.equal(rankMatches(rank,'unranked'),false);assert.equal(rankMatches(rank,'all'),true);}
  assert.equal(rankMatches('Unranked','unranked'),true);assert.equal(rankMatches('Unranked','unknown'),false);
});
test('rank filters retain legacy Masters, current divisions and the distinct Pro tier',()=>{
  for(const rank of ['Masters','Masters I','Masters III'])assert.equal(rankMatches(rank,'masters'),true);
  assert.equal(rankMatches('Pro','pro'),true);assert.equal(rankMatches('Pro','masters'),false);
  for(const rank of ['Silver III','Bronze I'])assert.equal(rankMatches(rank,'lower'),true);
  assert.equal(rankMatches('Diamond I','diamond'),true);assert.equal(rankMatches('Diamond I','lower'),false);
});
