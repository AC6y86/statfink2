const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { Validator, ValidationError } = require('./validation');
const { DatabaseError, logError, logInfo } = require('../utils/errorHandler');
const { getTeamAbbreviation } = require('../utils/teamMappings');

class DatabaseManager {
    constructor() {
        const dbPath = process.env.DATABASE_PATH || './fantasy_football.db';
        const absolutePath = path.resolve(dbPath);
        
        console.log('Database path:', dbPath);
        console.log('Absolute path:', absolutePath);
        console.log('Current working directory:', process.cwd());
        console.log('Database file exists:', fs.existsSync(absolutePath));
        
        this.db = new sqlite3.Database(absolutePath, (err) => {
            if (err) {
                console.error('Error opening database:', err);
                console.error('Database path was:', absolutePath);
                throw new DatabaseError('Failed to connect to database', 'connect');
            } else {
                console.log('Connected to SQLite database at:', absolutePath);
                this.initializeDatabase();
            }
        });
        
        // Enable foreign keys and WAL mode
        this.db.run('PRAGMA foreign_keys = ON');
        this.db.run('PRAGMA journal_mode = WAL');
    }

    initializeDatabase() {
        const schemaPath = path.join(__dirname, 'schema.sql');
        
        console.log('Initializing database with schema from:', schemaPath);
        console.log('NODE_ENV:', process.env.NODE_ENV);
        
        // In production, skip schema initialization to preserve data
        if (process.env.NODE_ENV === 'production') {
            console.log('Production mode: Skipping schema initialization');
            return;
        }
        
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
        return this.all('SELECT * FROM nfl_players ORDER BY position, name');
    }

    async getPlayersByPosition(position) {
        return this.all('SELECT * FROM nfl_players WHERE position = ? ORDER BY name', [position]);
    }

    async upsertPlayer(playerId, name, position, team, byeWeek, injuryDesignation = null, injuryDescription = null, injuryDate = null, injuryReturnDate = null) {
        const playerData = { player_id: playerId, name, position, team, bye_week: byeWeek };
        Validator.validatePlayer(playerData);
        
        return this.run(`
            INSERT OR REPLACE INTO nfl_players (player_id, name, position, team, bye_week, injury_designation, injury_description, injury_date, injury_return_date, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [playerId, name, position, team, byeWeek, injuryDesignation, injuryDescription, injuryDate, injuryReturnDate]);
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
                    player.bye_week,
                    player.injury_designation,
                    player.injury_description,
                    player.injury_date,
                    player.injury_return_date
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
    async getTeamRoster(teamId, week = null, season = null) {
        // Get current season and week if not provided
        const { season: leagueSeason, week: leagueWeek } = await this.getCurrentSeasonAndWeek();
        const currentSeason = season || leagueSeason;
        let currentWeek = week;
        
        if (!currentWeek) {
            const latestWeek = await this.get(`
                SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
            `, [currentSeason]);
            currentWeek = latestWeek.week;
        }
        
        const query = `
            SELECT 
                r.weekly_roster_id as roster_id,
                r.team_id,
                r.player_id,
                CASE 
                    WHEN r.roster_position = 'injured_reserve' THEN 'injured_reserve'
                    ELSE 'active'
                END as roster_position,
                r.player_name as name,
                r.player_position as position,
                COALESCE(p.team, r.player_team) as team,
                p.bye_week,
                r.snapshot_date as acquisition_date,
                r.is_scoring,
                r.scoring_slot,
                r.ir_date
            FROM weekly_rosters r
            LEFT JOIN nfl_players p ON r.player_id = p.player_id
            WHERE r.team_id = ? AND r.week = ? AND r.season = ?
            ORDER BY 
                CASE r.player_position 
                    WHEN 'QB' THEN 1 
                    WHEN 'RB' THEN 2 
                    WHEN 'WR' THEN 3 
                    WHEN 'TE' THEN 4 
                    WHEN 'K' THEN 5
                    WHEN 'Defense' THEN 6
                    ELSE 7 
                END,
                r.roster_position DESC,
                r.player_name
        `;
        const roster = await this.all(query, [teamId, currentWeek, currentSeason]);
        
        // Convert team names to abbreviations
        return roster.map(player => ({
            ...player,
            team: getTeamAbbreviation(player.team)
        }));
    }

    async addPlayerToRoster(teamId, playerId, rosterPosition = 'starter') {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        // Check if player is already on another team in current week
        const existing = await this.get(`
            SELECT team_id FROM weekly_rosters 
            WHERE player_id = ? AND week = ? AND season = ?
              AND roster_position != 'injured_reserve'
        `, [playerId, latestWeek.week, currentSeason]);
        
        if (existing) {
            throw new DatabaseError(`Player is already on team ${existing.team_id}`, 'roster_constraint');
        }
        
        // Get player info for denormalized data
        const player = await this.get('SELECT * FROM nfl_players WHERE player_id = ?', [playerId]);
        
        if (!player) {
            throw new DatabaseError('Player not found', 'not_found');
        }
        
        return this.run(`
            INSERT INTO weekly_rosters (team_id, player_id, week, season, roster_position, 
                                       player_name, player_position, player_team)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [teamId, playerId, latestWeek.week, currentSeason, rosterPosition, 
            player.name, player.position, player.team]);
    }

    async removePlayerFromRoster(teamId, playerId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        return this.run(`
            DELETE FROM weekly_rosters 
            WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
        `, [teamId, playerId, latestWeek.week, currentSeason]);
    }

    async updateRosterPosition(teamId, playerId, rosterPosition) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        // If moving to IR, set the ir_date
        if (rosterPosition === 'injured_reserve') {
            return this.run(`
                UPDATE weekly_rosters 
                SET roster_position = ?, ir_date = CURRENT_TIMESTAMP
                WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
            `, [rosterPosition, teamId, playerId, latestWeek.week, currentSeason]);
        } else {
            // If moving off IR, clear the ir_date
            return this.run(`
                UPDATE weekly_rosters 
                SET roster_position = ?, ir_date = NULL
                WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
            `, [rosterPosition, teamId, playerId, latestWeek.week, currentSeason]);
        }
    }

    // Check if a player is available (returns detailed info)
    async isPlayerAvailable(playerId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);

        // Check if player exists
        const player = await this.get(`
            SELECT player_id, name, position, team FROM nfl_players WHERE player_id = ?
        `, [playerId]);

        if (!player) {
            return {
                available: false,
                reason: 'Player not found in database',
                player: null
            };
        }

        // Check if player is on another team
        const ownership = await this.get(`
            SELECT wr.*, t.team_name, t.owner_name
            FROM weekly_rosters wr
            JOIN teams t ON wr.team_id = t.team_id
            WHERE wr.player_id = ? AND wr.week = ? AND wr.season = ?
              AND wr.roster_position != 'injured_reserve'
        `, [playerId, latestWeek.week, currentSeason]);

        if (ownership) {
            return {
                available: false,
                reason: `Player is already on ${ownership.team_name} (owned by ${ownership.owner_name})`,
                player: player,
                currentTeam: ownership.team_name,
                currentOwner: ownership.owner_name
            };
        }

        return {
            available: true,
            reason: null,
            player: player
        };
    }

    // Execute a paired roster move (drop + add)
    async executeRosterMove(teamId, dropPlayerId, addPlayerId, moveType) {
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);

        // Get player info for both players
        const [dropPlayer, addPlayer] = await Promise.all([
            this.get('SELECT * FROM nfl_players WHERE player_id = ?', [dropPlayerId]),
            this.get('SELECT * FROM nfl_players WHERE player_id = ?', [addPlayerId])
        ]);

        if (!dropPlayer || !addPlayer) {
            throw new DatabaseError('One or both players not found', 'not_found');
        }

        // Verify drop player is on the team
        const onRoster = await this.get(`
            SELECT * FROM weekly_rosters
            WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
        `, [teamId, dropPlayerId, latestWeek.week, currentSeason]);

        if (!onRoster) {
            throw new DatabaseError('Player to drop is not on this team', 'roster_constraint');
        }

        // Verify add player is available
        const availability = await this.isPlayerAvailable(addPlayerId);
        if (!availability.available) {
            throw new DatabaseError(availability.reason || 'Player to add is not available', 'roster_constraint');
        }

        // Start transaction
        await this.run('BEGIN TRANSACTION');

        try {
            // If move type is IR, first move player to injured_reserve
            if (moveType === 'ir') {
                await this.run(`
                    UPDATE weekly_rosters
                    SET roster_position = 'injured_reserve', ir_date = CURRENT_TIMESTAMP
                    WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
                `, [teamId, dropPlayerId, latestWeek.week, currentSeason]);
            } else {
                // For supplemental moves, remove the player
                await this.run(`
                    DELETE FROM weekly_rosters
                    WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
                `, [teamId, dropPlayerId, latestWeek.week, currentSeason]);
            }

            // Add the new player
            await this.run(`
                INSERT INTO weekly_rosters (team_id, player_id, week, season, roster_position,
                                           player_name, player_position, player_team)
                VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
            `, [teamId, addPlayerId, latestWeek.week, currentSeason,
                addPlayer.name, addPlayer.position, addPlayer.team]);

            // Log the move
            await this.run(`
                INSERT INTO roster_moves (team_id, move_type,
                                         dropped_player_id, dropped_player_name, dropped_player_position,
                                         added_player_id, added_player_name, added_player_position,
                                         week, season)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [teamId, moveType,
                dropPlayerId, dropPlayer.name, dropPlayer.position,
                addPlayerId, addPlayer.name, addPlayer.position,
                latestWeek.week, currentSeason]);

            // Commit transaction
            await this.run('COMMIT');

            return {
                success: true,
                dropped: dropPlayer,
                added: addPlayer,
                moveType: moveType
            };
        } catch (error) {
            // Rollback on error
            await this.run('ROLLBACK');
            throw error;
        }
    }

    // Get all available players by position
    async getAvailablePlayersByPosition(position) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);

        return this.all(`
            SELECT p.*
            FROM nfl_players p
            LEFT JOIN weekly_rosters r ON p.player_id = r.player_id 
                AND r.week = ? AND r.season = ?
                AND r.roster_position != 'injured_reserve'
            WHERE p.position = ? AND r.player_id IS NULL
            ORDER BY p.name
        `, [latestWeek.week, currentSeason, position]);
    }

    // Check if team has an injured reserve player
    async hasInjuredReservePlayer(teamId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        const result = await this.get(`
            SELECT COUNT(*) as count 
            FROM weekly_rosters 
            WHERE team_id = ? AND roster_position = 'injured_reserve'
              AND week = ? AND season = ?
        `, [teamId, latestWeek.week, currentSeason]);
        return result.count > 0;
    }

    // Get team's injured reserve player
    async getTeamInjuredReservePlayer(teamId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        return this.get(`
            SELECT r.*, p.bye_week
            FROM weekly_rosters r
            LEFT JOIN nfl_players p ON r.player_id = p.player_id
            WHERE r.team_id = ? AND r.roster_position = 'injured_reserve'
              AND r.week = ? AND r.season = ?
        `, [teamId, latestWeek.week, currentSeason]);
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
            (player_id, week, season, game_id, passing_yards, passing_tds, interceptions,
             rushing_yards, rushing_tds, receiving_yards, receiving_tds, receptions,
             fumbles, sacks, def_interceptions, fumbles_recovered, def_touchdowns,
             safeties, points_allowed, yards_allowed, field_goals_made,
             field_goals_attempted, extra_points_made, extra_points_attempted,
             field_goals_0_39, field_goals_40_49, field_goals_50_plus,
             two_point_conversions_pass, two_point_conversions_run, two_point_conversions_rec,
             fantasy_points, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;
        
        return this.run(query, [
            stats.player_id, stats.week, stats.season, stats.game_id || null,
            stats.passing_yards || 0, stats.passing_tds || 0, stats.interceptions || 0,
            stats.rushing_yards || 0, stats.rushing_tds || 0,
            stats.receiving_yards || 0, stats.receiving_tds || 0, stats.receptions || 0,
            stats.fumbles || 0, stats.sacks || 0, stats.def_interceptions || 0,
            stats.fumbles_recovered || 0, stats.def_touchdowns || 0,
            stats.safeties || 0, stats.points_allowed || 0, stats.yards_allowed || 0,
            stats.field_goals_made || 0, stats.field_goals_attempted || 0,
            stats.extra_points_made || 0, stats.extra_points_attempted || 0,
            stats.field_goals_0_39 || 0, stats.field_goals_40_49 || 0,
            stats.field_goals_50_plus || 0, 
            stats.two_point_conversions_pass || 0, stats.two_point_conversions_run || 0,
            stats.two_point_conversions_rec || 0, stats.fantasy_points || 0
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
            SET team1_points = ?, team2_points = ?
            WHERE matchup_id = ?
        `, [team1Points, team2Points, matchupId]);
    }

    // League settings
    async getLeagueSettings() {
        return this.get('SELECT * FROM league_settings WHERE league_id = 1');
    }

    async getCurrentSeasonAndWeek() {
        const settings = await this.getLeagueSettings();
        return {
            season: settings.season_year,
            week: settings.current_week
        };
    }

    async updateCurrentWeek(week) {
        return this.run('UPDATE league_settings SET current_week = ? WHERE league_id = 1', [week]);
    }

    async updateSeasonYear(year) {
        return this.run('UPDATE league_settings SET season_year = ? WHERE league_id = 1', [year]);
    }

    async updateLeagueSettings(settings) {
        const { current_week, season_year, league_name } = settings;
        const updateFields = [];
        const values = [];
        
        if (current_week !== undefined) {
            updateFields.push('current_week = ?');
            values.push(current_week);
        }
        if (season_year !== undefined) {
            updateFields.push('season_year = ?');
            values.push(season_year);
        }
        if (league_name !== undefined) {
            updateFields.push('league_name = ?');
            values.push(league_name);
        }
        
        if (updateFields.length === 0) {
            throw new Error('No valid fields to update');
        }
        
        values.push(1); // league_id
        return this.run(
            `UPDATE league_settings SET ${updateFields.join(', ')} WHERE league_id = ?`,
            values
        );
    }

    // Scheduler timestamp methods
    async getSchedulerTimestamps() {
        return this.get(`
            SELECT last_daily_update, last_weekly_update, last_live_update 
            FROM league_settings 
            WHERE league_id = 1
        `);
    }

    async updateSchedulerTimestamp(type) {
        const columnMap = {
            'daily': 'last_daily_update',
            'weekly': 'last_weekly_update',
            'live': 'last_live_update'
        };
        
        const column = columnMap[type];
        if (!column) {
            throw new Error(`Invalid timestamp type: ${type}`);
        }
        
        return this.run(
            `UPDATE league_settings SET ${column} = CURRENT_TIMESTAMP WHERE league_id = 1`
        );
    }

    // Calculate team's total points for a week
    async calculateTeamWeeklyPoints(teamId, week, season) {
        const result = await this.get(`
            SELECT SUM(ps.fantasy_points) as total_points
            FROM weekly_rosters r
            JOIN player_stats ps ON r.player_id = ps.player_id
            WHERE r.team_id = ? AND r.roster_position = 'active'
                AND ps.week = ? AND ps.season = ?
                AND r.week = ? AND r.season = ?
        `, [teamId, week, season, week, season]);
        
        return result ? result.total_points || 0 : 0;
    }

    // Get all starters for a team in a specific week
    async getTeamStarters(teamId, week, season) {
        return this.all(`
            SELECT 
                r.*, 
                r.player_name as name, 
                r.player_position as position, 
                COALESCE(p.team, r.player_team) as team,
                ps.fantasy_points,
                ps.passing_yards,
                ps.passing_tds,
                ps.rushing_yards,
                ps.rushing_tds,
                ps.receiving_yards,
                ps.receiving_tds,
                ps.receptions
            FROM weekly_rosters r
            LEFT JOIN nfl_players p ON r.player_id = p.player_id
            LEFT JOIN player_stats ps ON r.player_id = ps.player_id 
                AND ps.week = ? AND ps.season = ?
            WHERE r.team_id = ? AND r.roster_position = 'active'
                AND r.week = ? AND r.season = ?
            ORDER BY 
                CASE r.player_position 
                    WHEN 'QB' THEN 1 
                    WHEN 'RB' THEN 2 
                    WHEN 'WR' THEN 3 
                    WHEN 'TE' THEN 4 
                    WHEN 'K' THEN 5
                    WHEN 'Defense' THEN 6
                    ELSE 7 
                END
        `, [week, season, teamId, week, season]);
    }

    // Get player ownership
    async getPlayerOwnership(playerId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        return this.get(`
            SELECT r.*, t.team_name, t.owner_name
            FROM weekly_rosters r
            JOIN teams t ON r.team_id = t.team_id
            WHERE r.player_id = ? AND r.week = ? AND r.season = ?
              AND r.roster_position != 'injured_reserve'
        `, [playerId, latestWeek.week, currentSeason]);
    }

    // Get roster size for a team
    async getTeamRosterSize(teamId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        const result = await this.get(`
            SELECT COUNT(*) as roster_size
            FROM weekly_rosters
            WHERE team_id = ? AND week = ? AND season = ?
        `, [teamId, latestWeek.week, currentSeason]);
        
        return result ? result.roster_size : 0;
    }

    // Get starter count for a team
    async getTeamStarterCount(teamId) {
        // Get current season and latest week
        const { season: currentSeason } = await this.getCurrentSeasonAndWeek();
        const latestWeek = await this.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);

        const result = await this.get(`
            SELECT COUNT(*) as starter_count
            FROM weekly_rosters
            WHERE team_id = ? AND roster_position = 'starter'
              AND week = ? AND season = ?
        `, [teamId, latestWeek.week, currentSeason]);

        return result ? result.starter_count : 0;
    }

    // Copy rosters from one week to another
    async copyRostersToNextWeek(fromWeek, toWeek, season) {
        const { logInfo, logWarn, logError } = require('../utils/errorHandler');

        try {
            // Check if target week already has rosters
            const existingRosters = await this.get(`
                SELECT COUNT(*) as count FROM weekly_rosters
                WHERE week = ? AND season = ?
            `, [toWeek, season]);

            if (existingRosters.count > 0) {
                logWarn(`Week ${toWeek} already has ${existingRosters.count} roster entries, skipping copy`);
                return {
                    success: false,
                    message: `Week ${toWeek} already has rosters`,
                    existingCount: existingRosters.count
                };
            }

            // Copy all rosters from previous week to new week
            const result = await this.run(`
                INSERT INTO weekly_rosters (team_id, player_id, week, season, roster_position,
                                          player_name, player_position, player_team, is_scoring,
                                          scoring_slot, ir_date)
                SELECT team_id, player_id, ?, season, roster_position,
                       player_name, player_position, player_team, is_scoring,
                       scoring_slot, ir_date
                FROM weekly_rosters
                WHERE week = ? AND season = ?
            `, [toWeek, fromWeek, season]);

            logInfo(`Copied ${result.changes} roster entries from week ${fromWeek} to week ${toWeek}`);

            return {
                success: true,
                message: `Successfully copied rosters from week ${fromWeek} to week ${toWeek}`,
                entriesCopied: result.changes
            };
        } catch (error) {
            logError(`Failed to copy rosters from week ${fromWeek} to week ${toWeek}:`, error);
            return {
                success: false,
                message: error.message,
                error: error
            };
        }
    }


    // Tank01 Cache Management Methods
    
    // Get most accessed cache entries
    async getMostAccessedCacheEntries(limit = 10) {
        return this.all(`
            SELECT cache_key, endpoint, hit_count, is_historical, created_at, last_accessed
            FROM tank01_cache
            ORDER BY hit_count DESC
            LIMIT ?
        `, [limit]);
    }
    
    // Get cache entries by endpoint
    async getCacheEntriesByEndpoint(endpoint) {
        return this.all(`
            SELECT cache_key, params, hit_count, is_historical, created_at, expires_at
            FROM tank01_cache
            WHERE endpoint = ?
            ORDER BY last_accessed DESC
        `, [endpoint]);
    }
    
    // Clean up old cache entries (not historical)
    async cleanupExpiredCache() {
        const result = await this.run(`
            DELETE FROM tank01_cache 
            WHERE is_historical = 0 AND expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
        `);
        logInfo(`Cleaned up ${result.changes} expired cache entries`);
        return result.changes;
    }
    
    // Get cache storage size estimate
    async getCacheStorageSize() {
        const result = await this.get(`
            SELECT 
                COUNT(*) as total_entries,
                SUM(LENGTH(response_data)) as total_bytes,
                SUM(CASE WHEN is_historical = 1 THEN LENGTH(response_data) ELSE 0 END) as historical_bytes,
                SUM(CASE WHEN is_historical = 0 THEN LENGTH(response_data) ELSE 0 END) as temporary_bytes
            FROM tank01_cache
        `);
        
        return {
            totalEntries: result.total_entries || 0,
            totalSizeMB: (result.total_bytes || 0) / (1024 * 1024),
            historicalSizeMB: (result.historical_bytes || 0) / (1024 * 1024),
            temporarySizeMB: (result.temporary_bytes || 0) / (1024 * 1024)
        };
    }

    // Close database connection
    close() {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                resolve();
                return;
            }
            
            this.db.close((err) => {
                if (err) {
                    logError('Error closing database', err);
                    // Don't reject, just resolve to allow graceful shutdown
                    resolve();
                } else {
                    console.log('Database connection closed');
                    resolve();
                }
            });
        });
    }
}

module.exports = DatabaseManager;