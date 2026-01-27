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
    };
  };
}

export type Member = Database["public"]["Tables"]["members"]["Row"];
export type ActivityLog = Database["public"]["Tables"]["activity_log"]["Row"];
export type ClubEvent = Database["public"]["Tables"]["club_events"]["Row"];
export type MemberHistory = Database["public"]["Tables"]["member_history"]["Row"];
export type Settings = Database["public"]["Tables"]["settings"]["Row"];
