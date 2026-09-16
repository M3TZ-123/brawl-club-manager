const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { localizeNotificationForDisplay } = loadTypeScript("src/lib/notification-display.ts");
const dictionary = {
  "Member Joined": "انضمام عضو", "Member Left": "مغادرة عضو", "Member Promoted": "ترقية عضو", "Member Demoted": "خفض رتبة عضو",
  "Name Changed": "تغيير اسم", "Role Changed": "تغيير رتبة", "Inactive members: {count}": "أعضاء غير نشطين: {count}",
  "{member} joined the club.": "انضم {member} إلى النادي.", "{member} left the club.": "غادر {member} النادي.",
  "{member} was promoted.": "تمت ترقية {member}.", "{member} was demoted.": "تم خفض رتبة {member}.",
  "{member} changed their name.": "غيّر {member} اسمه.", "{member} changed role.": "تغيّرت رتبة {member}.",
  "{member} role changed: {before} → {after}.": "تغيّرت رتبة {member}: {before} → {after}.",
  "{members} — no recorded activity for {hours}+ hours.": "{members} — لم يُسجّل نشاط منذ {hours} ساعة أو أكثر.",
  Senior: "عضو مميز", "Vice President": "نائب الرئيس",
};
const t = (key, values = {}) => (dictionary[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
const number = value => new Intl.NumberFormat("ar-TN").format(value);
const display = (type, title, message) => localizeNotificationForDisplay({ type, title, message }, t, number);

test("legacy and current generated membership messages localize while player names and tags remain verbatim", () => {
  const member = "Member Left {hours} خالد (Pro) (#ABC123)";
  for (const [type, title, suffixes, expected] of [
    ["join", "Member Joined", [" joined the club.", ": join."], `انضم ${member} إلى النادي.`],
    ["leave", "Member Left", [" left the club.", ": leave."], `غادر ${member} النادي.`],
    ["promotion", "Member Promoted", [" was promoted.", ": promotion."], `تمت ترقية ${member}.`],
    ["demotion", "Member Demoted", [" was demoted.", ": demotion."], `تم خفض رتبة ${member}.`],
    ["name_change", "Name Changed", [": name change."], `غيّر ${member} اسمه.`],
    ["role_change", "Role Changed", [": role change."], `تغيّرت رتبة ${member}.`],
  ]) {
    for (const suffix of suffixes) {
      const result = display(type, title, member + suffix);
      assert.equal(result.message, expected);
      assert.equal(result.title, dictionary[title]);
    }
  }
});

test("inactive list localization formats counts and thresholds without altering list text", () => {
  const members = "Name, One (#ABC), خالد (#DEF)";
  for (const suffix of [" — inactive for 48+ hours.", " — inactive for48+hours."]) {
    const result = display("inactive", "2 Inactive Member(s)", members + suffix);
    assert.equal(result.title, `أعضاء غير نشطين: ${number(2)}`);
    assert.equal(result.message, `${members} — لم يُسجّل نشاط منذ ${number(48)} ساعة أو أكثر.`);
  }
});

test("role changes localize only recognized role labels and retain unknown role values", () => {
  assert.equal(display("promotion", "Member Promoted", "Player (#ABC) role changed: senior → vicePresident.").message,
    "تغيّرت رتبة Player (#ABC): عضو مميز → نائب الرئيس.");
  assert.equal(display("role_change", "Role Changed", "Player (#ABC) role changed: futureRole → senior.").message,
    "تغيّرت رتبة Player (#ABC): futureRole → عضو مميز.");
});

test("freeform, Arabic, mismatched-type and malformed messages stay untouched and input is not mutated", () => {
  for (const input of [
    { type: "custom", title: "A personal announcement", message: "Player (#ABC) left the club." },
    { type: "leave", title: "Reminder", message: "We discussed why Player (#ABC) left the club. Please contact them." },
    { type: "leave", title: "عنوان عربي", message: "غادر خالد (#ABC) النادي." },
    { type: "leave", title: "Unknown title", message: "Someone left the club." },
    { type: "inactive", title: "Freeform", message: "Please check — inactive for 48+ hours." },
  ]) {
    const original = JSON.stringify(input);
    const result = localizeNotificationForDisplay(input, t, number);
    assert.equal(result.title, input.title);
    assert.equal(result.message, input.message);
    assert.equal(JSON.stringify(input), original);
  }
});
