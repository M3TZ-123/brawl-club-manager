export function memberReviewStatusLabel(status: string): string {
  if (status === "pending") return "Pending";
  if (status === "follow_up") return "Follow up";
  if (status === "reviewed") return "Reviewed";
  return "Unknown";
}

export function memberReviewActivityLabel(status?: string): string {
  if (status === "active") return "Active";
  if (status === "minimal") return "Low activity";
  if (status === "inactive") return "Inactive";
  return "Unknown";
}
