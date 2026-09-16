type NotificationText = { type: string; title: string; message: string };
type Translate = (key: string, values?: Record<string, string | number>) => string;

const SYSTEM_TITLES = new Set([
  "Member Joined", "Member Left", "Member Promoted", "Member Demoted", "Name Changed", "Role Changed",
]);

const EVENT_MESSAGES: Record<string, { suffixes: string[]; template: string }> = {
  join: { suffixes: [" joined the club.", ": join."], template: "{member} joined the club." },
  leave: { suffixes: [" left the club.", ": leave."], template: "{member} left the club." },
  promotion: { suffixes: [" was promoted.", ": promotion."], template: "{member} was promoted." },
  demotion: { suffixes: [" was demoted.", ": demotion."], template: "{member} was demoted." },
  name_change: { suffixes: [": name change."], template: "{member} changed their name." },
  role_change: { suffixes: [": role change."], template: "{member} changed role." },
};

function roleLabel(role: string, t: Translate) {
  const keys: Record<string, string> = { member: "Member", senior: "Senior", vicepresident: "Vice President", president: "President" };
  const key = keys[role.toLowerCase()];
  return key ? t(key) : role;
}

/** Localizes known generated text without modifying stored rows or player text. */
export function localizeNotificationForDisplay(notification: NotificationText, t: Translate, number: (value: number) => string): Pick<NotificationText, "title" | "message"> {
  let title = SYSTEM_TITLES.has(notification.title) ? t(notification.title) : notification.title;
  let message = notification.message;
  const inactiveTitle = notification.type === "inactive" && /^(\d+) Inactive Member\(s\)$/.exec(title);
  if (inactiveTitle) title = t("Inactive members: {count}", { count: number(Number(inactiveTitle[1])) });

  const event = EVENT_MESSAGES[notification.type];
  if (event) {
    const suffix = event.suffixes.find(value => message.endsWith(value));
    if (suffix) {
      const member = message.slice(0, -suffix.length);
      if (/^.+ \(#[A-Z0-9]+\)$/.test(member)) message = t(event.template, { member });
    }
  }

  if (["promotion", "demotion", "role_change"].includes(notification.type)) {
    const roleChange = /^(.+ \(#[A-Z0-9]+\)) role changed: ([A-Za-z]+) → ([A-Za-z]+)\.$/.exec(notification.message);
    if (roleChange) message = t("{member} role changed: {before} → {after}.", {
      member: roleChange[1], before: roleLabel(roleChange[2], t), after: roleLabel(roleChange[3], t),
    });
  }

  if (notification.type === "inactive") {
    const inactive = /^(.+) — inactive for\s*(\d+)\+\s*hours\.$/.exec(notification.message);
    if (inactive && /\(#[A-Z0-9]+\)/.test(inactive[1])) message = t("{members} — no recorded activity for {hours}+ hours.", {
      members: inactive[1], hours: number(Number(inactive[2])),
    });
  }
  return { title, message };
}
