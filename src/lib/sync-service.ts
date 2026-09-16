import { supabaseAdmin } from "@/lib/supabase-admin";
import { publicMemberSnapshot } from "@/lib/sync-public-snapshots";
import { getUpstreamCooldownMs } from "@/lib/upstream-rate-limit";
import { getClub, getPlayer, getPlayerBattleLog, getPlayerRankedData, processBattleLog, calculateWinRateFromBattleLog, type BrawlStarsBrawler } from "@/lib/brawl-api";

export class SyncError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 500, public readonly retryAfterSeconds?: number) { super(message); }
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
    .in("key", ["club_tag", "api_key", "discord_webhook", "notifications_enabled", "sync_expected_interval_minutes", "sync_roster_interval_minutes", "sync_ranked_interval_minutes",
      "last_sync_time", "last_full_sync_time", "last_roster_sync_time", "last_battle_sync_time", "last_ranked_sync_time", "last_ranked_attempt_time", "sync_upstream_cooldown_until", "sync_ranked_cooldown_until"]);
  if (error) throw new SyncError("database_unavailable", "Sync settings could not be loaded.");
  return Object.fromEntries((data || []).map((row) => [row.key, row.value])) as Record<string, string>;
}
export type SyncResult = {
  success: boolean; synced: number; events: number; timestamp: string; runId: string;
  changes: { joins: Array<{ playerTag: string; playerName: string }>; leaves: Array<{ playerTag: string; playerName: string }> };
  member?: Record<string, unknown>; brawlers?: BrawlStarsBrawler[];
  scope?: "full" | "member" | "roster"; warnings?: string[];
};
function publicSyncResult(result: SyncResult): SyncResult {
  return { ...result, ...(result.member ? { member: publicMemberSnapshot(result.member) || {} } : {}) };
}

// Ranks are fetched independently of mandatory Brawl batches, with four workers.
export function prefetchSyncRanks(playerTags: string[], parentSignal: AbortSignal, deadlineAt = Date.now() + 8000) {
  type RankedData = Awaited<ReturnType<typeof getPlayerRankedData>>;
  const unavailable: RankedData = { currentRank: "Unranked", highestRank: "Unranked", currentPoints: 0, highestPoints: 0, available: false };
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
        try { result = await getPlayerRankedData(tag, { signal, deadlineAt }); } catch { /* Preserve cached ranks. */ }
      }
      resolveByTag.get(tag)!(result);
    }
  })).then(() => undefined);
  return { results, finished, cancel: () => controller.abort() };
}

function intervalMinutes(value: string | undefined, fallback: number, minimum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= 1440 ? parsed : fallback;
}
export function selectScheduledScope(settings: Record<string, string>, now = Date.now()): "full" | "roster" {
  const fullAt = Date.parse(settings.last_full_sync_time || settings.last_sync_time || "");
  // Completion is a few seconds after the cron boundary. Allow the route's
  // one-minute execution budget so a ten-minute cadence does not drift to 12.
  return !Number.isFinite(fullAt) || now - fullAt >= intervalMinutes(settings.sync_expected_interval_minutes, 10, 5) * 60_000 - 60_000 ? "full" : "roster";
}
function remainingCooldown(value: string | undefined) {
  const until = Date.parse(value || "");
  return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
}
function rateLimit(error: unknown): { provider: "brawl" | "rnt"; ms: number } | null {
  if (!error || typeof error !== "object" || !("status" in error) || error.status !== 429) return null;
  const wait = "retryAfterMs" in error ? Number(error.retryAfterMs) : "retryAfterSeconds" in error ? Number(error.retryAfterSeconds) * 1000 : NaN;
  return { provider: "provider" in error && error.provider === "rnt" ? "rnt" : "brawl", ms: Number.isFinite(wait) && wait > 0 ? wait : 60_000 };
}

export async function executeSync(options: {
  source: "cron" | "manual" | "member"; clubTag?: unknown; playerTag?: unknown;
  initialSetup?: boolean; idempotencyKey?: string | null; scope?: "full" | "roster" | "auto";
}): Promise<SyncResult> {
  const settings = await readSyncSettings();
  const clubTag = normalizeSyncTag(settings.club_tag || process.env.CLUB_TAG || options.clubTag);
  if (options.clubTag && normalizeSyncTag(options.clubTag) !== clubTag) throw new SyncError("club_changed", "Save the club setting before syncing a different club.", 409);
  const apiKey = settings.api_key || process.env.BRAWL_API_KEY;
  if (!apiKey) throw new SyncError("missing_api_key", "Configure the Brawl Stars API key before syncing.", 400);
  const playerTag = options.playerTag ? normalizeSyncTag(options.playerTag) : null;
  if (options.idempotencyKey && !/^[\w:.\-]{1,128}$/.test(options.idempotencyKey)) throw new SyncError("invalid_idempotency_key", "Invalid idempotency key.", 400);
  let scope: "full" | "roster" | "member" = playerTag ? "member" : options.scope === "auto" ? selectScheduledScope(settings) : options.scope || "full";
  if (options.scope === "auto" && options.idempotencyKey) {
    // A retry must keep the original scope even after the successful full run
    // changed the cadence marker. The lease RPC remains the replay authority.
    const previous = await supabaseAdmin.from("sync_runs").select("scope").eq("club_tag", clubTag).eq("idempotency_key", options.idempotencyKey).maybeSingle();
    if (previous.error) throw new SyncError("database_unavailable", "The previous scheduled request could not be checked.", 503);
    if (previous.data?.scope === "full" || previous.data?.scope === "roster") scope = previous.data.scope;
  }
  const { data: acquired, error: acquireError } = await supabaseAdmin.rpc("acquire_sync_run", {
    p_club_tag: clubTag, p_source: options.source, p_scope: scope,
    p_player_tag: playerTag, p_idempotency_key: options.idempotencyKey || null,
  });
  if (acquireError || !acquired) throw new SyncError("database_unavailable", "The sync could not start. Verify database migrations are installed.");
  if (acquired.replayed && acquired.status === "succeeded") return publicSyncResult(acquired.result as SyncResult);
  if (!acquired.acquired) throw new SyncError(acquired.busy || acquired.status === "running" ? "sync_busy" : "previous_attempt_failed",
    acquired.busy || acquired.status === "running" ? "Another sync is already running for this club." : "This request already failed. Retry with a new request ID.", 409);
  const runId: string = acquired.run_id;
  const fence: number = acquired.fence;
  const controller = new AbortController();
  const deadlineAt = Date.now() + 45000;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
  let ranked: ReturnType<typeof prefetchSyncRanks> | undefined;
  let phase: "fetch" | "commit" = "fetch";
  const cooldowns = new Map<"brawl" | "rnt", number>();
  const rememberRateLimit = (error: unknown) => {
    const limit = rateLimit(error);
    if (limit) cooldowns.set(limit.provider, Math.max(cooldowns.get(limit.provider) || 0, Date.now() + limit.ms));
    return limit;
  };
  const persistCooldowns = async () => {
    for (const provider of ["brawl", "rnt"] as const) {
      const inProcess = getUpstreamCooldownMs(provider);
      const until = Math.max(cooldowns.get(provider) || 0, inProcess > 0 ? Date.now() + inProcess : 0);
      if (until <= Date.now()) continue;
      const result = await supabaseAdmin.rpc("defer_sync_upstream", { p_provider: provider, p_until: new Date(until).toISOString() });
      if (result.error) throw new SyncError("database_unavailable", "The upstream cooldown could not be saved.", 503);
      cooldowns.delete(provider);
    }
  };
  try {
    const wait = remainingCooldown(settings.sync_upstream_cooldown_until);
    if (wait > 0) throw new SyncError("upstream_rate_limited", "The game API requested a pause. Sync will resume after its cooldown.", 429, Math.ceil(wait / 1000));
    const club = playerTag ? null : await getClub(clubTag, apiKey, signal, deadlineAt);
    if (club && (!Array.isArray(club.members) || club.members.some(member => !member.tag || typeof member.name !== "string" || typeof member.role !== "string"))) {
      throw new SyncError("invalid_upstream_roster", "The game API returned an incomplete club roster.", 502);
    }
    const roster = club?.members || [{ tag: playerTag!, name: "", role: "member" }];
    if (scope === "roster") {
      if (!club || club.members.some(member => !Number.isInteger(member.trophies) || member.trophies < 0)) throw new SyncError("invalid_upstream_roster", "The game API returned an incomplete club roster.", 502);
      phase = "commit";
      const result = await supabaseAdmin.rpc("commit_roster_snapshot", { p_run_id: runId, p_fence: fence, p_payload: {
        members: club.members.map(member => ({ player_tag: normalizeSyncTag(member.tag), player_name: member.name, role: member.role, trophies: member.trophies, icon_id: member.icon?.id ?? null })),
        required_trophies: club.requiredTrophies ?? null, initial_setup: options.initialSetup === true,
      } });
      if (result.error) {
        console.error("Roster snapshot rejected", { runId, sqlstate: /^[0-9A-Z]{5}$/.test(result.error.code || "") ? result.error.code : "unavailable" });
        throw new SyncError(result.error.code ? "snapshot_rejected" : "database_unavailable", "The roster snapshot could not be committed.", result.error.code ? 409 : 503);
      }
      return publicSyncResult(result.data as SyncResult);
    }
    const warnings = new Set<string>();
    const rankedAt = Date.parse(settings.last_ranked_attempt_time || settings.last_ranked_sync_time || "");
    const rankDue = Boolean(playerTag) || !Number.isFinite(rankedAt) || Date.now() - rankedAt >= intervalMinutes(settings.sync_ranked_interval_minutes, 30, 10) * 60_000 - 60_000;
    const rankCooling = remainingCooldown(settings.sync_ranked_cooldown_until) > 0;
    let fetchRanks = rankDue && !rankCooling;
    if (fetchRanks && scope === "full") {
      // Persist the attempt before network work, independently of the snapshot.
      // A later profile/commit failure must not trigger another rank batch at
      // every two-minute scheduler tick. The RPC rechecks cadence under the lease.
      const attempt = await supabaseAdmin.rpc("begin_sync_ranked_attempt", { p_run_id: runId, p_fence: fence });
      fetchRanks = !attempt.error && attempt.data === true;
      if (attempt.error) warnings.add("ranked_unavailable");
    }
    let rankedComplete = fetchRanks;
    let battleLogsComplete = true;
    if (rankDue && rankCooling) warnings.add("ranked_rate_limited");
    if (fetchRanks) ranked = prefetchSyncRanks(roster.map((member) => member.tag), signal, Math.min(deadlineAt, Date.now() + 8000));
    const members = [];
    const battles: ReturnType<typeof processBattleLog> = [];
    const brawlers = [];
    let refreshedBrawlers: BrawlStarsBrawler[] | undefined;
    for (let offset = 0; offset < roster.length; offset += 4) {
      if (signal.aborted) throw new SyncError("upstream_timeout", "The upstream API exceeded the sync time budget.");
      if (offset > 0) await new Promise((resolve) => setTimeout(resolve, 300));
      const batch = await Promise.all(roster.slice(offset, offset + 4).map(async (member) => {
        const [player, rank, log] = await Promise.all([
          getPlayer(member.tag, apiKey, signal, deadlineAt), ranked?.results.get(member.tag) ?? null,
          getPlayerBattleLog(member.tag, apiKey, signal, deadlineAt).catch(error => {
            battleLogsComplete = false;
            warnings.add(rememberRateLimit(error) ? "battle_logs_rate_limited" : "battle_logs_incomplete");
            return { items: [] };
          }),
        ]);
        return { member, player, rank, log };
      }));
      for (const { member, player, rank, log } of batch) {
        if (fetchRanks && !rank?.available) {
          rankedComplete = false;
          warnings.add(rank?.retryAfterMs ? "ranked_rate_limited" : "ranked_unavailable");
          if (rank?.retryAfterMs) rememberRateLimit({ status: 429, provider: "rnt", retryAfterMs: rank.retryAfterMs });
        }
        members.push({ player_tag: member.tag, player_name: playerTag ? player.name : member.name, role: member.role,
          icon_id: player.icon?.id ?? null, trophies: player.trophies, highest_trophies: player.highestTrophies, exp_level: player.expLevel,
          rank_current: rank?.available ? rank.currentRank : undefined, rank_highest: rank?.available ? rank.highestRank : undefined,
          rank_available: rank?.available === true, win_rate: calculateWinRateFromBattleLog(log).winRate,
          brawlers_count: player.brawlers.length, solo_victories: player.soloVictories, duo_victories: player.duoVictories, trio_victories: player["3vs3Victories"] });
        const uniqueBattles = new Map(processBattleLog(member.tag, log).map((battle) => [battle.battle_time, battle]));
        battles.push(...uniqueBattles.values());
        brawlers.push(...player.brawlers.map((b) => ({ player_tag: member.tag, brawler_id: b.id, brawler_name: b.name,
          power_level: b.power, trophies: b.trophies, rank: b.rank, gadgets_count: b.gadgets?.length || 0,
          star_powers_count: b.starPowers?.length || 0, gears_count: b.gears?.length || 0 })));
        if (playerTag) refreshedBrawlers = player.brawlers;
      }
    }
    await persistCooldowns();
    phase = "commit";
    const { data, error } = await supabaseAdmin.rpc("commit_sync_snapshot", { p_run_id: runId, p_fence: fence,
      p_payload: { members, battles, brawlers, initial_setup: options.initialSetup === true, required_trophies: club?.requiredTrophies ?? null,
        battle_logs_complete: battleLogsComplete, ranked_complete: rankedComplete, ranked_attempted: fetchRanks, warnings: [...warnings] } });
    if (error) {
      console.error("Full snapshot rejected", { runId, sqlstate: /^[0-9A-Z]{5}$/.test(error.code || "") ? error.code : "unavailable" });
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
    controller.abort();
    const limited = rememberRateLimit(error);
    await ranked?.finished;
    try { await persistCooldowns(); } catch { console.error("Could not save upstream cooldown", { runId }); }
    const failure = error instanceof SyncError ? error : limited ? new SyncError("upstream_rate_limited", "The game API requested a pause. Sync will resume after its cooldown.", 429, Math.ceil(limited.ms / 1000)) : new SyncError(phase === "fetch" ? "upstream_unavailable" : "database_unavailable",
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
