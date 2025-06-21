-- StatFink v1 2024 Historical Database Schema
-- Complete season recreation from PFL 2024.xlsx

-- Teams in the league
CREATE TABLE IF NOT EXISTS teams (
    team_id INTEGER PRIMARY KEY,
    owner_name VARCHAR(100) NOT NULL,
    team_name VARCHAR(100)
);

-- All players from the 2024 season
CREATE TABLE IF NOT EXISTS players (
    player_id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_name VARCHAR(100) NOT NULL,
    position VARCHAR(10) NOT NULL,  -- QB, RB, WR, TE, K, DEF
    nfl_team VARCHAR(10),
    UNIQUE(player_name, position, nfl_team)
);

-- Weekly player performance - core data table
CREATE TABLE IF NOT EXISTS weekly_player_performance (
    performance_id INTEGER PRIMARY KEY AUTOINCREMENT,
    week INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    fantasy_points REAL NOT NULL,
    DidScore BOOLEAN NOT NULL,  -- TRUE if player had "*" (contributed to team score)
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    FOREIGN KEY (player_id) REFERENCES players(player_id),
    UNIQUE(week, team_id, player_id)
);

-- Weekly team totals and records
CREATE TABLE IF NOT EXISTS weekly_team_totals (
    total_id INTEGER PRIMARY KEY AUTOINCREMENT,
    week INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    weekly_points REAL NOT NULL,      -- Points scored this week
    cumulative_points REAL NOT NULL,  -- Season total through this week
    wins INTEGER NOT NULL,
    losses INTEGER NOT NULL,
    ties INTEGER DEFAULT 0,
    is_playoff_week BOOLEAN DEFAULT 0, -- TRUE for weeks 13+
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    UNIQUE(week, team_id)
);

-- Head-to-head matchups (weeks 1-12 only)
CREATE TABLE IF NOT EXISTS matchups (
    matchup_id INTEGER PRIMARY KEY AUTOINCREMENT,
    week INTEGER NOT NULL,
    team1_id INTEGER NOT NULL,
    team2_id INTEGER NOT NULL,
    team1_points REAL NOT NULL,
    team2_points REAL NOT NULL,
    winner_team_id INTEGER,
    FOREIGN KEY (team1_id) REFERENCES teams(team_id),
    FOREIGN KEY (team2_id) REFERENCES teams(team_id),
    FOREIGN KEY (winner_team_id) REFERENCES teams(team_id),
    UNIQUE(week, team1_id, team2_id)
);

-- Insert the 12 teams (based on existing team mapping)
INSERT OR IGNORE INTO teams (team_id, owner_name) VALUES
    (1, 'Mitch'),
    (2, 'Cal'),
    (3, 'Eli'),
    (4, 'Chris'),
    (5, 'Mike'),
    (6, 'Joe'),
    (7, 'Dan'),
    (8, 'Aaron'),
    (9, 'Sean'),
    (10, 'Matt'),
    (11, 'Bruce'),
    (12, 'Pete');

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_weekly_performance_week ON weekly_player_performance(week);
CREATE INDEX IF NOT EXISTS idx_weekly_performance_team ON weekly_player_performance(team_id);
CREATE INDEX IF NOT EXISTS idx_weekly_totals_week ON weekly_team_totals(week);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(player_name);