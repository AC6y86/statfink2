-- Single league configuration
CREATE TABLE IF NOT EXISTS league_settings (
    league_id INTEGER PRIMARY KEY DEFAULT 1,
    league_name VARCHAR(100) NOT NULL DEFAULT 'StatFink Fantasy League',
    max_teams INTEGER DEFAULT 12,
    roster_size INTEGER DEFAULT 16,
    starting_lineup_size INTEGER DEFAULT 9,
    scoring_type VARCHAR(20) DEFAULT 'pfl',
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

-- Scoring Rules (PFL by default)
CREATE TABLE IF NOT EXISTS scoring_rules (
    rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_type VARCHAR(50) NOT NULL UNIQUE,
    points_per_unit REAL NOT NULL
);

-- Custom scoring rules will be inserted separately

-- Weekly Roster Snapshots for Historical Tracking
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
CREATE INDEX IF NOT EXISTS idx_player_stats_lookup ON player_stats(player_id, week, season);
CREATE INDEX IF NOT EXISTS idx_fantasy_rosters_team ON fantasy_rosters(team_id);
CREATE INDEX IF NOT EXISTS idx_matchups_week ON matchups(week, season);
CREATE INDEX IF NOT EXISTS idx_nfl_players_position ON nfl_players(position);
CREATE INDEX IF NOT EXISTS idx_weekly_rosters_team_week ON weekly_rosters(team_id, week, season);
CREATE INDEX IF NOT EXISTS idx_weekly_rosters_week ON weekly_rosters(week, season);
CREATE INDEX IF NOT EXISTS idx_weekly_rosters_player ON weekly_rosters(player_id, week, season);