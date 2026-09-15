import { supabaseAdmin } from "@/lib/supabase-admin";
import { publicMemberSnapshot } from "@/lib/sync-public-snapshots";
import { getClub, getPlayer, getPlayerBattleLog, getPlayerRankedData, processBattleLog, calculateWinRateFromBattleLog, type BrawlStarsBrawler } from "@/lib/brawl-api";

export class SyncError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 500) { super(message); }
}
export function normalizeSyncTag(value: unknown): string {
  if (typeof value !== "string") throw new SyncError("invalid_tag", "A valid player or club tag is required.", 400);
  const tag = value.trim().replace(/^%23/i, "#").toUpperCase();
  const normalized = tag.startsWith("#") ? tag : `#${tag}`;
  if (!/^#[A-Z0-9]{2,20}$/.test(normalized)) throw new SyncError("invalid_tag", "A valid player or club tag is required.", 400);
  return normalized;
}
export async function readSyncSettings() {
  const { data, error } = await supabaseAdmin.from("settings").select("key,value")
    .in("key", ["club_tag", "api_key", "discord_webhook", "notifications_enabled", "sync_expected_interval_minutes", "last_sync_time"]);
  if (error) throw new SyncError("database_unavailable", "Sync settings could not be loaded.");
  return Object.fromEntries((data || []).map((row) => [row.key, row.value])) as Record<string, string>;
}
export type SyncResult = {
  success: boolean; synced: number; events: number; timestamp: string; runId: string;
  changes: { joins: Array<{ playerTag: string; playerName: string }>; leaves: Array<{ playerTag: string; playerName: string }> };
  member?: Record<string, unknown>; brawlers?: BrawlStarsBrawler[];
};
function publicSyncResult(result: SyncResult): SyncResult {
  return { ...result, ...(result.member ? { member: publicMemberSnapshot(result.member) || {} } : {}) };
}

// Ranks are fetched independently of mandatory Brawl batches, with four workers.
export function prefetchSyncRanks(playerTags: string[], parentSignal: AbortSignal) {
  type RankedData = Awaited<ReturnType<typeof getPlayerRankedData>>;
  const unavailable: RankedData = { currentRank: "Unranked", highestRank: "Unranked", currentPoints: 0, highestPoints: 0 };
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, parentSignal, AbortSignal.timeout(8000)]);
  const tags = [...new Set(playerTags)];
  const resolveByTag = new Map<string, (value: RankedData) => void>();
  const results = new Map(tags.map((tag) => [tag, new Promise<RankedData>((resolve) => resolveByTag.set(tag, resolve))]));
  let next = 0;
  const finished = Promise.all(Array.from({ length: Math.min(4, tags.length) }, async () => {
    while (next < tags.length) {
      const tag = tags[next++];
      let result = unavailable;
      if (!signal.aborted) {
        try { result = await getPlayerRankedData(tag, { signal }); } catch { /* Preserve cached ranks. */ }
      }
      resolveByTag.get(tag)!(result);
    }
  })).then(() => undefined);
  return { results, finished, cancel: () => controller.abort() };
}

export async function executeSync(options: {
  source: "cron" | "manual" | "member"; clubTag?: unknown; playerTag?: unknown;
  initialSetup?: boolean; idempotencyKey?: string | null;
}): Promise<SyncResult> {
  const settings = await readSyncSettings();
  const clubTag = normalizeSyncTag(settings.club_tag || process.env.CLUB_TAG || options.clubTag);
  if (options.clubTag && normalizeSyncTag(options.clubTag) !== clubTag) throw new SyncError("club_changed", "Save the club setting before syncing a different club.", 409);
  const apiKey = settings.api_key || process.env.BRAWL_API_KEY;
  if (!apiKey) throw new SyncError("missing_api_key", "Configure the Brawl Stars API key before syncing.", 400);
  const playerTag = options.playerTag ? normalizeSyncTag(options.playerTag) : null;
  if (options.idempotencyKey && !/^[\w:.\-]{1,128}$/.test(options.idempotencyKey)) throw new SyncError("invalid_idempotency_key", "Invalid idempotency key.", 400);
  const { data: acquired, error: acquireError } = await supabaseAdmin.rpc("acquire_sync_run", {
    p_club_tag: clubTag, p_source: options.source, p_scope: playerTag ? "member" : "full",
    p_player_tag: playerTag, p_idempotency_key: options.idempotencyKey || null,
  });
  if (acquireError || !acquired) throw new SyncError("database_unavailable", "The sync could not start. Verify database migrations are installed.");
  if (acquired.replayed && acquired.status === "succeeded") return publicSyncResult(acquired.result as SyncResult);
  if (!acquired.acquired) throw new SyncError(acquired.busy || acquired.status === "running" ? "sync_busy" : "previous_attempt_failed",
    acquired.busy || acquired.status === "running" ? "Another sync is already running for this club." : "This request already failed. Retry with a new request ID.", 409);
  const runId: string = acquired.run_id;
  const fence: number = acquired.fence;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
  let ranked: ReturnType<typeof prefetchSyncRanks> | undefined;
  let phase: "fetch" | "commit" = "fetch";
  try {
    const club = playerTag ? null : await getClub(clubTag, apiKey, signal);
    const roster = club?.members || [{ tag: playerTag!, name: "", role: "member" }];
    ranked = prefetchSyncRanks(roster.map((member) => member.tag), signal);
    const members = [];
    const battles: ReturnType<typeof processBattleLog> = [];
    const brawlers = [];
    let refreshedBrawlers: BrawlStarsBrawler[] | undefined;
    for (let offset = 0; offset < roster.length; offset += 4) {
      if (signal.aborted) throw new SyncError("upstream_timeout", "The upstream API exceeded the sync time budget.");
      if (offset > 0) await new Promise((resolve) => setTimeout(resolve, 300));
      const batch = await Promise.all(roster.slice(offset, offset + 4).map(async (member) => {
        const [player, rank, log] = await Promise.all([
          getPlayer(member.tag, apiKey, signal), ranked!.results.get(member.tag)!,
          getPlayerBattleLog(member.tag, apiKey, signal).catch(() => ({ items: [] })),
        ]);
        return { member, player, rank, log };
      }));
      for (const { member, player, rank, log } of batch) {
        members.push({ player_tag: member.tag, player_name: playerTag ? player.name : member.name, role: member.role,
          icon_id: player.icon?.id ?? null, trophies: player.trophies, highest_trophies: player.highestTrophies, exp_level: player.expLevel,
          rank_current: rank.currentRank, rank_highest: rank.highestRank, win_rate: calculateWinRateFromBattleLog(log).winRate,
          brawlers_count: player.brawlers.length, solo_victories: player.soloVictories, duo_victories: player.duoVictories, trio_victories: player["3vs3Victories"] });
        const uniqueBattles = new Map(processBattleLog(member.tag, log).map((battle) => [battle.battle_time, battle]));
        battles.push(...uniqueBattles.values());
        brawlers.push(...player.brawlers.map((b) => ({ player_tag: member.tag, brawler_id: b.id, brawler_name: b.name,
          power_level: b.power, trophies: b.trophies, rank: b.rank, gadgets_count: b.gadgets?.length || 0,
          star_powers_count: b.starPowers?.length || 0, gears_count: b.gears?.length || 0 })));
        if (playerTag) refreshedBrawlers = player.brawlers;
      }
    }
    phase = "commit";
    const { data, error } = await supabaseAdmin.rpc("commit_sync_snapshot", { p_run_id: runId, p_fence: fence,
      p_payload: { members, battles, brawlers, initial_setup: options.initialSetup === true, required_trophies: club?.requiredTrophies ?? null } });
    if (error) {
      const code = ["stale_sync_fence", "club_configuration_changed", "member_not_found"].includes(error.message) ? error.message
        : /^[0-9A-Z]{5}$/.test(error.code || "") ? "snapshot_rejected" : "database_unavailable";
      // A transport failure can hide a successful commit. Keep the request key so
      // retrying resolves the durable outcome instead of applying another snapshot.
      throw new SyncError(code, code === "member_not_found" ? "This member is not tracked by the club."
        : code === "database_unavailable" ? "The sync outcome could not be confirmed. Retry with the same request ID."
          : "The sync snapshot was not committed. It is safe to retry.", code === "member_not_found" ? 404 : code === "database_unavailable" ? 503 : 409);
    }
    return { ...publicSyncResult(data as SyncResult), ...(playerTag ? { brawlers: refreshedBrawlers } : {}) };
  } catch (error) {
    const failure = error instanceof SyncError ? error : new SyncError(phase === "fetch" ? "upstream_unavailable" : "database_unavailable",
      phase === "fetch" ? "A required player profile could not be fetched. No snapshot was committed." : "The sync could not be committed.");
    const { error: finishError } = await supabaseAdmin.rpc("fail_sync_run", { p_run_id: runId, p_fence: fence, p_error_code: failure.code, p_error_message: failure.message });
    if (finishError) console.error("Could not record sync failure", { runId, code: failure.code });
    throw failure;
  } finally {
    controller.abort();
    ranked?.cancel();
    await ranked?.finished;
  }
}
