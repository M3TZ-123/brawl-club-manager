type NotificationText = { type: string; title: string; message: string };
type Translate = (key: string, values?: Record<string, string | number>) => string;
export type NotificationMessagePart = { text: string; tag?: string };
type NotificationDisplay = Pick<NotificationText, "title" | "message"> & { messageParts?: NotificationMessagePart[] };

function linkedMemberMessage(template: string, values: Record<string, string>, member: string, tag: string, t: Translate) {
  let marker = "\u0000member\u0000";
  while ([member, ...Object.values(values)].some(value => value.includes(marker))) marker += "_";
  const translated = t(template, { ...values, member: marker });
  const sections = translated.split(marker);
  const message = t(template, { ...values, member });
  return { message, messageParts: sections.length === 2
    ? [{ text: sections[0] }, { text: member, tag }, { text: sections[1] }]
    : [{ text: message }] };
}

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
export function localizeNotificationForDisplay(notification: NotificationText, t: Translate, number: (value: number) => string): NotificationDisplay {
  let title = SYSTEM_TITLES.has(notification.title) ? t(notification.title) : notification.title;
  let message = notification.message;
  let messageParts: NotificationMessagePart[] | undefined;
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

  if (notification.type === "name_change") {
    // A player name may contain commas, parentheses or template-like text. Only
    // split the exact legacy format when its name boundary is unambiguous.
    const legacy = /^(.+) \((#[A-Z0-9]+)\)\.$/.exec(notification.message);
    const names = legacy?.[1].split(" is now ");
    if (legacy && names?.length === 2 && names.every(name => name.trim())) {
      const linked = linkedMemberMessage("{before} is now {member}.", { before: names[0] }, `${names[1]} (${legacy[2]})`, legacy[2], t);
      message = linked.message; messageParts = linked.messageParts;
    } else {
      const current = /^(.+ \((#[A-Z0-9]+)\)): name change\.$/.exec(notification.message);
      if (current) {
        const linked = linkedMemberMessage("{member} changed their name.", {}, current[1], current[2], t);
        message = linked.message; messageParts = linked.messageParts;
      } else messageParts = [{ text: message }];
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
  return { title, message, ...(messageParts ? { messageParts } : {}) };
}
