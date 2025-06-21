const { logInfo, logError, logWarn } = require('../utils/errorHandler');

class StatsSyncService {
    constructor(db, tank01Service, scoringService) {
        this.db = db;
        this.tank01Service = tank01Service;
        this.scoringService = scoringService;
        this.syncInProgress = false;
        this.lastSyncTime = null;
    }

    // Main sync function for weekly stats
    async syncWeeklyStats(week, season) {
        if (this.syncInProgress) {
            logWarn('Stats sync already in progress, skipping');
            return { success: false, message: 'Sync already in progress' };
        }

        if (!this.tank01Service) {
            logError('Tank01 service not available for stats sync');
            return { success: false, message: 'Tank01 service not configured' };
        }

        this.syncInProgress = true;
        const startTime = Date.now();
        
        try {
            logInfo(`Starting stats synchronization for Week ${week}, ${season}`);
            
            // Get player stats from Tank01 API
            const boxScoreData = await this.tank01Service.getPlayerStats(week, season);
            
            // Debug: Log the structure of the received data
            logInfo(`StatsSyncService received data type: ${typeof boxScoreData}`);
            if (boxScoreData && typeof boxScoreData === 'object') {
                logInfo(`StatsSyncService data keys: ${Object.keys(boxScoreData).join(', ')}`);
                
                // Log first few entries to understand structure
                const keys = Object.keys(boxScoreData);
                if (keys.length > 0) {
                    const firstKey = keys[0];
                    const firstValue = boxScoreData[firstKey];
                    logInfo(`Sample entry [${firstKey}]:`, {
                        type: typeof firstValue,
                        keys: firstValue && typeof firstValue === 'object' ? Object.keys(firstValue).slice(0, 10) : 'primitive'
                    });
                }
            }
            
            if (!boxScoreData) {
                throw new Error('No boxscore data received from Tank01 API');
            }
            
            // Parse Tank01 data structure
            let gamesData = [];
            
            if (Array.isArray(boxScoreData)) {
                gamesData = boxScoreData;
                logInfo('Tank01 returned array format');
            } else if (typeof boxScoreData === 'object') {
                // Tank01 likely returns games as object properties
                const gameKeys = Object.keys(boxScoreData);
                logInfo(`Tank01 returned object format with ${gameKeys.length} game entries`);
                
                // Try different approaches to extract game data
                gamesData = gameKeys.map(gameId => {
                    const gameData = boxScoreData[gameId];
                    // Add the gameId to the game data for reference
                    if (gameData && typeof gameData === 'object') {
                        return { ...gameData, gameId };
                    }
                    return gameData;
                }).filter(game => game && typeof game === 'object');
                
                logInfo(`Extracted ${gamesData.length} valid game objects`);
            } else {
                throw new Error('Invalid boxscore data format from Tank01 API');
            }

            // Transform API data to our database format
            const playerStats = await this.transformStatsData(gamesData, week, season);
            
            logInfo(`Transformed ${playerStats.length} player stat entries from Tank01 API`);

            // Calculate fantasy points for each stat entry (skip defenses - they are calculated at end of week)
            for (const stats of playerStats) {
                const isDefensePlayer = await this.isDefensePlayer(stats.player_id);
                if (isDefensePlayer) {
                    // Skip fantasy points calculation for defense players - they need to be calculated at the end of the week
                    stats.fantasy_points = 0;
                    logInfo(`Skipping fantasy points calculation for defense player ID: ${stats.player_id}`);
                } else {
                    stats.fantasy_points = await this.scoringService.calculateFantasyPoints(stats);
                }
            }

            // Bulk insert/update player stats
            if (playerStats.length > 0) {
                await this.db.upsertPlayerStatsBulk(playerStats);
                logInfo(`Updated database with ${playerStats.length} player stat entries`);
                
                // Automatically recalculate team scores for this week
                await this.recalculateTeamScores(week, season);
                logInfo(`Recalculated team scores for Week ${week}, ${season}`);
            } else {
                logInfo('No player stats to update in database');
            }
            
            const duration = Date.now() - startTime;
            this.syncInProgress = false;
            this.lastSyncTime = new Date().toISOString();
            
            logInfo(`Stats sync completed in ${duration}ms`);
            
            return {
                success: true,
                data: {
                    players_synced: playerStats.length,
                    week: week,
                    season: season,
                    duration: duration
                },
                message: `Successfully synced ${playerStats.length} player stats for Week ${week}, ${season}`
            };

        } catch (error) {
            this.syncInProgress = false;
            logError(`Stats sync failed for Week ${week}, ${season}`, error);
            
            return {
                success: false,
                error: error.message,
                message: `Failed to sync stats for Week ${week}, ${season}`
            };
        }
    }

    // Transform Tank01 boxscore data to our database format
    async transformStatsData(boxScoreData, week, season) {
        const playerStats = [];

        // Tank01 boxscore data comes as object with game IDs as keys
        for (const gameId of Object.keys(boxScoreData)) {
            const game = boxScoreData[gameId];
            
            // Debug: Log the structure of game data to find player stats
            logInfo(`Game ${gameId} structure:`, {
                topLevelKeys: Object.keys(game).slice(0, 15),
                hasPlayerStats: game.playerStats ? 'yes' : 'no',
                hasTeamStats: game.teamStats ? 'yes' : 'no'
            });
            
            if (!game.playerStats) {
                logWarn(`No playerStats found in game ${gameId}, skipping`);
                continue;
            }

            // Tank01 playerStats is organized by playerID, not team
            const playerIds = Object.keys(game.playerStats);
            logInfo(`Game ${gameId} has ${playerIds.length} players with stats`);

            for (const playerId of playerIds) {
                const playerData = game.playerStats[playerId];
                
                if (!playerData || !playerData.longName) {
                    logWarn(`Invalid player data for ID ${playerId} in game ${gameId}`);
                    continue;
                }
                
                // Transform player stats for each category they have
                const transformedStats = await this.mapTank01PlayerStats(playerData, week, season);
                if (transformedStats) {
                    playerStats.push(transformedStats);
                }
            }
        }

        return playerStats;
    }

    // Map Tank01 player stats to our database format
    async mapTank01PlayerStats(playerData, week, season) {
        // Find player in our database by name matching
        const playerId = await this.findPlayerIdByName(playerData.longName);
        if (!playerId) {
            logWarn(`Player not found in database: ${playerData.longName}`);
            return null;
        }

        // Base stats object
        const stats = {
            player_id: playerId,
            week: week,
            season: season,
            passing_yards: 0,
            passing_tds: 0,
            interceptions: 0,
            rushing_yards: 0,
            rushing_tds: 0,
            receiving_yards: 0,
            receiving_tds: 0,
            receptions: 0,
            fumbles: 0,
            sacks: 0,
            def_interceptions: 0,
            fumbles_recovered: 0,
            def_touchdowns: 0,
            safeties: 0,
            points_allowed: 0,
            yards_allowed: 0,
            field_goals_made: 0,
            field_goals_attempted: 0,
            extra_points_made: 0,
            extra_points_attempted: 0,
            field_goals_0_39: 0,
            field_goals_40_49: 0,
            field_goals_50_plus: 0
        };

        // Map stats from Tank01 categories
        if (playerData.Passing) {
            const passing = playerData.Passing;
            stats.passing_yards = parseInt(passing.passYds) || 0;
            stats.passing_tds = parseInt(passing.passTD) || 0;
            stats.interceptions = parseInt(passing.int) || 0;
        }

        if (playerData.Rushing) {
            const rushing = playerData.Rushing;
            stats.rushing_yards = parseInt(rushing.rushYds) || 0;
            stats.rushing_tds = parseInt(rushing.rushTD) || 0;
            stats.fumbles = parseInt(rushing.fumbles) || 0;
        }

        if (playerData.Receiving) {
            const receiving = playerData.Receiving;
            stats.receiving_yards = parseInt(receiving.recYds) || 0;
            stats.receiving_tds = parseInt(receiving.recTD) || 0;
            stats.receptions = parseInt(receiving.receptions) || 0;
        }

        if (playerData.Kicking) {
            const kicking = playerData.Kicking;
            stats.field_goals_made = parseInt(kicking.fgMade) || 0;
            stats.field_goals_attempted = parseInt(kicking.fgAttempts) || 0;
            stats.extra_points_made = parseInt(kicking.xpMade) || 0;
            stats.extra_points_attempted = parseInt(kicking.xpAttempts) || 0;
        }

        if (playerData.Defense) {
            const defense = playerData.Defense;
            stats.sacks = parseInt(defense.sacks) || 0;
            stats.def_interceptions = parseInt(defense.defInt) || 0;
            stats.fumbles_recovered = parseInt(defense.fumblesRecovered) || 0;
            stats.def_touchdowns = parseInt(defense.defTD) || 0;
            stats.safeties = parseInt(defense.safeties) || 0;
        }

        logInfo(`Mapped stats for ${playerData.longName}:`, {
            passing_yards: stats.passing_yards,
            rushing_yards: stats.rushing_yards,
            receiving_yards: stats.receiving_yards,
            field_goals_made: stats.field_goals_made
        });

        return stats;
    }

    // Find player ID by name (simplified matching for now)
    async findPlayerIdByName(playerName) {
        try {
            // For now, use simple name matching with database lookup
            // TODO: Implement fuzzy matching and nickname handling
            
            const player = await this.db.get(
                'SELECT player_id FROM nfl_players WHERE name = ? OR name LIKE ?',
                [playerName, `%${playerName}%`]
            );
            
            if (player) {
                return player.player_id;
            }
            
            // Try with common name variations
            const variations = [
                playerName.replace(/'/g, ''),  // Remove apostrophes
                playerName.replace(/\./g, ''), // Remove periods
                playerName.replace(/Jr\.?|Sr\.?|III|II/gi, '').trim() // Remove suffixes
            ];
            
            for (const variation of variations) {
                const varPlayer = await this.db.get(
                    'SELECT player_id FROM nfl_players WHERE name LIKE ?',
                    [`%${variation}%`]
                );
                if (varPlayer) {
                    return varPlayer.player_id;
                }
            }
            
            return null;
        } catch (error) {
            logError(`Error finding player ID for ${playerName}`, error);
            return null;
        }
    }

    // Check if a player is a defense player
    async isDefensePlayer(playerId) {
        try {
            const player = await this.db.get(
                'SELECT position FROM nfl_players WHERE player_id = ?',
                [playerId]
            );
            
            return player && player.position === 'DST';
        } catch (error) {
            logError(`Error checking if player ${playerId} is defense player`, error);
            return false;
        }
    }

    // Get sync status
    getSyncStatus() {
        return {
            syncInProgress: this.syncInProgress,
            lastSyncTime: this.lastSyncTime,
            serviceName: 'StatsSyncService'
        };
    }

    // Health check
    async healthCheck() {
        try {
            if (!this.tank01Service) {
                return {
                    status: 'unhealthy',
                    error: 'Tank01 service not available'
                };
            }

            const tank01Health = await this.tank01Service.healthCheck();
            
            return {
                status: tank01Health.status,
                tank01Service: tank01Health,
                syncInProgress: this.syncInProgress
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message
            };
        }
    }

    // Recalculate team scores for a specific week/season after stats sync
    async recalculateTeamScores(week, season) {
        try {
            logInfo(`Recalculating team scores for Week ${week}, ${season}`);
            
            // Get all teams
            const teams = await this.db.all('SELECT team_id FROM teams');
            
            for (const team of teams) {
                // Calculate total points for starters
                const result = await this.db.get(`
                    SELECT SUM(ps.fantasy_points) as total_points
                    FROM fantasy_rosters fr
                    JOIN player_stats ps ON fr.player_id = ps.player_id
                    WHERE fr.team_id = ? AND ps.week = ? AND ps.season = ?
                    AND fr.roster_position = 'starter'
                `, [team.team_id, week, season]);
                
                const totalPoints = result?.total_points || 0;
                
                // Update matchup scores for this team as team1
                await this.db.run(`
                    UPDATE matchups 
                    SET team1_points = ? 
                    WHERE team1_id = ? AND week = ? AND season = ?
                `, [totalPoints, team.team_id, week, season]);
                
                // Update matchup scores for this team as team2
                await this.db.run(`
                    UPDATE matchups 
                    SET team2_points = ? 
                    WHERE team2_id = ? AND week = ? AND season = ?
                `, [totalPoints, team.team_id, week, season]);
            }
            
            logInfo(`Team scores recalculated for ${teams.length} teams`);
            
        } catch (error) {
            logError(`Error recalculating team scores for Week ${week}, ${season}:`, error);
            throw error;
        }
    }
}

module.exports = StatsSyncService;