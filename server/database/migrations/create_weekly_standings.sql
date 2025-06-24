-- Create weekly_standings table to track standings for each week
CREATE TABLE IF NOT EXISTS weekly_standings (
    standings_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    week INTEGER NOT NULL,
    season INTEGER NOT NULL,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    ties INTEGER DEFAULT 0,
    points_for_week REAL DEFAULT 0,
    cumulative_points REAL DEFAULT 0,
    weekly_rank INTEGER,  -- 1-12 based on points for the week (1 = weekly winner)
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    UNIQUE(team_id, week, season)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_weekly_standings_week_season ON weekly_standings(week, season);
CREATE INDEX IF NOT EXISTS idx_weekly_standings_team_season ON weekly_standings(team_id, season);
CREATE INDEX IF NOT EXISTS idx_weekly_standings_rank ON weekly_standings(weekly_rank, season);