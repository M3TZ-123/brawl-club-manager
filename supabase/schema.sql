-- Brawl Stars Club Manager Database Schema
-- Run this in your Supabase SQL Editor

-- Members table (current state)
CREATE TABLE IF NOT EXISTS members (
  player_tag VARCHAR(20) PRIMARY KEY,
  player_name VARCHAR(50) NOT NULL,
  icon_id INT,
  role VARCHAR(20) DEFAULT 'member',
  trophies INT DEFAULT 0,
  highest_trophies INT DEFAULT 0,
  exp_level INT DEFAULT 1,
  rank_current VARCHAR(30),
  rank_highest VARCHAR(30),
  win_rate INT,
  brawlers_count INT DEFAULT 0,
  solo_victories INT DEFAULT 0,
  duo_victories INT DEFAULT 0,
  trio_victories INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration: Add icon_id column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'members' AND column_name = 'icon_id') THEN
    ALTER TABLE members ADD COLUMN icon_id INT;
  END IF;
END $$;

-- Migration: Add win_rate column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'members' AND column_name = 'win_rate') THEN
    ALTER TABLE members ADD COLUMN win_rate INT;
  END IF;
END $$;

-- Activity log table
CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  player_tag VARCHAR(20) NOT NULL,
  trophies INT NOT NULL,
  trophy_change INT DEFAULT 0,
  activity_type VARCHAR(20) DEFAULT 'inactive',
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT fk_player FOREIGN KEY (player_tag) REFERENCES members(player_tag) ON DELETE CASCADE
);

-- Club events table
CREATE TABLE IF NOT EXISTS club_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(20) NOT NULL,
  player_tag VARCHAR(20) NOT NULL,
  player_name VARCHAR(50) NOT NULL,
  event_time TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Member history table (for tracking joins/leaves)
CREATE TABLE IF NOT EXISTS member_history (
  player_tag VARCHAR(20) PRIMARY KEY,
  player_name VARCHAR(50) NOT NULL,
  first_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_left_at TIMESTAMP WITH TIME ZONE,
  times_joined INT DEFAULT 1,
  times_left INT DEFAULT 0,
  is_current_member BOOLEAN DEFAULT true,
  role_at_leave VARCHAR(20),
  trophies_at_leave INT,
  notes TEXT
);

-- Migration: Add leave snapshot columns if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'member_history' AND column_name = 'last_left_at') THEN
    ALTER TABLE member_history ADD COLUMN last_left_at TIMESTAMP WITH TIME ZONE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'member_history' AND column_name = 'role_at_leave') THEN
    ALTER TABLE member_history ADD COLUMN role_at_leave VARCHAR(20);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'member_history' AND column_name = 'trophies_at_leave') THEN
    ALTER TABLE member_history ADD COLUMN trophies_at_leave INT;
  END IF;
END $$;

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(50) PRIMARY KEY,
  value TEXT NOT NULL
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_activity_log_player ON activity_log(player_tag);
CREATE INDEX IF NOT EXISTS idx_activity_log_time ON activity_log(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_club_events_time ON club_events(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_members_trophies ON members(trophies DESC);
CREATE INDEX IF NOT EXISTS idx_member_history_current ON member_history(is_current_member);

-- Enable Row Level Security (optional, for public access)
-- ALTER TABLE members ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE club_events ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE member_history ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Create policies for public read access (adjust as needed)
-- CREATE POLICY "Allow public read" ON members FOR SELECT USING (true);
-- CREATE POLICY "Allow public read" ON activity_log FOR SELECT USING (true);
-- CREATE POLICY "Allow public read" ON club_events FOR SELECT USING (true);
-- CREATE POLICY "Allow public read" ON member_history FOR SELECT USING (true);

-- Function to clean old activity logs (keep last 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_activity_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM activity_log
  WHERE recorded_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- ENHANCED TRACKING TABLES (brawltime.ninja style)
-- =============================================

-- Battle history table (stores individual battles)
CREATE TABLE IF NOT EXISTS battle_history (
  id SERIAL PRIMARY KEY,
  player_tag VARCHAR(20) NOT NULL,
  battle_time TIMESTAMP WITH TIME ZONE NOT NULL,
  mode VARCHAR(50),
  map VARCHAR(100),
  result VARCHAR(20), -- victory, defeat, draw
  trophy_change INT DEFAULT 0,
  is_star_player BOOLEAN DEFAULT false,
  brawler_name VARCHAR(50),
  brawler_power INT,
  brawler_trophies INT,
  teams_json JSONB,
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(player_tag, battle_time)
);

-- Migration: Add teams_json column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'battle_history' AND column_name = 'teams_json') THEN
    ALTER TABLE battle_history ADD COLUMN teams_json JSONB;
  END IF;
END $$;

-- Player tracking stats (accumulated stats over time)
CREATE TABLE IF NOT EXISTS player_tracking (
  player_tag VARCHAR(20) PRIMARY KEY,
  -- Battle stats (last 28 days)
  total_battles INT DEFAULT 0,
  total_wins INT DEFAULT 0,
  total_losses INT DEFAULT 0,
  star_player_count INT DEFAULT 0,
  trophies_gained INT DEFAULT 0,
  trophies_lost INT DEFAULT 0,
  -- Activity tracking
  active_days INT DEFAULT 0,
  current_streak INT DEFAULT 0,
  best_streak INT DEFAULT 0,
  peak_day_battles INT DEFAULT 0,
  last_battle_date DATE,
  -- Brawler tracking
  power_ups INT DEFAULT 0,
  unlocks INT DEFAULT 0,
  -- Tracking info
  tracking_started TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Brawler snapshots (to track power ups and unlocks)
CREATE TABLE IF NOT EXISTS brawler_snapshots (
  id SERIAL PRIMARY KEY,
  player_tag VARCHAR(20) NOT NULL,
  brawler_id INT NOT NULL,
  brawler_name VARCHAR(50) NOT NULL,
  power_level INT DEFAULT 1,
  trophies INT DEFAULT 0,
  rank INT DEFAULT 1,
  gadgets_count INT DEFAULT 0,
  star_powers_count INT DEFAULT 0,
  gears_count INT DEFAULT 0,
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(player_tag, brawler_id, recorded_at::date)
);

-- Daily stats aggregation (for historical tracking)
CREATE TABLE IF NOT EXISTS daily_stats (
  id SERIAL PRIMARY KEY,
  player_tag VARCHAR(20) NOT NULL,
  date DATE NOT NULL,
  battles INT DEFAULT 0,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  star_player INT DEFAULT 0,
  trophies_gained INT DEFAULT 0,
  trophies_lost INT DEFAULT 0,
  UNIQUE(player_tag, date)
);

-- Indexes for new tables
CREATE INDEX IF NOT EXISTS idx_battle_history_player ON battle_history(player_tag);
CREATE INDEX IF NOT EXISTS idx_battle_history_time ON battle_history(battle_time DESC);
CREATE INDEX IF NOT EXISTS idx_brawler_snapshots_player ON brawler_snapshots(player_tag);
CREATE INDEX IF NOT EXISTS idx_daily_stats_player_date ON daily_stats(player_tag, date DESC);

-- Function to clean old battle history (keep last 60 days)
CREATE OR REPLACE FUNCTION cleanup_old_battles()
RETURNS void AS $$
BEGIN
  DELETE FROM battle_history
  WHERE battle_time < NOW() - INTERVAL '60 days';
  
  DELETE FROM daily_stats
  WHERE date < NOW() - INTERVAL '60 days';
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- NOTIFICATIONS TABLE
-- =============================================

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  type VARCHAR(30) NOT NULL,            -- join, leave, inactive, sync_error, milestone
  title VARCHAR(100) NOT NULL,
  message TEXT NOT NULL,
  player_tag VARCHAR(20),               -- optional, related player
  player_name VARCHAR(50),              -- optional, related player name
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_time ON notifications(created_at DESC);

-- Clean old notifications (keep last 90 days)
CREATE OR REPLACE FUNCTION cleanup_old_notifications()
RETURNS void AS $$
BEGIN
  DELETE FROM notifications
  WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;
