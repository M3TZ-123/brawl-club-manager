export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      members: {
        Row: {
          player_tag: string;
          player_name: string;
          role: string;
          trophies: number;
          highest_trophies: number;
          exp_level: number;
          rank_current: string | null;
          rank_highest: string | null;
          win_rate: number | null;
          brawlers_count: number;
          solo_victories: number;
          duo_victories: number;
          trio_victories: number;
          is_active: boolean;
          last_updated: string;
        };
        Insert: {
          player_tag: string;
          player_name: string;
          role?: string;
          trophies?: number;
          highest_trophies?: number;
          exp_level?: number;
          rank_current?: string | null;
          rank_highest?: string | null;
          win_rate?: number | null;
          brawlers_count?: number;
          solo_victories?: number;
          duo_victories?: number;
          trio_victories?: number;
          is_active?: boolean;
          last_updated?: string;
        };
        Update: {
          player_tag?: string;
          player_name?: string;
          role?: string;
          trophies?: number;
          highest_trophies?: number;
          exp_level?: number;
          rank_current?: string | null;
          rank_highest?: string | null;
          win_rate?: number | null;
          brawlers_count?: number;
          solo_victories?: number;
          duo_victories?: number;
          trio_victories?: number;
          is_active?: boolean;
          last_updated?: string;
        };
      };
      activity_log: {
        Row: {
          id: number;
          player_tag: string;
          trophies: number;
          trophy_change: number;
          activity_type: string;
          recorded_at: string;
        };
        Insert: {
          id?: number;
          player_tag: string;
          trophies: number;
          trophy_change?: number;
          activity_type?: string;
          recorded_at?: string;
        };
        Update: {
          id?: number;
          player_tag?: string;
          trophies?: number;
          trophy_change?: number;
          activity_type?: string;
          recorded_at?: string;
        };
      };
      club_events: {
        Row: {
          id: number;
          event_type: string;
          player_tag: string;
          player_name: string;
          event_time: string;
        };
        Insert: {
          id?: number;
          event_type: string;
          player_tag: string;
          player_name: string;
          event_time?: string;
        };
        Update: {
          id?: number;
          event_type?: string;
          player_tag?: string;
          player_name?: string;
          event_time?: string;
        };
      };
      member_history: {
        Row: {
          player_tag: string;
          player_name: string;
          first_seen: string;
          last_seen: string;
          times_joined: number;
          times_left: number;
          is_current_member: boolean;
          notes: string | null;
        };
        Insert: {
          player_tag: string;
          player_name: string;
          first_seen?: string;
          last_seen?: string;
          times_joined?: number;
          times_left?: number;
          is_current_member?: boolean;
          notes?: string | null;
        };
        Update: {
          player_tag?: string;
          player_name?: string;
          first_seen?: string;
          last_seen?: string;
          times_joined?: number;
          times_left?: number;
          is_current_member?: boolean;
          notes?: string | null;
        };
      };
      settings: {
        Row: {
          key: string;
          value: string;
        };
        Insert: {
          key: string;
          value: string;
        };
        Update: {
          key?: string;
          value?: string;
        };
      };
      battle_history: {
        Row: {
          id: number;
          player_tag: string;
          battle_time: string;
          mode: string | null;
          map: string | null;
          result: string | null;
          trophy_change: number;
          is_star_player: boolean;
          brawler_name: string | null;
          brawler_power: number | null;
          brawler_trophies: number | null;
          teams_json: Json | null;
          recorded_at: string;
        };
        Insert: {
          id?: number;
          player_tag: string;
          battle_time: string;
          mode?: string | null;
          map?: string | null;
          result?: string | null;
          trophy_change?: number;
          is_star_player?: boolean;
          brawler_name?: string | null;
          brawler_power?: number | null;
          brawler_trophies?: number | null;
          teams_json?: Json | null;
          recorded_at?: string;
        };
        Update: {
          id?: number;
          player_tag?: string;
          battle_time?: string;
          mode?: string | null;
          map?: string | null;
          result?: string | null;
          trophy_change?: number;
          is_star_player?: boolean;
          brawler_name?: string | null;
          brawler_power?: number | null;
          brawler_trophies?: number | null;
          teams_json?: Json | null;
          recorded_at?: string;
        };
      };
      player_tracking: {
        Row: {
          player_tag: string;
          total_battles: number;
          total_wins: number;
          total_losses: number;
          star_player_count: number;
          trophies_gained: number;
          trophies_lost: number;
          active_days: number;
          current_streak: number;
          best_streak: number;
          peak_day_battles: number;
          last_battle_date: string | null;
          power_ups: number;
          unlocks: number;
          tracking_started: string;
          last_updated: string;
        };
        Insert: {
          player_tag: string;
          total_battles?: number;
          total_wins?: number;
          total_losses?: number;
          star_player_count?: number;
          trophies_gained?: number;
          trophies_lost?: number;
          active_days?: number;
          current_streak?: number;
          best_streak?: number;
          peak_day_battles?: number;
          last_battle_date?: string | null;
          power_ups?: number;
          unlocks?: number;
          tracking_started?: string;
          last_updated?: string;
        };
        Update: {
          player_tag?: string;
          total_battles?: number;
          total_wins?: number;
          total_losses?: number;
          star_player_count?: number;
          trophies_gained?: number;
          trophies_lost?: number;
          active_days?: number;
          current_streak?: number;
          best_streak?: number;
          peak_day_battles?: number;
          last_battle_date?: string | null;
          power_ups?: number;
          unlocks?: number;
          tracking_started?: string;
          last_updated?: string;
        };
      };
      daily_stats: {
        Row: {
          id: number;
          player_tag: string;
          date: string;
          battles: number;
          wins: number;
          losses: number;
          star_player: number;
          trophies_gained: number;
          trophies_lost: number;
        };
        Insert: {
          id?: number;
          player_tag: string;
          date: string;
          battles?: number;
          wins?: number;
          losses?: number;
          star_player?: number;
          trophies_gained?: number;
          trophies_lost?: number;
        };
        Update: {
          id?: number;
          player_tag?: string;
          date?: string;
          battles?: number;
          wins?: number;
          losses?: number;
          star_player?: number;
          trophies_gained?: number;
          trophies_lost?: number;
        };
      };
      brawler_snapshots: {
        Row: {
          id: number;
          player_tag: string;
          brawler_id: number;
          brawler_name: string;
          power_level: number;
          trophies: number;
          rank: number;
          gadgets_count: number;
          star_powers_count: number;
          gears_count: number;
          recorded_at: string;
        };
        Insert: {
          id?: number;
          player_tag: string;
          brawler_id: number;
          brawler_name: string;
          power_level?: number;
          trophies?: number;
          rank?: number;
          gadgets_count?: number;
          star_powers_count?: number;
          gears_count?: number;
          recorded_at?: string;
        };
        Update: {
          id?: number;
          player_tag?: string;
          brawler_id?: number;
          brawler_name?: string;
          power_level?: number;
          trophies?: number;
          rank?: number;
          gadgets_count?: number;
          star_powers_count?: number;
          gears_count?: number;
          recorded_at?: string;
        };
      };
      notifications: {
        Row: {
          id: number;
          type: string;
          title: string;
          message: string;
          player_tag: string | null;
          player_name: string | null;
          is_read: boolean;
          created_at: string;
        };
        Insert: {
          id?: number;
          type: string;
          title: string;
          message: string;
          player_tag?: string | null;
          player_name?: string | null;
          is_read?: boolean;
          created_at?: string;
        };
        Update: {
          id?: number;
          type?: string;
          title?: string;
          message?: string;
          player_tag?: string | null;
          player_name?: string | null;
          is_read?: boolean;
          created_at?: string;
        };
      };
    };
  };
}

export type Member = Database["public"]["Tables"]["members"]["Row"];
export type ActivityLog = Database["public"]["Tables"]["activity_log"]["Row"];
export type ClubEvent = Database["public"]["Tables"]["club_events"]["Row"];
export type MemberHistory = Database["public"]["Tables"]["member_history"]["Row"];
export type Settings = Database["public"]["Tables"]["settings"]["Row"];
export type BattleHistory = Database["public"]["Tables"]["battle_history"]["Row"];
export type PlayerTracking = Database["public"]["Tables"]["player_tracking"]["Row"];
export type DailyStats = Database["public"]["Tables"]["daily_stats"]["Row"];
export type BrawlerSnapshot = Database["public"]["Tables"]["brawler_snapshots"]["Row"];
export type Notification = Database["public"]["Tables"]["notifications"]["Row"];
