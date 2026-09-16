const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { getBattleModeInfo, normalizeBattleMode, describeBattleContext } = loadTypeScript("src/lib/battle-catalog.ts");

test("internal API aliases display the verified game names without changing the event", () => {
  for (const [raw, key, label] of [
    ["airHockey", "brawlHockey", "Brawl Hockey"],
    ["deathmatch", "wipeout", "Wipeout"],
    ["tagTeam", "duels", "Duels"],
    ["airHockey5v5", "brawlHockey5v5", "Brawl Hockey 5v5"],
    ["deathmatch5V5", "wipeout5v5", "Wipeout 5v5"],
    ["cooking", "foodFight", "Food Fight"],
  ]) {
    assert.equal(normalizeBattleMode(raw), key);
    assert.equal(getBattleModeInfo(raw).label, label);
    assert.match(getBattleModeInfo(raw).imageUrl, /^https:\/\/cdn\.brawlify\.com\/game-modes\/regular\/\d+\.png$/);
  }
  assert.equal(normalizeBattleMode("brawlBall5V5"), "brawlBall5v5");
});

test("current events and future modes stay identifiable, including ampersand mode keys", () => {
  for (const [key, label] of [["foodFight", "Food Fight"], ["mechaGuard", "Mecha Guard"],
    ["combatCooking", "Combat Cooking"], ["hide&Seek", "Hide & Seek"], ["megaBoss", "Boss Fight"]]) {
    assert.equal(getBattleModeInfo(key).label, label);
  }
  assert.equal(getBattleModeInfo("futureEvent2027").key, "futureEvent2027");
  assert.equal(getBattleModeInfo("futureEvent2027").label, "Future Event2027");
  assert.equal(getBattleModeInfo(null).label, "Unknown mode");
  assert.equal(getBattleModeInfo("loaded SD").label, "Loaded Showdown · Unknown format");
  assert.equal(getBattleModeInfo("loaded SD").imageUrl, null);
  assert.equal(normalizeBattleMode("loaded SD", 78), "loadedDuoShowdown");
  assert.equal(normalizeBattleMode("megaBoss", 61), "megaBoss");
  assert.equal(normalizeBattleMode("bossFight", 10), "bossFight");
});

test("source mode IDs identify internal aliases, preserve zero and ignore unfamiliar IDs", () => {
  assert.equal(normalizeBattleMode("duoShowdown", 38), "trioShowdown");
  assert.equal(normalizeBattleMode("newInternalName", 45), "brawlHockey");
  assert.equal(normalizeBattleMode(null, 0), "gemGrab");
  assert.equal(getBattleModeInfo("futureAlias", 83).label, "Hide & Seek");
  assert.equal(normalizeBattleMode("futureEvent", 9999), "futureEvent");
  assert.equal(normalizeBattleMode("brawlBall", -1), "brawlBall");
});

test("competitive Ranked is separate from the API's trophy-ladder type named ranked", () => {
  assert.equal(describeBattleContext({ battle_type: "ranked" }).key, "ladder");
  for (const type of ["soloRanked", "teamRanked"]) {
    assert.equal(describeBattleContext({ battle_type: type }).key, "ranked");
  }
  assert.equal(describeBattleContext({ battle_type: "championshipChallenge" }).key, "challenge");
});

test("missing context, casual and club events are never guessed as Mega Pig or tournaments", () => {
  for (const type of [null, undefined, "", "casual", "clubLeague", "newTournamentType"]) {
    assert.equal(describeBattleContext({ battle_type: type }).key, "unknown");
  }
  assert.equal(describeBattleContext({ battle_type: "friendly" }).key, "friendly");
  assert.equal(describeBattleContext({ battle_type: "megaPig" }).key, "mega_pig");
  assert.equal(describeBattleContext({ battle_type: "tournament" }).key, "tournament");
});
