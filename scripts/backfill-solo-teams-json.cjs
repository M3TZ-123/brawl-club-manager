const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

function getArgValue(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return fallback;
  const raw = arg.slice(prefix.length);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function toIsoFromBattleTime(battleTime) {
  const year = battleTime.slice(0, 4);
  const month = battleTime.slice(4, 6);
  const day = battleTime.slice(6, 8);
  const hour = battleTime.slice(9, 11);
  const minute = battleTime.slice(11, 13);
  const second = battleTime.slice(13, 15);
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`).toISOString();
}

function normalizeTag(tag) {
  if (!tag) return tag;
  return tag.startsWith("%23") ? `#${tag.slice(3)}` : tag;
}

function simplifyPlayer(player) {
  const brawler = player?.brawler || player?.brawlers?.[0] || null;
  if (!player?.tag) return null;
  return {
    tag: normalizeTag(player.tag),
    name: player.name || normalizeTag(player.tag),
    brawler: brawler?.name || null,
    power: brawler?.power || null,
    trophies: brawler?.trophies || null,
  };
}

function buildTeamsJsonFromBattle(battle) {
  if (Array.isArray(battle?.teams) && battle.teams.length > 0) {
    const teams = battle.teams
      .map((team) => (Array.isArray(team) ? team : []))
      .map((team) => team.map((player) => simplifyPlayer(player)).filter(Boolean))
      .filter((team) => team.length > 0);
    return teams.length > 0 ? JSON.stringify(teams) : null;
  }

  if (Array.isArray(battle?.players) && battle.players.length > 0) {
    const teams = battle.players
      .map((player) => simplifyPlayer(player))
      .filter(Boolean)
      .map((player) => [player]);
    return teams.length > 0 ? JSON.stringify(teams) : null;
  }

  return null;
}

function epochKey(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function encodeTag(tag) {
  const t = tag.startsWith("#") ? tag : `#${tag}`;
  return encodeURIComponent(t);
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env.local"));

  const apply = hasFlag("apply");
  const days = getArgValue("days", 30);
  const limit = getArgValue("limit", 50);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error: rowsError } = await supabase
    .from("battle_history")
    .select("id,player_tag,battle_time")
    .eq("mode", "soloShowdown")
    .is("teams_json", null)
    .gte("battle_time", sinceIso)
    .order("battle_time", { ascending: false })
    .limit(limit);

  if (rowsError) throw rowsError;

  if (!rows || rows.length === 0) {
    console.log(JSON.stringify({ apply, days, limit, candidates: 0, updated: 0 }, null, 2));
    return;
  }

  const { data: settingsRows } = await supabase
    .from("settings")
    .select("key,value")
    .eq("key", "api_key")
    .limit(1);

  const apiKey = settingsRows?.[0]?.value || process.env.BRAWL_API_KEY;
  if (!apiKey) throw new Error("Missing Brawl API key in settings(api_key) and BRAWL_API_KEY");

  const tags = [...new Set(rows.map((row) => row.player_tag))];
  const battleMapByTag = new Map();

  for (const tag of tags) {
    try {
      const url = `https://bsproxy.royaleapi.dev/v1/players/${encodeTag(tag)}/battlelog`;
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        timeout: 20000,
      });

      const perTime = new Map();
      for (const item of response.data?.items || []) {
        const mode = item?.event?.mode || item?.battle?.mode;
        if (mode !== "soloShowdown") continue;
        const iso = toIsoFromBattleTime(item.battleTime);
        const key = epochKey(iso);
        const teamsJson = buildTeamsJsonFromBattle(item.battle);
        if (teamsJson) perTime.set(key, teamsJson);
      }

      battleMapByTag.set(tag, perTime);
    } catch {
      battleMapByTag.set(tag, new Map());
    }
  }

  let updated = 0;
  let matched = 0;
  let noMatch = 0;
  let errors = 0;

  for (const row of rows) {
    const perTime = battleMapByTag.get(row.player_tag);
    const key = epochKey(row.battle_time);
    const teamsJson = perTime?.get(key);

    if (!teamsJson) {
      noMatch++;
      continue;
    }

    matched++;

    if (!apply) continue;

    const { error: updateError } = await supabase
      .from("battle_history")
      .update({ teams_json: teamsJson })
      .eq("id", row.id)
      .is("teams_json", null);

    if (updateError) {
      errors++;
      continue;
    }

    updated++;
  }

  console.log(
    JSON.stringify(
      {
        apply,
        days,
        limit,
        candidates: rows.length,
        matched,
        noMatch,
        updated,
        errors,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
