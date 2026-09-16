export const PUBLIC_MEMBER_COLUMNS = "player_tag,player_name,icon_id,role,trophies,highest_trophies,exp_level,rank_current,rank_highest,ranked_season_id,ranked_points,ranked_season_best,ranked_season_best_points,ranked_all_time_best_points,ranked_checked_at,ranked_source,ranked_provenance,win_rate,brawlers_count,solo_victories,duo_victories,trio_victories,is_active,last_updated";
// List screens use the tier names; detailed provenance belongs in the one-player response.
export const PUBLIC_MEMBER_LIST_COLUMNS = "player_tag,player_name,icon_id,role,trophies,highest_trophies,exp_level,rank_current,rank_highest,win_rate,brawlers_count,solo_victories,duo_victories,trio_victories,is_active,last_updated";
const memberFields = new Set(PUBLIC_MEMBER_COLUMNS.split(","));
const auditFields = new Set([...memberFields, "first_seen", "last_seen", "last_left_at", "times_joined", "times_left", "is_current_member", "role_at_leave", "trophies_at_leave"]);
type RankedProvenance = Record<string, { source: "profile" | "rnt"; checked_at: string }>;
type PublicSnapshot = Record<string, string | number | boolean | null | RankedProvenance>;
const rankedFields = new Set(["rank_current", "rank_highest", "ranked_points", "ranked_all_time_best_points", "ranked_season_id", "ranked_season_best", "ranked_season_best_points"]);

function publicRankedProvenance(value: unknown): RankedProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: RankedProvenance = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!rankedFields.has(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if ((item.source === "profile" || item.source === "rnt") && typeof item.checked_at === "string" && Number.isFinite(Date.parse(item.checked_at))) {
      result[key] = { source: item.source, checked_at: item.checked_at };
    }
  }
  return result;
}

function pickSnapshot(value: unknown, fields: Set<string>): PublicSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => fields.has(key)
    && (key === "ranked_provenance" || item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number"))
    .map(([key, item]) => [key, key === "ranked_provenance" ? publicRankedProvenance(item) : item])) as PublicSnapshot;
}

export const publicMemberSnapshot = (value: unknown) => pickSnapshot(value, memberFields);
export const publicAuditSnapshot = (value: unknown) => pickSnapshot(value, auditFields);
