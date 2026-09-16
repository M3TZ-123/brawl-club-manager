/** Display keys only; never use these labels to store or compare club roles. */
export function clubRoleLabel(role: string | null | undefined): string {
  switch (role?.trim().toLowerCase()) {
    case "president": return "President";
    case "vicepresident": return "Vice President";
    case "senior": return "Senior";
    case "member": return "Member";
    case undefined:
    case "": return "Unknown";
    default: return role!;
  }
}
