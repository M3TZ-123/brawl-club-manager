export const PUBLIC_MEMBER_COLUMNS = "player_tag,player_name,icon_id,role,trophies,highest_trophies,exp_level,rank_current,rank_highest,win_rate,brawlers_count,solo_victories,duo_victories,trio_victories,is_active,last_updated";
const memberFields = new Set(PUBLIC_MEMBER_COLUMNS.split(","));
const auditFields = new Set([...memberFields, "first_seen", "last_seen", "last_left_at", "times_joined", "times_left", "is_current_member", "role_at_leave", "trophies_at_leave"]);
type PublicSnapshot = Record<string, string | number | boolean | null>;

function pickSnapshot(value: unknown, fields: Set<string>): PublicSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => fields.has(key)
    && (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number"))) as PublicSnapshot;
}

export const publicMemberSnapshot = (value: unknown) => pickSnapshot(value, memberFields);
export const publicAuditSnapshot = (value: unknown) => pickSnapshot(value, auditFields);
