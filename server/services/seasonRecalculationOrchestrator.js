const path = require('path');
const DatabaseManager = require('../database/database');
const Tank01Service = require('./tank01Service');
const NFLGamesService = require('./nflGamesService');
const ScoringService = require('./scoringService');
const PlayerSyncService = require('./playerSyncService');
const DSTManagementService = require('./dstManagementService');
const DataCleanupService = require('./dataCleanupService');
const StatsExtractionService = require('./statsExtractionService');
const GameScoreService = require('./gameScoreService');
const FantasyPointsCalculationService = require('./fantasyPointsCalculationService');
const TeamScoreService = require('./teamScoreService');
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
        this.dstManagementService = new DSTManagementService(this.db);
        this.dataCleanupService = new DataCleanupService(this.db);
        this.statsExtractionService = new StatsExtractionService(this.db);
        this.gameScoreService = new GameScoreService(this.db, this.tank01Service);
        this.fantasyPointsCalculationService = new FantasyPointsCalculationService(this.db, this.scoringService);
        this.teamScoreService = new TeamScoreService(this.db);
    }

    /**
     * Main orchestration method
     */
    async run() {
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
            
            // Step 1: Clean existing data
            await this.dataCleanupService.cleanExistingData(this.season);
            
            // Step 2: Sync all weeks
            for (let week = 1; week <= this.totalWeeks; week++) {
                logInfo(`\n📅 Processing Week ${week}...`);
                
                // Sync games for the week
                await this.syncWeekGames(week);
                
                // Sync player stats directly from Tank01 data
                await this.syncWeekStatsDirectly(week);
                
                // Small delay between weeks
                await this.delay(500);
            }
            
            // Step 3: Calculate all fantasy points
            logInfo('\n💯 Calculating fantasy points for all players...');
            await this.fantasyPointsCalculationService.calculateAllFantasyPoints(this.season);
            
            // Step 4: Calculate defense bonuses for all weeks
            logInfo('\n🛡️ Calculating defense bonuses for all weeks...');
            for (let week = 1; week <= this.totalWeeks; week++) {
                await this.scoringService.calculateDefensiveBonuses(week, this.season);
            }
            
            // Step 5: Calculate DST fantasy points after bonuses
            logInfo('\n🛡️ Calculating DST bonuses...');
            await this.fantasyPointsCalculationService.calculateEndOfWeekDSTBonuses(this.season);
            
            // Step 6: Recalculate all team scores
            logInfo('\n📊 Recalculating team scores for all weeks...');
            await this.teamScoreService.recalculateSeasonScores(this.season, 1, this.totalWeeks);
            
            logInfo(`\n✅ ${this.season} season recalculation completed successfully!`);
            
            // Print summary
            await this.printSummary();
            
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
     * Sync player stats directly from Tank01 API
     */
    async syncWeekStatsDirectly(week) {
        try {
            logInfo(`  📊 Syncing player stats for Week ${week}...`);
            
            // Get player stats from Tank01 API
            const boxScoreData = await this.tank01Service.getPlayerStats(week, this.season);
            
            if (!boxScoreData) {
                logWarn(`No boxscore data for week ${week}`);
                return;
            }
            
            let statsCount = 0;
            
            // Process each game
            for (const gameId of Object.keys(boxScoreData)) {
                const game = boxScoreData[gameId];
                
                if (!game.playerStats) {
                    logWarn(`No playerStats in game ${gameId}`);
                    continue;
                }
                
                // Process player stats
                for (const playerId of Object.keys(game.playerStats)) {
                    const playerData = game.playerStats[playerId];
                    
                    if (!playerData || !playerData.longName) {
                        continue;
                    }
                    
                    // Use the Tank01 player ID directly
                    const stats = await this.statsExtractionService.extractPlayerStats(
                        playerId, 
                        playerData, 
                        week, 
                        gameId, 
                        this.season
                    );
                    
                    if (stats) {
                        await this.statsExtractionService.insertPlayerStats(stats);
                        statsCount++;
                    }
                }
                
                // Process DST stats
                if (game.DST) {
                    await this.dstManagementService.processDSTStats(
                        game.DST, 
                        game, 
                        week, 
                        gameId, 
                        this.season
                    );
                    statsCount += 2; // home and away DST
                }
            }
            
            logInfo(`    ✓ Synced ${statsCount} player stats`);
            
        } catch (error) {
            logError(`Error syncing stats for Week ${week}:`, error);
            throw error;
        }
    }

    /**
     * Print final summary
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
            
        } catch (error) {
            logError('Error printing summary:', error);
        }
    }

    /**
     * Utility function for delays
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = SeasonRecalculationOrchestrator;