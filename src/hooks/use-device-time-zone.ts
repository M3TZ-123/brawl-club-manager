"use client";

import { useSyncExternalStore } from "react";

export function readDeviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}
function subscribeTimeZone(changed: () => void) {
  window.addEventListener("focus", changed);
  return () => window.removeEventListener("focus", changed);
}
const serverTimeZone = () => "UTC";

export function useDeviceTimeZone() {
  return useSyncExternalStore(subscribeTimeZone, readDeviceTimeZone, serverTimeZone);
}
