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
  "{before} is now {member}.": "غيّر {before} اسمه إلى {member}.",
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

test("legacy name changes translate both names and identify only the new player name as the link", () => {
  for (const [before, after, tag] of [
    ["KING👻SOUL", "VyloX🍥", "#L2Q2RUVVV"],
    ["Madame Emna", "MGRN", "#JG9Q2RJ0P"],
    ["Name, {member} (Pro)", "خالد <b>✨</b> (One)", "#ABC123"],
  ]) {
    const input = { type: "name_change", title: "Name Changed", message: `${before} is now ${after} (${tag}).` };
    const original = JSON.stringify(input);
    const result = localizeNotificationForDisplay(input, t, number);
    assert.equal(result.message, `غيّر ${before} اسمه إلى ${after} (${tag}).`);
    assert.equal(result.messageParts.map(part => part.text).join(""), result.message);
    assert.deepEqual(JSON.parse(JSON.stringify(result.messageParts.filter(part => part.tag))), [{ text: `${after} (${tag})`, tag }]);
    assert.equal(JSON.stringify(input), original);
  }
});

test("ambiguous or unrecognized name changes remain literal text without guessing a player link", () => {
  for (const message of ["One is now Two is now Three (#ABC).", "Old is now New (#ABC). Extra text", "is now our new motto (#ABC).", "خبر مخصص (#ABC)"]) {
    const result = display("name_change", "Name Changed", message);
    assert.equal(result.message, message);
    assert.equal(result.messageParts.some(part => part.tag), false);
  }
  assert.equal(display("custom", "Announcement", "Old is now New (#ABC).").message, "Old is now New (#ABC).");
});

test("notification page uses the real Arabic dictionary and links only the new name in legacy name changes", async () => {
  const { hookRenderer, componentMocks, i18n, windowMock, elements, textContent } = require("./helpers/client-renderer.cjs");
  const { translate } = loadTypeScript("src/lib/i18n/messages.ts");
  for (const locale of ["en", "ar"]) {
    const renderer = hookRenderer();
    const rows = [
      { id: 1, type: "name_change", title: "Name Changed", message: "KING👻SOUL is now VyloX🍥 (#L2Q2RUVVV).", created_at: "2026-09-17T00:00:00Z", is_read: true },
      { id: 2, type: "name_change", title: "Name Changed", message: "Name, (Pro) is now <b>New</b> (#ABC).", created_at: "2026-09-17T00:00:00Z", is_read: true },
      { id: 3, type: "name_change", title: "Name Changed", message: "One is now Two is now Three (#OTHER).", created_at: "2026-09-17T00:00:00Z", is_read: true },
    ];
    const Page = loadTypeScript("src/app/notifications/page.tsx", {
      ...componentMocks, react: renderer.react,
      "@/components/locale-provider": { T: "T", LocalDate: "LocalDate", useI18n: () => ({ ...i18n, locale, t: (key, values) => translate(key, locale, values) }) },
      "@/components/time-range-picker": { TimeRangePicker: "TimeRangePicker" },
      "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: false }) },
      "@/lib/client-data-cache": { fetchJsonCached: async () => ({ notifications: rows, unreadCount: 0, nextCursor: null }) },
    }, { window: windowMock }).default;
    const tree = await renderer.render(Page);
    const links = elements(tree).filter(node => node.type === "Link" && node.props.href.startsWith("/members/"));
    assert.deepEqual(links.map(node => [textContent(node), node.props.href]), [["VyloX🍥 (#L2Q2RUVVV)", "/members/%23L2Q2RUVVV"], ["<b>New</b> (#ABC)", "/members/%23ABC"]]);
    const first = elements(tree).find(node => node.type === "Card" && node.key === "1");
    assert.ok(textContent(first).includes(locale === "ar" ? "غيّر KING👻SOUL اسمه إلى VyloX🍥 (#L2Q2RUVVV)." : rows[0].message));
    assert.equal(elements(tree).some(node => node.type === "b" || node.props?.dangerouslySetInnerHTML), false);
  }
});

test("notification bell shares the Arabic name-change link boundary and preserves link click behavior", async () => {
  const { hookRenderer, componentMocks, i18n, windowMock, elements, textContent } = require("./helpers/client-renderer.cjs");
  const { translate } = loadTypeScript("src/lib/i18n/messages.ts");
  const outer = hookRenderer(), react = { ...outer.react, createContext: () => ({ Provider: "Provider" }), useContext: () => ({ isOpen: false, toggle() {} }) };
  const row = { id: 1, type: "name_change", title: "Name Changed", message: "Madame Emna is now MGRN (#JG9Q2RJ0P).", created_at: "2026-09-17T00:00:00Z", is_read: false };
  const loaded = loadTypeScript("src/components/layout-wrapper.tsx", {
    ...componentMocks, react,
    "next/navigation": { usePathname: () => "/notifications" },
    "@/lib/store": { useAppStore: () => ({ clubName: "Club", theme: "dark", setSidebarOpen() {} }) },
    "@/components/locale-provider": { T: "T", LocalDate: "LocalDate", LanguageSelector: "LanguageSelector", useI18n: () => ({ ...i18n, locale: "ar", t: (key, values) => translate(key, "ar", values) }) },
    "@/hooks/use-admin-session": { useAdminSession: () => ({ isAdmin: true }) },
    "@/components/sync-health": { useSyncHealth() {} },
    "@/lib/client-data-cache": { fetchJsonCached: async () => ({ notifications: [row], unreadCount: 1 }) },
  }, { window: { ...windowMock, matchMedia: () => ({ matches: false }), setTimeout: callback => { callback(); return 1; }, clearTimeout() {} }, document: { addEventListener() {}, removeEventListener() {} } });
  const layout = await outer.render(() => loaded.LayoutWrapper({ children: null }));
  const Header = elements(layout).find(node => node.type?.name === "SimpleHeader").type;
  const renderer = hookRenderer(); Object.assign(react, renderer.react);
  let tree = await renderer.render(Header);
  elements(tree).find(node => node.props?.["aria-label"] === translate("Notifications", "ar")).props.onClick();
  tree = await renderer.render(Header);
  const links = elements(tree).filter(node => node.type === "Link" && node.props.href.startsWith("/members/"));
  assert.deepEqual(links.map(node => [textContent(node), node.props.href]), [["MGRN (#JG9Q2RJ0P)", "/members/%23JG9Q2RJ0P"]]);
  assert.ok(textContent(tree).includes("غيّر Madame Emna اسمه إلى MGRN (#JG9Q2RJ0P)."));
  let stopped = false; links[0].props.onClick({ stopPropagation() { stopped = true; } }); assert.equal(stopped, true);
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
