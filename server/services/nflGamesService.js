const { logInfo, logError, logWarn } = require('../utils/errorHandler');

class NFLGamesService {
    constructor(db, tank01Service) {
        this.db = db;
        this.tank01Service = tank01Service;
        this.syncInProgress = false;
        this.lastSyncTime = null;
        this.liveUpdateInterval = null;
    }

    /**
     * Sync games for a specific week from Tank01 API
     */
    async syncWeekGames(week, season) {
        if (this.syncInProgress) {
            logWarn('Games sync already in progress, skipping');
            return { success: false, message: 'Sync already in progress' };
        }

        if (!this.tank01Service) {
            logError('Tank01 service not available for games sync');
            return { success: false, message: 'Tank01 service not configured' };
        }

        this.syncInProgress = true;
        const startTime = Date.now();
        let gamesProcessed = 0;

        try {
            logInfo(`Starting games synchronization for Week ${week}, ${season}`);
            
            // Get games from Tank01 API
            const gamesData = await this.tank01Service.getNFLGamesForWeek(week, season);
            
            if (!gamesData || typeof gamesData !== 'object') {
                throw new Error('No games data received from Tank01 API');
            }

            // Tank01 returns games as numbered properties (0, 1, 2, etc.)
            const allValues = Object.values(gamesData);
            const games = allValues.filter(game => game && typeof game === 'object' && game.gameID);
            
            if (games.length === 0) {
                logWarn(`No valid games found for week ${week}, season ${season}`);
                return { success: true, message: 'No games found for this week', gamesProcessed: 0 };
            }

            logInfo(`Found ${games.length} games for week ${week}`);

            // Process each game
            for (const game of games) {
                try {
                    await this.upsertGame(game, week, season);
                    gamesProcessed++;
                } catch (gameError) {
                    logError(`Failed to process game ${game.gameID}:`, gameError);
                }
            }

            // After syncing games, update scores from boxscore data
            if (gamesProcessed > 0) {
                const scoresUpdated = await this.updateGameScoresFromBoxscores(week, season);
                logInfo(`Updated scores for ${scoresUpdated} games`);
            }
            
            const duration = Date.now() - startTime;
            this.lastSyncTime = new Date();

            logInfo(`Games sync completed for week ${week}: ${gamesProcessed} games processed in ${duration}ms`);
            
            return {
                success: true,
                message: `Successfully synced ${gamesProcessed} games`,
                gamesProcessed,
                duration
            };

        } catch (error) {
            logError(`Failed to sync games for week ${week}, season ${season}:`, error);
            return {
                success: false,
                message: error.message,
                gamesProcessed
            };
        } finally {
            this.syncInProgress = false;
        }
    }

    /**
     * Update game scores from boxscore data
     */
    async updateGameScoresFromBoxscores(week, season) {
        try {
            // Get all games for this week from database
            const games = await this.db.all(`
                SELECT game_id, home_team, away_team, home_score, away_score
                FROM nfl_games 
                WHERE week = ? AND season = ?
            `, [week, season]);
            
            logInfo(`    📊 Fetching boxscores for ${games.length} games...`);
            let updated = 0;
            
            for (const game of games) {
                try {
                    // Fetch boxscore data
                    const boxScore = await this.tank01Service.getNFLBoxScore(game.game_id);
                    
                    if (!boxScore) {
                        continue;
                    }
                    
                    // Extract scores
                    let homeScore = 0;
                    let awayScore = 0;
                    
                    if (boxScore.homePts !== undefined && boxScore.awayPts !== undefined) {
                        homeScore = parseInt(boxScore.homePts) || 0;
                        awayScore = parseInt(boxScore.awayPts) || 0;
                    } else if (boxScore.lineScore?.home?.totalPts && boxScore.lineScore?.away?.totalPts) {
                        homeScore = parseInt(boxScore.lineScore.home.totalPts) || 0;
                        awayScore = parseInt(boxScore.lineScore.away.totalPts) || 0;
                    }
                    
                    // Update database if we found scores different from current
                    if ((homeScore > 0 || awayScore > 0) && 
                        (homeScore !== game.home_score || awayScore !== game.away_score)) {
                        await this.db.run(`
                            UPDATE nfl_games 
                            SET home_score = ?, away_score = ?, last_updated = CURRENT_TIMESTAMP
                            WHERE game_id = ?
                        `, [homeScore, awayScore, game.game_id]);
                        updated++;
                    }
                    
                    // Small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                } catch (error) {
                    logWarn(`      Failed to update scores for game ${game.game_id}: ${error.message}`);
                }
            }
            
            return updated;
            
        } catch (error) {
            logError(`Error updating game scores for week ${week}:`, error);
            return 0;
        }
    }

    /**
     * Insert or update a game in the database
     */
    async upsertGame(gameData, week, season) {
        const {
            gameID,
            home = '',
            away = '',
            gameDate = null,
            gameTime = null,
            gameStatus = 'Scheduled',
            quarter = null,
            gameTimeLeft = null,
            venue = null
        } = gameData;

        // Extract scores from gameData if available
        let homeScore = 0;
        let awayScore = 0;

        // Check for scores in the game data
        if (gameData.homePts !== undefined && gameData.awayPts !== undefined) {
            homeScore = parseInt(gameData.homePts) || 0;
            awayScore = parseInt(gameData.awayPts) || 0;
        } else if (gameData.homeScore !== undefined && gameData.awayScore !== undefined) {
            homeScore = parseInt(gameData.homeScore) || 0;
            awayScore = parseInt(gameData.awayScore) || 0;
        }

        await this.db.run(`
            INSERT OR REPLACE INTO nfl_games (
                game_id, week, season, home_team, away_team,
                home_score, away_score, game_date, game_time,
                status, quarter, time_remaining, venue, last_updated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [
            gameID,
            week,
            season,
            home.toUpperCase(),
            away.toUpperCase(),
            homeScore,
            awayScore,
            gameDate,
            gameTime,
            gameStatus || 'Scheduled',
            quarter,
            gameTimeLeft,
            venue
        ]);

        logInfo(`Upserted game: ${away} @ ${home} (${gameID}) - Score: ${awayScore}-${homeScore}`);
    }

    /**
     * Update live scores for all active games
     */
    async updateLiveScores() {
        try {
            logInfo('Starting live scores update');

            // Get all games that are currently live or scheduled for today
            const liveGames = await this.db.all(`
                SELECT game_id, week, season, home_team, away_team, status
                FROM nfl_games 
                WHERE status IN ('Live', 'In Progress', 'Scheduled', 'Halftime')
                  AND date(game_date) = date('now')
                ORDER BY game_date
            `);

            if (liveGames.length === 0) {
                logInfo('No live games to update');
                return { success: true, gamesUpdated: 0 };
            }

            logInfo(`Found ${liveGames.length} games to check for updates`);
            let gamesUpdated = 0;

            // Update each live game
            for (const game of liveGames) {
                try {
                    const updated = await this.updateGameFromAPI(game.game_id);
                    if (updated) gamesUpdated++;
                } catch (error) {
                    logWarn(`Failed to update game ${game.game_id}:`, error);
                }
            }

            logInfo(`Live scores update completed: ${gamesUpdated} games updated`);
            return { success: true, gamesUpdated };

        } catch (error) {
            logError('Failed to update live scores:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Update a specific game from Tank01 API
     */
    async updateGameFromAPI(gameId) {
        try {
            const boxScore = await this.tank01Service.getNFLBoxScore(gameId);
            
            if (!boxScore || !boxScore.gameID) {
                logWarn(`No valid box score data for game ${gameId}`);
                return false;
            }

            // Extract scores from multiple possible locations in box score
            let homeScore = 0;
            let awayScore = 0;

            // Method 1: Direct homePts/awayPts fields
            if (boxScore.homePts !== undefined && boxScore.awayPts !== undefined) {
                homeScore = parseInt(boxScore.homePts) || 0;
                awayScore = parseInt(boxScore.awayPts) || 0;
            }
            // Method 2: lineScore totals (fallback)
            else if (boxScore.lineScore?.home?.totalPts && boxScore.lineScore?.away?.totalPts) {
                homeScore = parseInt(boxScore.lineScore.home.totalPts) || 0;
                awayScore = parseInt(boxScore.lineScore.away.totalPts) || 0;
            }

            // Extract other game data
            const gameStatus = boxScore.gameStatus || 'Scheduled';
            const quarter = boxScore.currentPeriod || null;
            const gameTimeLeft = boxScore.gameClock || null;

            // Update game in database
            await this.db.run(`
                UPDATE nfl_games 
                SET home_score = ?, away_score = ?, status = ?, 
                    quarter = ?, time_remaining = ?, last_updated = CURRENT_TIMESTAMP
                WHERE game_id = ?
            `, [homeScore, awayScore, gameStatus, quarter, gameTimeLeft, gameId]);

            logInfo(`Updated game ${gameId}: ${gameStatus} (${awayScore}-${homeScore})`);
            return true;

        } catch (error) {
            logError(`Failed to update game ${gameId} from API:`, error);
            return false;
        }
    }

    /**
     * Check if all games for a week are complete
     */
    async areAllWeekGamesComplete(week, season) {
        try {
            const result = await this.db.get(`
                SELECT 
                    COUNT(*) as total_games,
                    COUNT(CASE WHEN status = 'Final' THEN 1 END) as completed_games,
                    COUNT(CASE WHEN status IN ('Live', 'In Progress', 'Halftime') THEN 1 END) as live_games,
                    COUNT(CASE WHEN status = 'Scheduled' THEN 1 END) as scheduled_games
                FROM nfl_games 
                WHERE week = ? AND season = ?
            `, [week, season]);

            const isComplete = result.total_games > 0 && result.completed_games === result.total_games;

            return {
                isComplete,
                totalGames: result.total_games,
                completedGames: result.completed_games,
                liveGames: result.live_games,
                scheduledGames: result.scheduled_games,
                completionPercentage: result.total_games > 0 ? 
                    Math.round((result.completed_games / result.total_games) * 100) : 0
            };

        } catch (error) {
            logError(`Failed to check week completion for week ${week}, season ${season}:`, error);
            throw error;
        }
    }

    /**
     * Get games for a specific week
     */
    async getWeekGames(week, season) {
        try {
            return await this.db.all(`
                SELECT * FROM nfl_games 
                WHERE week = ? AND season = ?
                ORDER BY game_date, game_time
            `, [week, season]);
        } catch (error) {
            logError(`Failed to get games for week ${week}, season ${season}:`, error);
            throw error;
        }
    }

    /**
     * Get games by status
     */
    async getGamesByStatus(status, week = null, season = null) {
        try {
            let query = 'SELECT * FROM nfl_games WHERE status = ?';
            const params = [status];

            if (week !== null && season !== null) {
                query += ' AND week = ? AND season = ?';
                params.push(week, season);
            }

            query += ' ORDER BY game_date, game_time';

            return await this.db.all(query, params);
        } catch (error) {
            logError(`Failed to get games by status ${status}:`, error);
            throw error;
        }
    }

    /**
     * Get current week games
     */
    async getCurrentWeekGames() {
        try {
            return await this.db.all(`
                SELECT g.* FROM nfl_games g
                CROSS JOIN league_settings ls
                WHERE g.week = ls.current_week 
                  AND g.season = ls.season_year
                  AND ls.league_id = 1
                ORDER BY g.game_date, g.game_time
            `);
        } catch (error) {
            logError('Failed to get current week games:', error);
            throw error;
        }
    }

    /**
     * Start automatic live score updates during game times
     */
    startLiveUpdates(intervalMinutes = 1) {
        if (this.liveUpdateInterval) {
            this.stopLiveUpdates();
        }

        const intervalMs = intervalMinutes * 60 * 1000;
        logInfo(`Starting live score updates every ${intervalMinutes} minute(s)`);

        this.liveUpdateInterval = setInterval(async () => {
            try {
                await this.updateLiveScores();
            } catch (error) {
                logError('Error in live update interval:', error);
            }
        }, intervalMs);
    }

    /**
     * Stop automatic live score updates
     */
    stopLiveUpdates() {
        if (this.liveUpdateInterval) {
            clearInterval(this.liveUpdateInterval);
            this.liveUpdateInterval = null;
            logInfo('Stopped live score updates');
        }
    }

    /**
     * Get service health status
     */
    async getStatus() {
        try {
            const currentWeekGames = await this.getCurrentWeekGames();
            const weekCompletion = currentWeekGames.length > 0 ? 
                await this.areAllWeekGamesComplete(currentWeekGames[0].week, currentWeekGames[0].season) :
                null;

            return {
                syncInProgress: this.syncInProgress,
                lastSyncTime: this.lastSyncTime,
                liveUpdatesActive: !!this.liveUpdateInterval,
                currentWeekGames: currentWeekGames.length,
                weekCompletion
            };
        } catch (error) {
            logError('Failed to get service status:', error);
            return {
                syncInProgress: this.syncInProgress,
                lastSyncTime: this.lastSyncTime,
                liveUpdatesActive: !!this.liveUpdateInterval,
                error: error.message
            };
        }
    }

    /**
     * Cleanup - stop intervals when service is destroyed
     */
    destroy() {
        this.stopLiveUpdates();
    }
}

module.exports = NFLGamesService;