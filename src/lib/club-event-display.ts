const eventLabels: Record<string, string> = {
  join: "Joined",
  leave: "Left",
  promotion: "Promoted",
  demotion: "Demoted",
  name_change: "Name Changed",
  role_change: "Role Changed",
};

export function clubEventLabel(type: string) {
  return Object.hasOwn(eventLabels, type) ? eventLabels[type] : "Club event";
}
