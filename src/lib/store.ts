import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Member, ActivityLog, ClubEvent, MemberHistory } from "@/types/database";

interface AppState {
  // Club info
  clubTag: string;
  clubName: string;
  apiKey: string;
  
  // Data
  members: Member[];
  activityLogs: ActivityLog[];
  clubEvents: ClubEvent[];
  memberHistory: MemberHistory[];
  
  // UI State
  lastSyncTime: string | null;
  isSyncing: boolean;
  theme: "light" | "dark";
  
  // Settings
  inactivityThreshold: number; // hours
  refreshInterval: number; // minutes
  notificationsEnabled: boolean;
  discordWebhook: string;
  
  // Actions
  setClubTag: (tag: string) => void;
  setClubName: (name: string) => void;
  setApiKey: (key: string) => void;
  setMembers: (members: Member[]) => void;
  setActivityLogs: (logs: ActivityLog[]) => void;
  setClubEvents: (events: ClubEvent[]) => void;
  setMemberHistory: (history: MemberHistory[]) => void;
  setLastSyncTime: (time: string | null) => void;
  setIsSyncing: (syncing: boolean) => void;
  setTheme: (theme: "light" | "dark") => void;
  setInactivityThreshold: (hours: number) => void;
  setRefreshInterval: (minutes: number) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setDiscordWebhook: (webhook: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      // Initial state
      clubTag: "",
      clubName: "",
      apiKey: "",
      members: [],
      activityLogs: [],
      clubEvents: [],
      memberHistory: [],
      lastSyncTime: null,
      isSyncing: false,
      theme: "dark",
      inactivityThreshold: 24,
      refreshInterval: 240, // 4 hours
      notificationsEnabled: true,
      discordWebhook: "",
      
      // Actions
      setClubTag: (tag) => set({ clubTag: tag }),
      setClubName: (name) => set({ clubName: name }),
      setApiKey: (key) => set({ apiKey: key }),
      setMembers: (members) => set({ members }),
      setActivityLogs: (logs) => set({ activityLogs: logs }),
      setClubEvents: (events) => set({ clubEvents: events }),
      setMemberHistory: (history) => set({ memberHistory: history }),
      setLastSyncTime: (time) => set({ lastSyncTime: time }),
      setIsSyncing: (syncing) => set({ isSyncing: syncing }),
      setTheme: (theme) => set({ theme }),
      setInactivityThreshold: (hours) => set({ inactivityThreshold: hours }),
      setRefreshInterval: (minutes) => set({ refreshInterval: minutes }),
      setNotificationsEnabled: (enabled) => set({ notificationsEnabled: enabled }),
      setDiscordWebhook: (webhook) => set({ discordWebhook: webhook }),
    }),
    {
      name: "brawl-club-manager-storage",
      partialize: (state) => ({
        clubTag: state.clubTag,
        clubName: state.clubName,
        apiKey: state.apiKey,
        theme: state.theme,
        inactivityThreshold: state.inactivityThreshold,
        refreshInterval: state.refreshInterval,
        notificationsEnabled: state.notificationsEnabled,
        discordWebhook: state.discordWebhook,
        lastSyncTime: state.lastSyncTime,
      }),
    }
  )
);
