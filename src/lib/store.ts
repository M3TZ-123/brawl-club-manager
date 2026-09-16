import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";

let settingsRead: Promise<void> | null = null;
let settingsGeneration = 0;
export type SettingsChanges = Partial<Pick<AppState, "clubTag" | "clubName" | "apiKey" | "inactivityThreshold" | "refreshInterval" | "notificationsEnabled" | "discordWebhook" | "requiredTrophies">>;

interface AppState {
  // Club info
  clubTag: string;
  clubName: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  
  // UI State
  lastSyncTime: string | null;
  isSyncing: boolean;
  isLoadingSettings: boolean;
  hasLoadedSettings: boolean;
  settingsError: string | null;
  theme: "light" | "dark";
  locale: "en" | "ar";
  sidebarOpen: boolean;
  
  // Settings
  inactivityThreshold: number; // hours
  refreshInterval: number; // minutes
  notificationsEnabled: boolean;
  discordWebhook: string;
  discordWebhookConfigured: boolean;
  requiredTrophies: number | null;
  
  // Actions
  setClubTag: (tag: string) => void;
  setClubName: (name: string) => void;
  setApiKey: (key: string) => void;
  setLastSyncTime: (time: string | null) => void;
  setIsSyncing: (syncing: boolean) => void;
  setIsLoadingSettings: (loading: boolean) => void;
  setTheme: (theme: "light" | "dark") => void;
  setLocale: (locale: "en" | "ar") => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setInactivityThreshold: (hours: number) => void;
  setRefreshInterval: (minutes: number) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setDiscordWebhook: (webhook: string) => void;
  setRequiredTrophies: (trophies: number | null) => void;
  loadSettingsFromDB: (force?: boolean) => Promise<void>;
  saveSettingsToDB: (changes?: SettingsChanges) => Promise<void>;
}

function parseIntegerSetting(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseNullableIntegerSetting(value: unknown, fallback: number | null): number | null {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Initial state
      clubTag: "",
      clubName: "",
      apiKey: "",
      apiKeyConfigured: false,
      lastSyncTime: null,
      isSyncing: false,
      isLoadingSettings: true,
      hasLoadedSettings: false,
      settingsError: null,
      theme: "dark",
      locale: "en",
      sidebarOpen: true,
      inactivityThreshold: 48,
      refreshInterval: 60, // 1 hour
      notificationsEnabled: true,
      discordWebhook: "",
      discordWebhookConfigured: false,
      requiredTrophies: null,
      
      // Actions
      setClubTag: (tag) => set({ clubTag: tag }),
      setClubName: (name) => set({ clubName: name }),
      setApiKey: (key) => set({ apiKey: key }),
      setLastSyncTime: (time) => set({ lastSyncTime: time }),
      setIsSyncing: (syncing) => set({ isSyncing: syncing }),
      setIsLoadingSettings: (loading) => set({ isLoadingSettings: loading }),
      setTheme: (theme) => set({ theme }),
      setLocale: (locale) => set({ locale }),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setInactivityThreshold: (hours) => set({ inactivityThreshold: hours }),
      setRefreshInterval: (minutes) => set({ refreshInterval: minutes }),
      setNotificationsEnabled: (enabled) => set({ notificationsEnabled: enabled }),
      setDiscordWebhook: (webhook) => set({ discordWebhook: webhook }),
      setRequiredTrophies: (trophies) => set({ requiredTrophies: trophies }),
      
      // Concurrent initial readers share one request; stale pre-save reads cannot
      // replace settings accepted after a successful mutation.
      loadSettingsFromDB: async (force = false) => {
        if (get().hasLoadedSettings && !force) return;
        if (settingsRead && !force) return settingsRead;
        const generation = ++settingsGeneration;
        const syncTimeAtRequest = get().lastSyncTime;
        // Background confirmation must not unmount an in-progress setup flow.
        // Its initiating control owns the pending state after the initial read.
        if (!get().hasLoadedSettings) set({ isLoadingSettings: true });
        const pending = (async () => {
          try {
            const settings = await fetchJsonWithTimeout<Record<string, string>>("/api/settings", { cache: "no-store" });
            if (generation !== settingsGeneration) return;
            set({
              clubTag: settings.club_tag || "", clubName: settings.club_name || "", apiKey: "",
              apiKeyConfigured: settings.api_key_configured === "true",
              inactivityThreshold: parseIntegerSetting(settings.inactivity_threshold, get().inactivityThreshold, 48, 168),
              refreshInterval: parseIntegerSetting(settings.refresh_interval, get().refreshInterval, 60, 1440),
              notificationsEnabled: settings.notifications_enabled == null ? get().notificationsEnabled : settings.notifications_enabled === "true",
              discordWebhook: "", discordWebhookConfigured: settings.discord_webhook_configured === "true",
              requiredTrophies: settings.required_trophies === "" ? null : settings.required_trophies != null
                ? parseNullableIntegerSetting(settings.required_trophies, get().requiredTrophies) : get().requiredTrophies,
              ...(get().lastSyncTime === syncTimeAtRequest ? { lastSyncTime: settings.last_sync_time || null } : {}),
              settingsError: null,
            });
          } catch (error) {
            if (generation === settingsGeneration) set({ settingsError: "Could not load settings. Please try again." });
            if (force) throw error;
          } finally {
            if (generation === settingsGeneration) set({ isLoadingSettings: false, hasLoadedSettings: true });
          }
        })();
        settingsRead = pending;
        try { await pending; } finally { if (settingsRead === pending) settingsRead = null; }
      },
      saveSettingsToDB: async (changes) => {
        const state = get();
        if (state.settingsError) throw new Error(state.settingsError);
        const proposed: SettingsChanges = changes ?? {
          clubTag: state.clubTag, clubName: state.clubName, apiKey: state.apiKey,
          inactivityThreshold: state.inactivityThreshold, refreshInterval: state.refreshInterval,
          notificationsEnabled: state.notificationsEnabled, discordWebhook: state.discordWebhook,
          ...(state.requiredTrophies != null ? { requiredTrophies: state.requiredTrophies } : {}),
        };
        const fields: Record<keyof SettingsChanges, string> = {
          clubTag: "club_tag", clubName: "club_name", apiKey: "api_key", inactivityThreshold: "inactivity_threshold",
          refreshInterval: "refresh_interval", notificationsEnabled: "notifications_enabled", discordWebhook: "discord_webhook", requiredTrophies: "required_trophies",
        };
        const payload: Record<string, string> = {};
        for (const key of Object.keys(proposed) as Array<keyof SettingsChanges>) {
          const value = proposed[key];
          if (value === undefined || ((key === "apiKey" || key === "discordWebhook") && !String(value).trim())) continue;
          payload[fields[key]] = value == null ? "" : String(value).trim();
        }
        settingsGeneration++; settingsRead = null;
        set({ isLoadingSettings: false });
        const result = await fetchJsonWithTimeout<{ success: boolean; requiresSync?: boolean }>("/api/settings", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        if (result.success !== true) throw new Error("Failed to save settings");
        // A read begun while the POST was pending may still contain the old row.
        settingsGeneration++; settingsRead = null;
        const applied = { ...proposed }; delete applied.apiKey; delete applied.discordWebhook;
        if (applied.clubTag !== undefined) applied.clubTag = "#" + applied.clubTag.trim().replace(/^%23/i, "#").replace(/^#/, "").toUpperCase();
        if (applied.clubName !== undefined) applied.clubName = applied.clubName.trim().slice(0, 120);
        set({ ...applied, apiKey: "", discordWebhook: "", settingsError: null, isLoadingSettings: false, hasLoadedSettings: true,
          apiKeyConfigured: payload.api_key ? true : get().apiKeyConfigured,
          discordWebhookConfigured: payload.discord_webhook ? true : get().discordWebhookConfigured,
          ...(result.requiresSync ? { lastSyncTime: null } : {}),
        });
      },
    }),
    {
      name: "brawl-club-manager-storage",
      // Old persisted timestamps are unverified hints, not server state.
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...(persistedState as Partial<AppState>),
        lastSyncTime: currentState.lastSyncTime,
      }),
      partialize: (state) => ({
        theme: state.theme,
        locale: state.locale,
        sidebarOpen: state.sidebarOpen,
        clubTag: state.clubTag,
        clubName: state.clubName,
        apiKeyConfigured: state.apiKeyConfigured,
        inactivityThreshold: state.inactivityThreshold,
        refreshInterval: state.refreshInterval,
        notificationsEnabled: state.notificationsEnabled,
        discordWebhookConfigured: state.discordWebhookConfigured,
        requiredTrophies: state.requiredTrophies,
      }),
    }
  )
);
