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
      player_profile_details: { Row: PlayerProfileDetails; Insert: never; Update: never };
      player_brawler_details: { Row: PlayerBrawlerDetails; Insert: never; Update: never };
      player_ranked_history: { Row: PlayerRankedHistory; Insert: never; Update: never };
      members: {
        Row: {
          player_tag: string;
          player_name: string;
          icon_id: number | null;
          role: string;
          trophies: number;
          highest_trophies: number;
          exp_level: number;
          rank_current: string | null;
          rank_highest: string | null;
          ranked_season_id: number | null;
          ranked_points: number | null;
          ranked_season_best: string | null;
          ranked_season_best_points: number | null;
          ranked_all_time_best_points: number | null;
          ranked_checked_at: string | null;
          ranked_source: string | null;
          ranked_provenance: Json | null;
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
          icon_id?: number | null;
          role?: string;
          trophies?: number;
          highest_trophies?: number;
          exp_level?: number;
          rank_current?: string | null;
          rank_highest?: string | null;
          ranked_season_id?: number | null;
          ranked_points?: number | null;
          ranked_season_best?: string | null;
          ranked_season_best_points?: number | null;
          ranked_all_time_best_points?: number | null;
          ranked_checked_at?: string | null;
          ranked_source?: string | null;
          ranked_provenance?: Json | null;
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
          icon_id?: number | null;
          role?: string;
          trophies?: number;
          highest_trophies?: number;
          exp_level?: number;
          rank_current?: string | null;
          rank_highest?: string | null;
          ranked_season_id?: number | null;
          ranked_points?: number | null;
          ranked_season_best?: string | null;
          ranked_season_best_points?: number | null;
          ranked_all_time_best_points?: number | null;
          ranked_checked_at?: string | null;
          ranked_source?: string | null;
          ranked_provenance?: Json | null;
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
          last_left_at: string | null;
          times_joined: number;
          times_left: number;
          is_current_member: boolean;
          role_at_leave: string | null;
          trophies_at_leave: number | null;
          notes: string | null;
          review_updated_at?: string | null;
        };
        Insert: {
          player_tag: string;
          player_name: string;
          first_seen?: string;
          last_seen?: string;
          last_left_at?: string | null;
          times_joined?: number;
          times_left?: number;
          is_current_member?: boolean;
          role_at_leave?: string | null;
          trophies_at_leave?: number | null;
          notes?: string | null;
        };
        Update: {
          player_tag?: string;
          player_name?: string;
          first_seen?: string;
          last_seen?: string;
          last_left_at?: string | null;
          times_joined?: number;
          times_left?: number;
          is_current_member?: boolean;
          role_at_leave?: string | null;
          trophies_at_leave?: number | null;
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
          duration_seconds: number | null;
          trophy_change_reported: boolean | null;
          battle_type: string | null;
          event_id: number | null;
          event_mode_id: number | null;
          battle_mode: string | null;
          event_mode: string | null;
          placement_rank: number | null;
          id: number;
          player_tag: string;
          battle_time: string;
          mode: string | null;
          map: string | null;
          result: string | null;
          trophy_change: number | null;
          is_star_player: boolean;
          brawler_name: string | null;
          brawler_power: number | null;
          brawler_trophies: number | null;
          teams_json: Json | null;
          recorded_at: string;
        };
        Insert: {
          trophy_change_reported?: boolean | null;
          battle_type?: string | null;
          event_id?: number | null;
          event_mode_id?: number | null;
          duration_seconds?: number | null;
          battle_mode?: string | null;
          event_mode?: string | null;
          placement_rank?: number | null;
          id?: number;
          player_tag: string;
          battle_time: string;
          mode?: string | null;
          map?: string | null;
          result?: string | null;
          trophy_change?: number | null;
          is_star_player?: boolean;
          brawler_name?: string | null;
          brawler_power?: number | null;
          brawler_trophies?: number | null;
          teams_json?: Json | null;
          recorded_at?: string;
        };
        Update: {
          trophy_change_reported?: boolean | null;
          battle_type?: string | null;
          event_id?: number | null;
          event_mode_id?: number | null;
          duration_seconds?: number | null;
          battle_mode?: string | null;
          event_mode?: string | null;
          placement_rank?: number | null;
          id?: number;
          player_tag?: string;
          battle_time?: string;
          mode?: string | null;
          map?: string | null;
          result?: string | null;
          trophy_change?: number | null;
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
          dedupe_key: string;
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
          dedupe_key: string;
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
          dedupe_key?: string;
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
export type MemberHistory = Database["public"]["Tables"]["member_history"]["Row"] & {
  latest_membership_event?: {
    type: "join" | "leave" | "initial_seen";
    at: string;
    source: "recorded" | "reconstructed" | "unknown";
  } | null;
};
export type Settings = Database["public"]["Tables"]["settings"]["Row"];
export type BattleHistory = Database["public"]["Tables"]["battle_history"]["Row"];
export type PlayerTracking = Database["public"]["Tables"]["player_tracking"]["Row"];
export type DailyStats = Database["public"]["Tables"]["daily_stats"]["Row"];
export type BrawlerSnapshot = Database["public"]["Tables"]["brawler_snapshots"]["Row"];
export type Notification = Database["public"]["Tables"]["notifications"]["Row"];

export interface PlayerProfileDetails {
  player_tag: string; exp_points: number | null; total_prestige_level: number | null;
  fame: number | null; fame_tier_name: string | null; observed_at: string; field_checked_at: Json;
}
export interface PlayerBrawlerDetails {
  player_tag: string; brawler_id: number; brawler_name: string; power_level: number; trophies: number; rank: number | null;
  highest_trophies: number | null; prestige_level: number | null; current_win_streak: number | null; max_win_streak: number | null;
  skin: Json | null; gadgets: Json | null; star_powers: Json | null; gears: Json | null; hyper_charges: Json | null; buffies: Json | null;
  observed_at: string; field_checked_at: Json;
}
export interface PlayerRankedHistory {
  id: number; player_tag: string; run_id: string; observed_at: string; kind: "initial" | "change" | "season_reset";
  season_id: number | null; current_rank: string | null; points: number | null; season_best: string | null; season_best_points: number | null;
  all_time_best: string | null; all_time_best_points: number | null; source: string | null; provenance: Json;
}
