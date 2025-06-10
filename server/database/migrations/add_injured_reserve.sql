-- Add injured reserve support to the fantasy_rosters table
-- This migration updates the roster_position column to allow 'injured_reserve' as a valid value

-- First, let's check the current constraint on roster_position
-- SQLite doesn't support ALTER COLUMN, so we need to recreate the table

-- Create a new table with the updated constraint
CREATE TABLE fantasy_rosters_new (
    roster_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    player_id VARCHAR(50) NOT NULL,
    roster_position VARCHAR(20) DEFAULT 'bench' CHECK (roster_position IN ('starter', 'bench', 'injured_reserve')),
    acquisition_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    FOREIGN KEY (player_id) REFERENCES nfl_players(player_id),
    UNIQUE(team_id, player_id)
);

-- Copy data from the old table
INSERT INTO fantasy_rosters_new (roster_id, team_id, player_id, roster_position, acquisition_date)
SELECT roster_id, team_id, player_id, roster_position, acquisition_date
FROM fantasy_rosters;

-- Drop the old table
DROP TABLE fantasy_rosters;

-- Rename the new table
ALTER TABLE fantasy_rosters_new RENAME TO fantasy_rosters;

-- Recreate the index
CREATE INDEX idx_fantasy_rosters_team ON fantasy_rosters(team_id);