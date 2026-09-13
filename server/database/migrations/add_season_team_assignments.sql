-- Draft slot and division are annual attributes; team_id remains a permanent
-- owner identity so historical rosters, standings, and transactions stay put.
CREATE TABLE IF NOT EXISTS season_team_assignments (
    season INTEGER NOT NULL,
    draft_slot INTEGER NOT NULL CHECK (draft_slot BETWEEN 1 AND 12),
    team_id INTEGER NOT NULL,
    division TEXT NOT NULL CHECK (division IN ('Odd', 'Even')),
    PRIMARY KEY (season, draft_slot),
    UNIQUE (season, team_id),
    FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_season_team_assignments_team
    ON season_team_assignments(season, team_id);
