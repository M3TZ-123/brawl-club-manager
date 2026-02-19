import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AppState {
  // Club info
  clubTag: string;
  clubName: string;
  apiKey: string;
  
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

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Initial state
      clubTag: "",
      clubName: "",
      apiKey: "",
      lastSyncTime: null,
      isSyncing: false,
      isLoadingSettings: true,
      hasLoadedSettings: false,
      theme: "dark",
      sidebarOpen: true,
      inactivityThreshold: 24,
      refreshInterval: 60, // 1 hour
      notificationsEnabled: true,
      discordWebhook: "",
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
              apiKey: settings.api_key || get().apiKey || "",
              inactivityThreshold: settings.inactivity_threshold ? parseInt(settings.inactivity_threshold) : get().inactivityThreshold,
              refreshInterval: settings.refresh_interval ? parseInt(settings.refresh_interval) : get().refreshInterval,
              notificationsEnabled: settings.notifications_enabled === "true",
              discordWebhook: settings.discord_webhook || get().discordWebhook || "",
              requiredTrophies: settings.required_trophies ? parseInt(settings.required_trophies) : get().requiredTrophies,
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
          const payload: Record<string, string> = {
            club_tag: state.clubTag,
            club_name: state.clubName,
            api_key: state.apiKey,
            inactivity_threshold: String(state.inactivityThreshold),
            refresh_interval: String(state.refreshInterval),
            notifications_enabled: String(state.notificationsEnabled),
            discord_webhook: state.discordWebhook,
            last_sync_time: state.lastSyncTime || "",
          };

          if (state.requiredTrophies != null && Number.isFinite(state.requiredTrophies)) {
            payload.required_trophies = String(state.requiredTrophies);
          }

          await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        } catch (error) {
          console.error("Failed to save settings to DB:", error);
        }
      },
    }),
    {
      name: "brawl-club-manager-storage",
      partialize: (state) => ({
        theme: state.theme,
        sidebarOpen: state.sidebarOpen,
        lastSyncTime: state.lastSyncTime,
      }),
    }
  )
);
