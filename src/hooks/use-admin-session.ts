"use client";

import { useSyncExternalStore } from "react";
import { getAdminSession, getServerAdminSession, loginAdmin, logoutAdmin, refreshAdminSession, subscribeAdminSession } from "@/lib/client-admin-session";

export function useAdminSession() {
  const status = useSyncExternalStore(subscribeAdminSession, getAdminSession, getServerAdminSession);
  return { ...status, refresh: refreshAdminSession, login: loginAdmin, logout: logoutAdmin };
}
