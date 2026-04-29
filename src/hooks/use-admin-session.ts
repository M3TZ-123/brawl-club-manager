"use client";

import { useCallback, useEffect, useState } from "react";

type AdminStatus = {
  configured: boolean;
  isAdmin: boolean;
};

export function useAdminSession() {
  const [status, setStatus] = useState<AdminStatus>({
    configured: false,
    isAdmin: false,
  });
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch("/api/admin/session", {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error("Failed to load admin session");
      }
      const data = (await response.json()) as AdminStatus;
      setStatus({
        configured: data.configured === true,
        isAdmin: data.isAdmin === true,
      });
    } catch {
      setStatus({ configured: false, isAdmin: false });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const handleChange = () => refresh();
    window.addEventListener("admin-session-changed", handleChange);
    return () => window.removeEventListener("admin-session-changed", handleChange);
  }, [refresh]);

  const login = useCallback(async (password: string) => {
    const response = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Admin login failed");
    }
    setStatus({ configured: true, isAdmin: true });
    window.dispatchEvent(new CustomEvent("admin-session-changed"));
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/admin/session", { method: "DELETE" });
    setStatus((current) => ({ ...current, isAdmin: false }));
    window.dispatchEvent(new CustomEvent("admin-session-changed"));
  }, []);

  return {
    ...status,
    isLoading,
    refresh,
    login,
    logout,
  };
}
