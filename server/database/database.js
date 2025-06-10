const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

class DatabaseManager {
    constructor() {
        const dbPath = process.env.DATABASE_PATH || './fantasy_football.db';
        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('Error opening database:', err);
            } else {
                console.log('Connected to SQLite database');
                this.initializeDatabase();
            }
        });
    }

    initializeDatabase() {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        
        // Enable foreign keys
        this.db.run('PRAGMA foreign_keys = ON');
        
        // Execute schema
        this.db.exec(schema, (err) => {
            if (err) {
                console.error('Error initializing database:', err);
            } else {
                console.log('Database initialized successfully');
            }
        });
    }

    // Promise wrapper for database operations
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, changes: this.changes });
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    // Team methods
    async getAllTeams() {
        return this.all('SELECT * FROM teams ORDER BY wins DESC, total_points DESC');
    }

    async getTeam(teamId) {
        return this.get('SELECT * FROM teams WHERE team_id = ?', [teamId]);
    }

    async updateTeamStats(teamId, wins, losses, ties, totalPoints) {
        return this.run(
            'UPDATE teams SET wins = ?, losses = ?, ties = ?, total_points = ? WHERE team_id = ?',
            [wins, losses, ties, totalPoints, teamId]
        );
    }

    // Player methods
    async getAllPlayers() {
        return this.all('SELECT * FROM nfl_players WHERE is_active = 1 ORDER BY position, name');
    }

    async getPlayersByPosition(position) {
        return this.all('SELECT * FROM nfl_players WHERE position = ? AND is_active = 1 ORDER BY name', [position]);
    }

    async upsertPlayer(playerId, name, position, team, byeWeek) {
        return this.run(`
            INSERT OR REPLACE INTO nfl_players (player_id, name, position, team, bye_week, last_updated)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [playerId, name, position, team, byeWeek]);
    }

    // Roster methods
    async getTeamRoster(teamId) {
        const query = `
            SELECT r.*, p.name, p.position, p.team, p.bye_week
            FROM fantasy_rosters r
            JOIN nfl_players p ON r.player_id = p.player_id
            WHERE r.team_id = ?
            ORDER BY 
                CASE p.position 
                    WHEN 'QB' THEN 1 
                    WHEN 'RB' THEN 2 
                    WHEN 'WR' THEN 3 
                    WHEN 'TE' THEN 4 
                    WHEN 'K' THEN 5
                    WHEN 'DST' THEN 6
                    ELSE 7 
                END
        `;
        return this.all(query, [teamId]);
    }

    async addPlayerToRoster(teamId, playerId, rosterPosition = 'bench') {
        return this.run(`
            INSERT INTO fantasy_rosters (team_id, player_id, roster_position)
            VALUES (?, ?, ?)
        `, [teamId, playerId, rosterPosition]);
    }

    async removePlayerFromRoster(teamId, playerId) {
        return this.run(`
            DELETE FROM fantasy_rosters 
            WHERE team_id = ? AND player_id = ?
        `, [teamId, playerId]);
    }

    async updateRosterPosition(teamId, playerId, rosterPosition) {
        return this.run(`
            UPDATE fantasy_rosters 
            SET roster_position = ?
            WHERE team_id = ? AND player_id = ?
        `, [rosterPosition, teamId, playerId]);
    }

    // Stats methods
    async getPlayerStats(playerId, week, season) {
        return this.get(`
            SELECT * FROM player_stats 
            WHERE player_id = ? AND week = ? AND season = ?
        `, [playerId, week, season]);
    }

    async upsertPlayerStats(stats) {
        const query = `
            INSERT OR REPLACE INTO player_stats 
            (player_id, week, season, passing_yards, passing_tds, interceptions,
             rushing_yards, rushing_tds, receiving_yards, receiving_tds, receptions,
             fumbles, sacks, def_interceptions, fumbles_recovered, def_touchdowns,
             safeties, points_allowed, yards_allowed, field_goals_made,
             field_goals_attempted, extra_points_made, extra_points_attempted,
             field_goals_0_39, field_goals_40_49, field_goals_50_plus,
             fantasy_points, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;
        
        return this.run(query, [
            stats.player_id, stats.week, stats.season,
            stats.passing_yards || 0, stats.passing_tds || 0, stats.interceptions || 0,
            stats.rushing_yards || 0, stats.rushing_tds || 0,
            stats.receiving_yards || 0, stats.receiving_tds || 0, stats.receptions || 0,
            stats.fumbles || 0, stats.sacks || 0, stats.def_interceptions || 0,
            stats.fumbles_recovered || 0, stats.def_touchdowns || 0,
            stats.safeties || 0, stats.points_allowed || 0, stats.yards_allowed || 0,
            stats.field_goals_made || 0, stats.field_goals_attempted || 0,
            stats.extra_points_made || 0, stats.extra_points_attempted || 0,
            stats.field_goals_0_39 || 0, stats.field_goals_40_49 || 0,
            stats.field_goals_50_plus || 0, stats.fantasy_points || 0
        ]);
    }

    // Matchup methods
    async getWeekMatchups(week, season) {
        const query = `
            SELECT 
                m.*,
                t1.team_name as team1_name,
                t1.owner_name as team1_owner,
                t2.team_name as team2_name,
                t2.owner_name as team2_owner
            FROM matchups m
            JOIN teams t1 ON m.team1_id = t1.team_id
            JOIN teams t2 ON m.team2_id = t2.team_id
            WHERE m.week = ? AND m.season = ?
        `;
        return this.all(query, [week, season]);
    }

    async createMatchup(week, season, team1Id, team2Id) {
        return this.run(`
            INSERT INTO matchups (week, season, team1_id, team2_id)
            VALUES (?, ?, ?, ?)
        `, [week, season, team1Id, team2Id]);
    }

    async updateMatchupScore(matchupId, team1Points, team2Points) {
        return this.run(`
            UPDATE matchups 
            SET team1_points = ?, team2_points = ?
            WHERE matchup_id = ?
        `, [team1Points, team2Points, matchupId]);
    }

    // League settings
    async getLeagueSettings() {
        return this.get('SELECT * FROM league_settings WHERE league_id = 1');
    }

    async updateCurrentWeek(week) {
        return this.run('UPDATE league_settings SET current_week = ? WHERE league_id = 1', [week]);
    }

    // Scoring rules
    async getScoringRules() {
        return this.all('SELECT * FROM scoring_rules');
    }

    // Transaction support
    async beginTransaction() {
        return this.run('BEGIN TRANSACTION');
    }

    async commit() {
        return this.run('COMMIT');
    }

    async rollback() {
        return this.run('ROLLBACK');
    }

    // Close database connection
    close() {
        return new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) reject(err);
                else {
                    console.log('Database connection closed');
                    resolve();
                }
            });
        });
    }
}

module.exports = DatabaseManager;