-- Single league configuration
CREATE TABLE IF NOT EXISTS league_settings (
    league_id INTEGER PRIMARY KEY DEFAULT 1,
    league_name VARCHAR(100) NOT NULL DEFAULT 'StatFink Fantasy League',
    max_teams INTEGER DEFAULT 12,
    roster_size INTEGER DEFAULT 16,
    starting_lineup_size INTEGER DEFAULT 9,
    scoring_type VARCHAR(20) DEFAULT 'ppr',
    season_year INTEGER DEFAULT 2024,
    current_week INTEGER DEFAULT 1
);

-- Teams in the league
CREATE TABLE IF NOT EXISTS teams (
    team_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_name VARCHAR(100) NOT NULL,
    owner_name VARCHAR(100) NOT NULL,
    total_points REAL DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    ties INTEGER DEFAULT 0
);

-- NFL Players (includes offensive players, kickers, and team defenses)
CREATE TABLE IF NOT EXISTS nfl_players (
    player_id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    position VARCHAR(10) NOT NULL,
    team VARCHAR(10) NOT NULL,
    bye_week INTEGER,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Fantasy Rosters
CREATE TABLE IF NOT EXISTS fantasy_rosters (
    roster_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    player_id VARCHAR(50) NOT NULL,
    roster_position VARCHAR(20) DEFAULT 'starter',
    acquisition_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    FOREIGN KEY (player_id) REFERENCES nfl_players(player_id),
    UNIQUE(team_id, player_id)
);

-- Player Stats by Week
CREATE TABLE IF NOT EXISTS player_stats (
    stat_id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id VARCHAR(50) NOT NULL,
    week INTEGER NOT NULL,
    season INTEGER NOT NULL,
    -- Offensive stats
    passing_yards INTEGER DEFAULT 0,
    passing_tds INTEGER DEFAULT 0,
    interceptions INTEGER DEFAULT 0,
    rushing_yards INTEGER DEFAULT 0,
    rushing_tds INTEGER DEFAULT 0,
    receiving_yards INTEGER DEFAULT 0,
    receiving_tds INTEGER DEFAULT 0,
    receptions INTEGER DEFAULT 0,
    fumbles INTEGER DEFAULT 0,
    -- Defensive stats (for Defense)
    sacks INTEGER DEFAULT 0,
    def_interceptions INTEGER DEFAULT 0,
    fumbles_recovered INTEGER DEFAULT 0,
    def_touchdowns INTEGER DEFAULT 0,
    safeties INTEGER DEFAULT 0,
    points_allowed INTEGER DEFAULT 0,
    yards_allowed INTEGER DEFAULT 0,
    -- Kicking stats
    field_goals_made INTEGER DEFAULT 0,
    field_goals_attempted INTEGER DEFAULT 0,
    extra_points_made INTEGER DEFAULT 0,
    extra_points_attempted INTEGER DEFAULT 0,
    field_goals_0_39 INTEGER DEFAULT 0,
    field_goals_40_49 INTEGER DEFAULT 0,
    field_goals_50_plus INTEGER DEFAULT 0,
    -- Calculated
    fantasy_points REAL DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES nfl_players(player_id),
    UNIQUE(player_id, week, season)
);

-- Weekly Matchups
CREATE TABLE IF NOT EXISTS matchups (
    matchup_id INTEGER PRIMARY KEY AUTOINCREMENT,
    week INTEGER NOT NULL,
    season INTEGER NOT NULL,
    team1_id INTEGER NOT NULL,
    team2_id INTEGER NOT NULL,
    team1_points REAL DEFAULT 0,
    team2_points REAL DEFAULT 0,
    is_complete BOOLEAN DEFAULT 0,
    FOREIGN KEY (team1_id) REFERENCES teams(team_id),
    FOREIGN KEY (team2_id) REFERENCES teams(team_id)
);

-- Scoring Rules (PPR by default)
CREATE TABLE IF NOT EXISTS scoring_rules (
    rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_type VARCHAR(50) NOT NULL UNIQUE,
    points_per_unit REAL NOT NULL
);

-- Insert default PPR scoring rules
INSERT OR IGNORE INTO scoring_rules (stat_type, points_per_unit) VALUES 
    -- Offensive scoring
    ('passing_yards', 0.04),
    ('passing_tds', 4),
    ('interceptions', -2),
    ('rushing_yards', 0.1),
    ('rushing_tds', 6),
    ('receiving_yards', 0.1),
    ('receiving_tds', 6),
    ('receptions', 1),
    ('fumbles', -2),
    -- Defensive scoring
    ('sacks', 1),
    ('def_interceptions', 2),
    ('fumbles_recovered', 2),
    ('def_touchdowns', 6),
    ('safeties', 2),
    -- Kicking scoring
    ('extra_points_made', 1),
    ('field_goals_0_39', 3),
    ('field_goals_40_49', 4),
    ('field_goals_50_plus', 5),
    ('field_goals_missed', -1);


-- Tank01 API Cache
CREATE TABLE IF NOT EXISTS tank01_cache (
    cache_key VARCHAR(255) PRIMARY KEY,
    endpoint VARCHAR(100) NOT NULL,
    params TEXT, -- JSON string of parameters
    response_data TEXT NOT NULL, -- JSON string of response
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME, -- NULL for permanent cache
    is_historical BOOLEAN DEFAULT 0, -- 1 for historical data that never expires
    hit_count INTEGER DEFAULT 0,
    last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tank01 Daily Request Stats
CREATE TABLE IF NOT EXISTS tank01_daily_stats (
    date TEXT PRIMARY KEY,
    requests INTEGER DEFAULT 0,
    last_reset TEXT
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_player_stats_lookup ON player_stats(player_id, week, season);
CREATE INDEX IF NOT EXISTS idx_fantasy_rosters_team ON fantasy_rosters(team_id);
CREATE INDEX IF NOT EXISTS idx_matchups_week ON matchups(week, season);
CREATE INDEX IF NOT EXISTS idx_nfl_players_position ON nfl_players(position);

-- Create indexes for tank01_cache
CREATE INDEX IF NOT EXISTS idx_tank01_cache_expires ON tank01_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_tank01_cache_endpoint ON tank01_cache(endpoint);
CREATE INDEX IF NOT EXISTS idx_tank01_cache_historical ON tank01_cache(is_historical);