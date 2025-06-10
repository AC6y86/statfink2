const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { Validator, ValidationError } = require('./validation');
const { DatabaseError } = require('../utils/errorHandler');

class DatabaseManager {
    constructor() {
        const dbPath = process.env.DATABASE_PATH || './fantasy_football.db';
        
        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('Error opening database:', err);
                throw new DatabaseError('Failed to connect to database', 'connect');
            } else {
                console.log('Connected to SQLite database');
                this.initializeDatabase();
            }
        });
        
        // Enable foreign keys and WAL mode
        this.db.run('PRAGMA foreign_keys = ON');
        this.db.run('PRAGMA journal_mode = WAL');
    }

    initializeDatabase() {
        const schemaPath = path.join(__dirname, 'schema.sql');
        
        try {
            const schema = fs.readFileSync(schemaPath, 'utf8');
            
            this.db.exec(schema, (err) => {
                if (err) {
                    console.error('Error initializing database:', err);
                    throw new DatabaseError('Failed to initialize database schema', 'schema_init');
                } else {
                    console.log('Database initialized successfully');
                }
            });
        } catch (err) {
            console.error('Error reading schema file:', err);
            throw new DatabaseError('Failed to read database schema', 'schema_read');
        }
    }

    // Promise wrapper for database operations
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) {
                    logError(err, `DatabaseManager.run - SQL: ${sql}`);
                    reject(new DatabaseError(err.message, 'run'));
                } else {
                    resolve({ id: this.lastID, changes: this.changes });
                }
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    logError(err, `DatabaseManager.get - SQL: ${sql}`);
                    reject(new DatabaseError(err.message, 'get'));
                } else {
                    resolve(row);
                }
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    logError(err, `DatabaseManager.all - SQL: ${sql}`);
                    reject(new DatabaseError(err.message, 'all'));
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // Transaction support
    beginTransaction() {
        return this.run('BEGIN TRANSACTION');
    }

    commit() {
        return this.run('COMMIT');
    }

    rollback() {
        return this.run('ROLLBACK');
    }

    // Team methods
    async getAllTeams() {
        return this.all('SELECT * FROM teams ORDER BY wins DESC, losses ASC, total_points DESC');
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
        const playerData = { player_id: playerId, name, position, team, bye_week: byeWeek };
        Validator.validatePlayer(playerData);
        
        return this.run(`
            INSERT OR REPLACE INTO nfl_players (player_id, name, position, team, bye_week, last_updated)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [playerId, name, position, team, byeWeek]);
    }

    // Bulk player insert for API updates
    async upsertPlayersBulk(players) {
        try {
            await this.beginTransaction();
            
            for (const player of players) {
                await this.upsertPlayer(
                    player.player_id, 
                    player.name, 
                    player.position, 
                    player.team, 
                    player.bye_week
                );
            }
            
            await this.commit();
            logInfo(`Bulk upserted ${players.length} players`);
        } catch (error) {
            await this.rollback();
            throw error;
        }
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
                END,
                r.roster_position DESC,
                p.name
        `;
        return this.all(query, [teamId]);
    }

    async addPlayerToRoster(teamId, playerId, rosterPosition = 'bench') {
        // First check if player is already on another team
        const existing = await this.get('SELECT team_id FROM fantasy_rosters WHERE player_id = ?', [playerId]);
        
        if (existing) {
            throw new DatabaseError(`Player is already on team ${existing.team_id}`, 'roster_constraint');
        }
        
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

    // Check if a player is available
    async isPlayerAvailable(playerId) {
        const result = await this.get('SELECT COUNT(*) as count FROM fantasy_rosters WHERE player_id = ?', [playerId]);
        return result.count === 0;
    }

    // Get all available players by position
    async getAvailablePlayersByPosition(position) {
        return this.all(`
            SELECT p.* 
            FROM nfl_players p
            LEFT JOIN fantasy_rosters r ON p.player_id = r.player_id
            WHERE p.position = ? AND p.is_active = 1 AND r.player_id IS NULL
            ORDER BY p.name
        `, [position]);
    }

    // Stats methods
    async getPlayerStats(playerId, week, season) {
        return this.get(`
            SELECT * FROM player_stats 
            WHERE player_id = ? AND week = ? AND season = ?
        `, [playerId, week, season]);
    }

    async getPlayerStatsByWeek(week, season) {
        return this.all(`
            SELECT ps.*, p.name, p.position, p.team
            FROM player_stats ps
            JOIN nfl_players p ON ps.player_id = p.player_id
            WHERE ps.week = ? AND ps.season = ?
            ORDER BY ps.fantasy_points DESC
        `, [week, season]);
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

    // Bulk stats update for API sync
    async upsertPlayerStatsBulk(statsList) {
        try {
            await this.beginTransaction();
            
            for (const stats of statsList) {
                await this.upsertPlayerStats(stats);
            }
            
            await this.commit();
            logInfo(`Bulk upserted ${statsList.length} player stats`);
        } catch (error) {
            await this.rollback();
            throw error;
        }
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
            ORDER BY m.matchup_id
        `;
        return this.all(query, [week, season]);
    }

    async getTeamMatchups(teamId, season) {
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
            WHERE (m.team1_id = ? OR m.team2_id = ?) AND m.season = ?
            ORDER BY m.week
        `;
        return this.all(query, [teamId, teamId, season]);
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
            SET team1_points = ?, team2_points = ?, 
                is_complete = CASE WHEN ? > 0 OR ? > 0 THEN 1 ELSE 0 END
            WHERE matchup_id = ?
        `, [team1Points, team2Points, team1Points, team2Points, matchupId]);
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
        return this.all('SELECT * FROM scoring_rules ORDER BY stat_type');
    }

    async getScoringRule(statType) {
        return this.get('SELECT * FROM scoring_rules WHERE stat_type = ?', [statType]);
    }

    // Calculate team's total points for a week
    async calculateTeamWeeklyPoints(teamId, week, season) {
        const result = await this.get(`
            SELECT SUM(ps.fantasy_points) as total_points
            FROM fantasy_rosters r
            JOIN player_stats ps ON r.player_id = ps.player_id
            WHERE r.team_id = ? AND r.roster_position = 'starter' 
                AND ps.week = ? AND ps.season = ?
        `, [teamId, week, season]);
        
        return result ? result.total_points || 0 : 0;
    }

    // Get all starters for a team in a specific week
    async getTeamStarters(teamId, week, season) {
        return this.all(`
            SELECT 
                r.*, 
                p.name, 
                p.position, 
                p.team,
                ps.fantasy_points,
                ps.passing_yards,
                ps.passing_tds,
                ps.rushing_yards,
                ps.rushing_tds,
                ps.receiving_yards,
                ps.receiving_tds,
                ps.receptions
            FROM fantasy_rosters r
            JOIN nfl_players p ON r.player_id = p.player_id
            LEFT JOIN player_stats ps ON r.player_id = ps.player_id 
                AND ps.week = ? AND ps.season = ?
            WHERE r.team_id = ? AND r.roster_position = 'starter'
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
        `, [week, season, teamId]);
    }

    // Get player ownership
    async getPlayerOwnership(playerId) {
        return this.get(`
            SELECT r.*, t.team_name, t.owner_name
            FROM fantasy_rosters r
            JOIN teams t ON r.team_id = t.team_id
            WHERE r.player_id = ?
        `, [playerId]);
    }

    // Get roster size for a team
    async getTeamRosterSize(teamId) {
        const result = await this.get(`
            SELECT COUNT(*) as roster_size
            FROM fantasy_rosters
            WHERE team_id = ?
        `, [teamId]);
        
        return result ? result.roster_size : 0;
    }

    // Get starter count for a team
    async getTeamStarterCount(teamId) {
        const result = await this.get(`
            SELECT COUNT(*) as starter_count
            FROM fantasy_rosters
            WHERE team_id = ? AND roster_position = 'starter'
        `, [teamId]);
        
        return result ? result.starter_count : 0;
    }

    // Close database connection
    close() {
        return new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) {
                    logError(err, 'DatabaseManager.close');
                    reject(new DatabaseError(err.message, 'close'));
                } else {
                    console.log('Database connection closed');
                    resolve();
                }
            });
        });
    }
}

module.exports = DatabaseManager;