const assert = require("node:assert/strict");
function hookRenderer() {
  const slots = [];
  const effects = [];
  let cursor = 0;
  let dirty = false;
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  function memo(factory, dependencies) {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { value: factory(), dependencies };
    return slots[index].value;
  }
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, update => {
        const value = typeof update === "function" ? update(slots[index].value) : update;
        if (!Object.is(value, slots[index].value)) dirty = true;
        slots[index].value = value;
      }];
    },
    useMemo: memo,
    useCallback: (callback, dependencies) => memo(() => callback, dependencies),
    useRef: value => memo(() => ({ current: value }), []),
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        slots[index]?.cleanup?.();
        slots[index] = { dependencies };
        effects.push(() => { slots[index].cleanup = callback(); });
      }
    },
  };
  return { react, async render(component) {
    for (let pass = 0; pass < 30; pass++) {
      cursor = 0;
      dirty = false;
      const tree = component();
      while (effects.length) effects.shift()();
      await new Promise(resolve => setImmediate(resolve));
      if (!dirty) return tree;
    }
    throw new Error("Client component did not settle");
  } };
}

const i18n = { t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`)), locale: "en", direction: "ltr", number: value => Number(value).toLocaleString("en-GB"), delta: value => String(value), date: value => value || "Unknown", dateTime: value => value || "Unknown", reportDate: value => value, relative: value => value || "Unknown" };
const componentMocks = {
  "@/components/locale-provider": { T: "T", LocalDate: "LocalDate", LanguageSelector: "LanguageSelector", useI18n: () => i18n },
  "@/components/sync-health": { SyncHealthCard: "SyncHealthCard", DataConfidenceNotice: "DataConfidenceNotice" },
  "@/components/member-review": { MemberReviewButton: "MemberReviewButton", MemberReviewSheet: "MemberReviewSheet" },
  "@/components/ui/sheet": Object.fromEntries(["Sheet", "SheetContent", "SheetHeader", "SheetTitle", "SheetDescription"].map(name => [name, name])),
  "@/components/admin-gate": { AdminGate: "AdminGate" },
  "@/components/layout-wrapper": { LayoutWrapper: "LayoutWrapper" },
  "@/components/stats-cards": { StatsCards: "StatsCards" },
  "@/components/activity-timeline": { ActivityTimeline: "ActivityTimeline" },
  "@/components/ui/button": { Button: "Button" },
  "@/components/ui/input": { Input: "Input" },
  "@/components/ui/badge": { Badge: "Badge" },
  "@/components/ui/card": Object.fromEntries(["Card", "CardContent", "CardHeader", "CardTitle", "CardDescription"].map(name => [name, name])),
  "next/link": "Link",
  "next/image": "Image",
  "lucide-react": new Proxy({}, { get: (_, name) => name }),
};
const windowMock = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
function elements(tree) {
  if (tree == null || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return [tree, ...elements(tree.props?.children)];
}
function textContent(tree) {
  if (tree == null) return "";
  if (Array.isArray(tree)) return tree.map(textContent).join("");
  if (tree?.type === "T") return i18n.t(String(tree.props.text || ""), tree.props.values);
  return typeof tree === "object" ? textContent(tree.props?.children) : String(tree);
}
function action(tree, text) {
  const match = elements(tree).find(element => element.props?.onClick && textContent(element).replace(/\s+/g, " ").trim() === text);
  assert.ok(match, `Missing action: ${text}`);
  return match.props.onClick;
}




module.exports = { hookRenderer, i18n, componentMocks, windowMock, elements, textContent, action };
