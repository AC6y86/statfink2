-- Add weekly roster tracking table
-- This table will store a snapshot of each team's roster for each week
CREATE TABLE IF NOT EXISTS weekly_rosters (
    weekly_roster_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    player_id VARCHAR(50) NOT NULL,
    week INTEGER NOT NULL,
    season INTEGER NOT NULL,
    roster_position VARCHAR(20) NOT NULL, -- 'starter', 'bench', 'injured_reserve'
    player_name VARCHAR(100) NOT NULL, -- Denormalized for historical accuracy
    player_position VARCHAR(10) NOT NULL, -- Denormalized for historical accuracy
    player_team VARCHAR(10) NOT NULL, -- Denormalized for historical accuracy
    snapshot_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    FOREIGN KEY (player_id) REFERENCES nfl_players(player_id),
    UNIQUE(team_id, player_id, week, season)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_weekly_rosters_team_week ON weekly_rosters(team_id, week, season);
CREATE INDEX IF NOT EXISTS idx_weekly_rosters_week ON weekly_rosters(week, season);
CREATE INDEX IF NOT EXISTS idx_weekly_rosters_player ON weekly_rosters(player_id, week, season);

-- Add a column to track when roster snapshots were last taken
ALTER TABLE league_settings ADD COLUMN last_roster_snapshot_week INTEGER DEFAULT 0;