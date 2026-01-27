-- Brawl Stars Club Manager Database Schema
-- Run this in your Supabase SQL Editor

-- Members table (current state)
CREATE TABLE IF NOT EXISTS members (
  player_tag VARCHAR(20) PRIMARY KEY,
  player_name VARCHAR(50) NOT NULL,
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
  times_joined INT DEFAULT 1,
  times_left INT DEFAULT 0,
  is_current_member BOOLEAN DEFAULT true,
  notes TEXT
);

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
