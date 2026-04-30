import { create } from "zustand";
import { persist } from "zustand/middleware";

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
  theme: "light" | "dark";
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
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setInactivityThreshold: (hours: number) => void;
  setRefreshInterval: (minutes: number) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setDiscordWebhook: (webhook: string) => void;
  setRequiredTrophies: (trophies: number | null) => void;
  loadSettingsFromDB: () => Promise<void>;
  saveSettingsToDB: () => Promise<void>;
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
      theme: "dark",
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
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setInactivityThreshold: (hours) => set({ inactivityThreshold: hours }),
      setRefreshInterval: (minutes) => set({ refreshInterval: minutes }),
      setNotificationsEnabled: (enabled) => set({ notificationsEnabled: enabled }),
      setDiscordWebhook: (webhook) => set({ discordWebhook: webhook }),
      setRequiredTrophies: (trophies) => set({ requiredTrophies: trophies }),
      
      // Load settings from database (only once)
      loadSettingsFromDB: async () => {
        // Skip if already loaded
        if (get().hasLoadedSettings) {
          return;
        }
        try {
          set({ isLoadingSettings: true });
          const response = await fetch("/api/settings");
          if (response.ok) {
            const settings = await response.json();
            set({
              clubTag: settings.club_tag || get().clubTag || "",
              clubName: settings.club_name || get().clubName || "",
              apiKey: "",
              apiKeyConfigured: settings.api_key_configured === "true" || get().apiKeyConfigured,
              inactivityThreshold: parseIntegerSetting(settings.inactivity_threshold, get().inactivityThreshold, 48, 168),
              refreshInterval: parseIntegerSetting(settings.refresh_interval, get().refreshInterval, 60, 1440),
              notificationsEnabled: settings.notifications_enabled == null
                ? get().notificationsEnabled
                : settings.notifications_enabled === "true",
              discordWebhook: "",
              discordWebhookConfigured: settings.discord_webhook_configured === "true" || get().discordWebhookConfigured,
              requiredTrophies: settings.required_trophies != null
                ? parseNullableIntegerSetting(settings.required_trophies, get().requiredTrophies)
                : get().requiredTrophies,
              lastSyncTime: settings.last_sync_time || get().lastSyncTime,
            });
          }
        } catch (error) {
          console.error("Failed to load settings from DB:", error);
        } finally {
          set({ isLoadingSettings: false, hasLoadedSettings: true });
        }
      },
      
      // Save settings to database
      saveSettingsToDB: async () => {
        const state = get();
        try {
          const apiKey = state.apiKey.trim();
          const discordWebhook = state.discordWebhook.trim();
          const payload: Record<string, string> = {
            club_tag: state.clubTag,
            club_name: state.clubName,
            inactivity_threshold: String(state.inactivityThreshold),
            refresh_interval: String(state.refreshInterval),
            notifications_enabled: String(state.notificationsEnabled),
            last_sync_time: state.lastSyncTime || "",
          };

          if (apiKey) {
            payload.api_key = apiKey;
          }

          if (discordWebhook) {
            payload.discord_webhook = discordWebhook;
          }

          if (state.requiredTrophies != null && Number.isFinite(state.requiredTrophies)) {
            payload.required_trophies = String(state.requiredTrophies);
          }

          const response = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || "Failed to save settings");
          }

          set({
            apiKey: "",
            discordWebhook: "",
            apiKeyConfigured: apiKey ? true : state.apiKeyConfigured,
            discordWebhookConfigured: discordWebhook ? true : state.discordWebhookConfigured,
          });
        } catch (error) {
          console.error("Failed to save settings to DB:", error);
          throw error;
        }
      },
    }),
    {
      name: "brawl-club-manager-storage",
      partialize: (state) => ({
        theme: state.theme,
        sidebarOpen: state.sidebarOpen,
        clubTag: state.clubTag,
        clubName: state.clubName,
        apiKeyConfigured: state.apiKeyConfigured,
        inactivityThreshold: state.inactivityThreshold,
        refreshInterval: state.refreshInterval,
        notificationsEnabled: state.notificationsEnabled,
        discordWebhookConfigured: state.discordWebhookConfigured,
        requiredTrophies: state.requiredTrophies,
        lastSyncTime: state.lastSyncTime,
      }),
    }
  )
);
