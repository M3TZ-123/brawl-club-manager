const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToString } = require("react-dom/server");
const { useStore } = require("zustand");
const { createStore } = require("zustand/vanilla");
const { persist, createJSONStorage } = require("zustand/middleware");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

function persistedLocaleStore(locale) {
  let stored = JSON.stringify({ state: { locale }, version: 0 });
  return createStore(persist(set => ({ locale: "en", setLocale: value => set({ locale: value }) }), {
    name: "fixture-locale",
    storage: createJSONStorage(() => ({ getItem: () => stored, setItem: (_key, value) => { stored = value; }, removeItem() { stored = null; } })),
  }));
}

test("a late locale consumer retains the server snapshot after its ancestor reads saved Arabic", () => {
  const store = persistedLocaleStore("ar");
  assert.equal(store.getInitialState().locale, "en");
  assert.equal(store.getState().locale, "ar");

  // Selective hydration can finish the provider's client render while a
  // Suspense descendant still needs the server snapshot. Capture that live
  // ancestor, then render its delayed consumer with React's actual server
  // external-store snapshot. No DOM shim or suppression masks a mismatch.
  let captureLiveAncestor = true;
  const locale = loadTypeScript("src/components/locale-provider.tsx", {
    react: { ...React, useEffect: (...args) => captureLiveAncestor ? undefined : React.useEffect(...args) },
    "@/lib/store": { useAppStore: selector => captureLiveAncestor ? selector(store.getState()) : useStore(store, selector) },
  });
  function AnalysisHeading() {
    const { t, direction } = locale.useI18n();
    return React.createElement("h1", { dir: direction }, t("Battle analysis"));
  }
  const ancestor = locale.LocaleProvider({ children: React.createElement(AnalysisHeading) });
  captureLiveAncestor = false;
  assert.equal(renderToString(ancestor), '<h1 dir="ltr">Battle analysis</h1>',
    "A persisted ancestor must not inject Arabic into a descendant's first hydration snapshot");
});

test("server locale output stays deterministic with persisted Arabic and a Suspense boundary", () => {
  const store = persistedLocaleStore("ar");
  const locale = loadTypeScript("src/components/locale-provider.tsx", {
    "@/lib/store": { useAppStore: selector => useStore(store, selector) },
  });
  function Heading() {
    const { t } = locale.useI18n();
    return React.createElement("h1", null, t("Battle analysis"));
  }
  const tree = React.createElement(locale.LocaleProvider, null,
    React.createElement(React.Suspense, { fallback: "Loading" }, React.createElement(Heading)));
  assert.match(renderToString(tree), /<h1>Battle analysis<\/h1>/);
  store.getState().setLocale("en");
  assert.match(renderToString(tree), /<h1>Battle analysis<\/h1>/);
});
