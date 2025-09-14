const path = require('path');
const DatabaseManager = require('../database/database');
const Tank01Service = require('./tank01Service');
const NFLGamesService = require('./nflGamesService');
const ScoringService = require('./scoringService');
const PlayerSyncService = require('./playerSyncService');
const DSTManagementService = require('./dstManagementService');
const IndividualPlayerScoringService = require('./individualPlayerScoringService');
const DataCleanupService = require('./dataCleanupService');
const StatsExtractionService = require('./statsExtractionService');
const GameScoreService = require('./gameScoreService');
const FantasyPointsCalculationService = require('./fantasyPointsCalculationService');
const TeamScoreService = require('./teamScoreService');
const ScoringPlayersService = require('./scoringPlayersService');
const StandingsService = require('./standingsService');
const { logInfo, logError, logWarn } = require('../utils/errorHandler');

class SeasonRecalculationOrchestrator {
    constructor(season = 2024, totalWeeks = 17) {
        this.season = season;
        this.totalWeeks = totalWeeks;
        
        // Initialize database
        this.db = new DatabaseManager();
        
        // Initialize services
        this.tank01Service = new Tank01Service(process.env.TANK01_API_KEY, this.db);
        this.nflGamesService = new NFLGamesService(this.db, this.tank01Service);
        this.scoringService = new ScoringService(this.db);
        this.playerSyncService = new PlayerSyncService(this.db, this.tank01Service);
        this.dstManagementService = new DSTManagementService(this.db, this.tank01Service);
        this.individualPlayerScoringService = new IndividualPlayerScoringService(this.db);
        this.dataCleanupService = new DataCleanupService(this.db);
        this.statsExtractionService = new StatsExtractionService(this.db);
        this.gameScoreService = new GameScoreService(this.db, this.tank01Service);
        this.fantasyPointsCalculationService = new FantasyPointsCalculationService(this.db, this.scoringService);
        this.teamScoreService = new TeamScoreService(this.db);
        this.scoringPlayersService = new ScoringPlayersService(this.db);
        this.standingsService = new StandingsService(this.db);
        
        // Performance tracking
        this.startTime = null;
        this.weekTimes = {};
    }

    /**
     * Main orchestration method with performance optimizations
     */
    async run() {
        this.startTime = Date.now();
        
        try {
            logInfo(`🔄 Starting ${this.season} season recalculation...`);
            
            // Step 0a: Sync all players from Tank01
            logInfo('📥 Syncing NFL players from Tank01...');
            const playerSyncResult = await this.playerSyncService.syncPlayers();
            if (playerSyncResult.success) {
                logInfo(`  ✓ Synced ${playerSyncResult.players_synced} players`);
            } else {
                logWarn(`  ⚠ Player sync failed: ${playerSyncResult.error || 'Unknown error'}`);
            }
            
            // Step 0b: Ensure DST players exist
            await this.dstManagementService.ensureDSTPlayersExist();
            
            // Step 1: Clean existing data with transaction
            await this.db.beginTransaction();
            try {
                await this.dataCleanupService.cleanExistingData(this.season);
                await this.db.commit();
            } catch (error) {
                await this.db.rollback();
                throw error;
            }
            
            // Step 2: Sync all weeks
            for (let week = 1; week <= this.totalWeeks; week++) {
                const weekStart = Date.now();
                logInfo(`\n📅 Processing Week ${week}...`);
                
                // Start transaction for entire week processing
                await this.db.beginTransaction();
                
                try {
                    // Sync games for the week
                    await this.syncWeekGames(week);
                    
                    // Sync player stats with batching
                    await this.syncWeekStatsDirectly(week);
                    
                    // Commit the entire week's changes
                    await this.db.commit();
                    
                    const weekTime = Date.now() - weekStart;
                    this.weekTimes[week] = weekTime;
                    logInfo(`  ⏱️ Week ${week} completed in ${(weekTime / 1000).toFixed(2)} seconds`);
                    
                } catch (error) {
                    await this.db.rollback();
                    logError(`Error processing Week ${week}:`, error);
                    throw error;
                }
            }
            
            // Step 3: Calculate all fantasy points in a transaction
            logInfo('\n💯 Calculating fantasy points for all players...');
            await this.db.beginTransaction();
            logInfo('  Transaction started');
            try {
                await this.fantasyPointsCalculationService.calculateAllFantasyPoints(this.season);
                await this.db.commit();
                logInfo('  Transaction committed successfully');

                // Verify a sample was actually updated
                const sampleCheck = await this.db.get(
                    'SELECT fantasy_points FROM player_stats WHERE season = ? AND fantasy_points > 0 LIMIT 1',
                    [this.season]
                );
                if (sampleCheck) {
                    logInfo(`  ✓ Verification: Found player with ${sampleCheck.fantasy_points} fantasy points`);
                } else {
                    logError('  ⚠️ WARNING: No players have fantasy_points > 0 after commit!');
                }
            } catch (error) {
                await this.db.rollback();
                logError('  Transaction rolled back due to error:', error);
                logError('  Error details:', {
                    message: error?.message,
                    stack: error?.stack?.split('\n')[0],
                    type: error?.constructor?.name
                });
                throw error;
            }
            
            // Step 4: Calculate defense bonuses for all weeks
            logInfo('\n🛡️ Calculating defense bonuses for all weeks...');
            await this.db.beginTransaction();
            try {
                for (let week = 1; week <= this.totalWeeks; week++) {
                    await this.scoringService.calculateDefensiveBonuses(week, this.season);
                }
                await this.db.commit();
            } catch (error) {
                await this.db.rollback();
                throw error;
            }
            
            // Step 5: Calculate DST fantasy points after bonuses
            logInfo('\n🛡️ Calculating DST bonuses...');
            await this.db.beginTransaction();
            try {
                await this.fantasyPointsCalculationService.calculateEndOfWeekDSTBonuses(this.season);
                await this.db.commit();
            } catch (error) {
                await this.db.rollback();
                throw error;
            }
            
            // Step 6: Calculate scoring players for all weeks
            logInfo('\n🏆 Calculating scoring players for all weeks...');
            await this.db.beginTransaction();
            try {
                for (let week = 1; week <= this.totalWeeks; week++) {
                    await this.scoringPlayersService.calculateScoringPlayers(week, this.season);
                }
                await this.db.commit();
            } catch (error) {
                await this.db.rollback();
                throw error;
            }
            
            // Step 7: Recalculate all team scores
            logInfo('\n📊 Recalculating team scores for all weeks...');
            await this.db.beginTransaction();
            try {
                await this.teamScoreService.recalculateSeasonScores(this.season, 1, this.totalWeeks);
                await this.db.commit();
            } catch (error) {
                await this.db.rollback();
                throw error;
            }
            
            // Step 8: Calculate standings for all weeks
            logInfo('\n📈 Calculating standings for all weeks...');
            await this.db.beginTransaction();
            try {
                for (let week = 1; week <= this.totalWeeks; week++) {
                    await this.standingsService.calculateWeeklyStandings(week, this.season);
                }
                await this.db.commit();
            } catch (error) {
                await this.db.rollback();
                throw error;
            }
            
            const totalTime = Date.now() - this.startTime;
            logInfo(`\n✅ ${this.season} season recalculation completed successfully!`);
            
            // Print summary
            await this.printSummary();

            // Final verification
            const finalCheck = await this.db.get(
                'SELECT COUNT(*) as total, COUNT(CASE WHEN fantasy_points > 0 THEN 1 END) as with_points FROM player_stats WHERE season = ?',
                [this.season]
            );
            logInfo(`\n📊 Final Verification: ${finalCheck.with_points}/${finalCheck.total} player stats have fantasy points > 0`);
            
        } catch (error) {
            logError('❌ Fatal error during recalculation:', error);
            throw error;
        } finally {
            // Close database connection
            this.db.close();
        }
    }


    /**
     * Sync games for a specific week
     */
    async syncWeekGames(week) {
        try {
            logInfo(`  📋 Syncing games for Week ${week}...`);
            const result = await this.nflGamesService.syncWeekGames(week, this.season);
            
            if (result.success) {
                logInfo(`    ✓ Synced ${result.gamesProcessed} games`);
                
                // Now update scores from boxscore data
                await this.gameScoreService.updateGameScoresFromBoxscores(week, this.season);
            } else {
                logWarn(`    ⚠ Game sync failed: ${result.message}`);
            }
            
            return result;
        } catch (error) {
            logError(`Error syncing games for Week ${week}:`, error);
            throw error;
        }
    }

    /**
     * Sync player stats directly from Tank01 API with optimized batching
     */
    async syncWeekStatsDirectly(week) {
        try {
            logInfo(`  📊 Syncing player stats for Week ${week}...`);
            
            // Get player stats from Tank01 API (cached)
            const boxScoreData = await this.tank01Service.getPlayerStats(week, this.season);
            
            if (!boxScoreData) {
                logWarn(`No boxscore data for week ${week}`);
                return;
            }
            
            // Collect all stats for batch processing
            const allStats = [];
            const dstStatsToProcess = [];
            
            // Process all games in parallel for stats extraction
            const gamePromises = Object.keys(boxScoreData).map(async (gameId) => {
                const game = boxScoreData[gameId];
                
                if (!game.playerStats) {
                    logWarn(`No playerStats in game ${gameId}`);
                    return { stats: [], dstStats: null };
                }
                
                const gameStats = [];
                
                // Process player stats
                for (const playerId of Object.keys(game.playerStats)) {
                    const playerData = game.playerStats[playerId];
                    
                    if (!playerData || !playerData.longName) {
                        continue;
                    }
                    
                    // Extract stats
                    const stats = await this.statsExtractionService.extractPlayerStats(
                        playerId, 
                        playerData, 
                        week, 
                        gameId, 
                        this.season
                    );
                    
                    if (stats) {
                        gameStats.push(stats);
                    }
                }
                
                // Collect DST stats for later processing
                let gameDstStats = null;
                // DST data is directly on the boxscore object from Tank01
                if (game.DST) {
                    gameDstStats = { DST: game.DST, game, week, gameId, season: this.season };
                } else {
                    // Log if DST data is missing for debugging
                    logWarn(`No DST data found for game ${gameId} in week ${week}`);
                }
                
                return { stats: gameStats, dstStats: gameDstStats };
            });
            
            // Wait for all games to be processed
            const gameResults = await Promise.all(gamePromises);
            
            // Collect all stats
            for (const result of gameResults) {
                allStats.push(...result.stats);
                if (result.dstStats) {
                    dstStatsToProcess.push(result.dstStats);
                }
            }
            
            // Batch insert all player stats
            if (allStats.length > 0) {
                await this.batchInsertStats(allStats);
            }
            
            // Process DST stats
            for (const dstData of dstStatsToProcess) {
                await this.dstManagementService.processDSTStats(
                    dstData.DST, 
                    dstData.game, 
                    dstData.week, 
                    dstData.gameId, 
                    dstData.season
                );
            }
            
            // Process individual player scoring from scoring plays (special teams TDs, etc.)
            await this.individualPlayerScoringService.processWeekScoring(
                this.dstManagementService.scoringPlayParser,
                this.tank01Service,
                week,
                this.season
            );
            
            logInfo(`    ✓ Synced ${allStats.length} player stats + ${dstStatsToProcess.length * 2} DST stats`);
            
        } catch (error) {
            logError(`Error syncing stats for Week ${week}:`, error);
            throw error;
        }
    }

    /**
     * Batch insert stats with prepared statements
     */
    async batchInsertStats(statsList) {
        // First, get all unique player IDs and check which exist
        const playerIds = [...new Set(statsList.map(s => s.player_id))];
        
        // Check which players exist in a single query
        const placeholders = playerIds.map(() => '?').join(',');
        const existingPlayers = await this.db.all(
            `SELECT player_id FROM nfl_players WHERE player_id IN (${placeholders})`,
            playerIds
        );
        const existingPlayerIds = new Set(existingPlayers.map(p => p.player_id));
        
        // Filter stats to only include existing players
        const validStats = statsList.filter(stats => existingPlayerIds.has(stats.player_id));
        
        if (validStats.length === 0) {
            logWarn('No valid stats to insert after filtering');
            return;
        }
        
        // Use the database's bulk insert method (already optimized in transaction)
        const insertQuery = `
            INSERT OR REPLACE INTO player_stats (
                player_id, week, season, game_id,
                passing_yards, passing_tds, interceptions,
                rushing_yards, rushing_tds, receiving_yards,
                receiving_tds, receptions, fumbles, sacks,
                def_interceptions, fumbles_recovered, def_touchdowns,
                safeties, points_allowed, yards_allowed,
                field_goals_made, field_goals_attempted,
                extra_points_made, extra_points_attempted,
                field_goals_0_39, field_goals_40_49, field_goals_50_plus,
                two_point_conversions_pass, two_point_conversions_run,
                two_point_conversions_rec, fantasy_points,
                def_int_return_tds, def_fumble_return_tds, def_blocked_return_tds,
                kick_return_tds, punt_return_tds
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        // Insert all stats
        for (const stats of validStats) {
            await this.db.run(insertQuery, [
                stats.player_id, stats.week, stats.season, stats.game_id,
                stats.passing_yards, stats.passing_tds, stats.interceptions,
                stats.rushing_yards, stats.rushing_tds, stats.receiving_yards,
                stats.receiving_tds, stats.receptions, stats.fumbles, stats.sacks,
                stats.def_interceptions, stats.fumbles_recovered, stats.def_touchdowns,
                stats.safeties, stats.points_allowed, stats.yards_allowed,
                stats.field_goals_made, stats.field_goals_attempted,
                stats.extra_points_made, stats.extra_points_attempted,
                stats.field_goals_0_39, stats.field_goals_40_49, stats.field_goals_50_plus,
                stats.two_point_conversions_pass, stats.two_point_conversions_run,
                stats.two_point_conversions_rec, stats.fantasy_points,
                stats.def_int_return_tds || 0, stats.def_fumble_return_tds || 0, stats.def_blocked_return_tds || 0,
                stats.kick_return_tds || 0, stats.punt_return_tds || 0
            ]);
        }
        
        logInfo(`  ✓ Batch inserted ${validStats.length} stats (${statsList.length - validStats.length} skipped)`);
    }

    /**
     * Print final summary with performance metrics
     */
    async printSummary() {
        try {
            logInfo('\n📈 Final Summary:');
            
            // Count total games
            const gamesCount = await this.db.get(
                'SELECT COUNT(*) as count FROM nfl_games WHERE season = ?',
                [this.season]
            );
            logInfo(`  • Total games: ${gamesCount.count}`);
            
            // Count total player stats
            const statsCount = await this.db.get(
                'SELECT COUNT(*) as count FROM player_stats WHERE season = ?',
                [this.season]
            );
            logInfo(`  • Total player stats: ${statsCount.count}`);
            
            // Count DST stats
            const dstCount = await this.db.get(`
                SELECT COUNT(*) as count 
                FROM player_stats ps
                JOIN nfl_players p ON ps.player_id = p.player_id
                WHERE ps.season = ? AND p.position = 'DST'
            `, [this.season]);
            logInfo(`  • Total DST stats: ${dstCount.count}`);
            
            // Count stats with fantasy points
            const withPoints = await this.db.get(
                'SELECT COUNT(*) as count FROM player_stats WHERE season = ? AND fantasy_points > 0',
                [this.season]
            );
            logInfo(`  • Stats with fantasy points: ${withPoints.count}`);
            
            // Average points per week
            const avgPoints = await this.db.get(`
                SELECT AVG(team1_points + team2_points) as avg_points
                FROM matchups
                WHERE season = ?
            `, [this.season]);
            logInfo(`  • Average points per matchup: ${(avgPoints.avg_points || 0).toFixed(2)}`);
            
            // Performance metrics
            logInfo('\n⏱️ Performance Metrics:');
            const totalTime = Date.now() - this.startTime;
            logInfo(`  • Total execution time: ${(totalTime / 1000).toFixed(2)} seconds`);
            logInfo(`  • Average time per week: ${(totalTime / this.totalWeeks / 1000).toFixed(2)} seconds`);
            
            // Show slowest weeks
            const sortedWeeks = Object.entries(this.weekTimes)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3);
            logInfo('  • Slowest weeks:');
            for (const [week, time] of sortedWeeks) {
                logInfo(`    - Week ${week}: ${(time / 1000).toFixed(2)} seconds`);
            }
            
        } catch (error) {
            logError('Error printing summary:', error);
        }
    }
}

module.exports = SeasonRecalculationOrchestrator;