-- Add columns to track scoring players
-- Run this migration to update the database schema

-- Add is_scoring flag to weekly_rosters
ALTER TABLE weekly_rosters ADD COLUMN is_scoring INTEGER DEFAULT 0;

-- Add scoring_slot to track which position slot (optional, for future use)
ALTER TABLE weekly_rosters ADD COLUMN scoring_slot VARCHAR(20);

-- Add scoring points columns to matchups table
ALTER TABLE matchups ADD COLUMN team1_scoring_points REAL DEFAULT 0;
ALTER TABLE matchups ADD COLUMN team2_scoring_points REAL DEFAULT 0;

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_weekly_rosters_scoring ON weekly_rosters(week, season, team_id, is_scoring);