-- Add NFL Games table for storing game schedules and real-time scoring
CREATE TABLE IF NOT EXISTS nfl_games (
    game_id VARCHAR(50) PRIMARY KEY,
    week INTEGER NOT NULL,
    season INTEGER NOT NULL,
    home_team VARCHAR(10) NOT NULL,
    away_team VARCHAR(10) NOT NULL,
    home_score INTEGER DEFAULT 0,
    away_score INTEGER DEFAULT 0,
    game_date DATETIME,
    game_time VARCHAR(20),
    status VARCHAR(20) DEFAULT 'Scheduled',
    quarter VARCHAR(10),
    time_remaining VARCHAR(20),
    venue VARCHAR(100),
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Indexes for common queries
    INDEX idx_week_season (week, season),
    INDEX idx_status (status),
    INDEX idx_game_date (game_date),
    INDEX idx_teams (home_team, away_team)
);

-- Add a view for easier querying of current week games
CREATE VIEW IF NOT EXISTS current_week_games AS
SELECT 
    game_id,
    week,
    season,
    home_team,
    away_team,
    home_score,
    away_score,
    game_date,
    game_time,
    status,
    quarter,
    time_remaining,
    venue,
    last_updated,
    CASE 
        WHEN status = 'Final' THEN 1 
        ELSE 0 
    END as is_complete
FROM nfl_games 
WHERE season = (SELECT season_year FROM league_settings WHERE league_id = 1)
  AND week = (SELECT current_week FROM league_settings WHERE league_id = 1);