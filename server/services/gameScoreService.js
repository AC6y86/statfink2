const { logInfo, logError, logWarn } = require('../utils/errorHandler');

class GameScoreService {
    constructor(db, tank01Service) {
        this.db = db;
        this.tank01Service = tank01Service;
    }

    /**
     * Update game scores from boxscores for a specific week
     */
    async updateGameScoresFromBoxscores(week, season) {
        try {
            // Get all games for this week from database
            const games = await this.db.all(`
                SELECT game_id, home_team, away_team, home_score, away_score
                FROM nfl_games 
                WHERE week = ? AND season = ?
            `, [week, season]);
            
            logInfo(`    📊 Updating scores for ${games.length} games...`);
            let updated = 0;
            let failed = 0;
            
            for (const game of games) {
                try {
                    // Fetch boxscore data
                    const boxScore = await this.tank01Service.getNFLBoxScore(game.game_id);
                    
                    if (!boxScore) {
                        failed++;
                        continue;
                    }
                    
                    // Extract scores
                    const scores = this.extractScoresFromBoxscore(boxScore);
                    
                    // Update database if we found scores
                    if (scores.homeScore > 0 || scores.awayScore > 0) {
                        await this.updateGameScore(game.game_id, scores.homeScore, scores.awayScore);
                        updated++;
                    } else {
                        failed++;
                    }
                    
                    // Small delay to avoid rate limiting
                    await this.delay(100);
                    
                } catch (error) {
                    logWarn(`      Failed to update scores for game ${game.game_id}: ${error.message}`);
                    failed++;
                }
            }
            
            logInfo(`    ✓ Updated scores for ${updated} games${failed > 0 ? `, ${failed} failed` : ''}`);
            
            return {
                success: true,
                updated,
                failed,
                total: games.length
            };
            
        } catch (error) {
            logError(`Error updating game scores for week ${week}:`, error);
            throw error;
        }
    }

    /**
     * Extract home and away scores from boxscore data
     * Handles multiple data formats from Tank01 API
     */
    extractScoresFromBoxscore(boxScore) {
        let homeScore = 0;
        let awayScore = 0;
        
        // Try first format: direct properties
        if (boxScore.homePts !== undefined && boxScore.awayPts !== undefined) {
            homeScore = parseInt(boxScore.homePts) || 0;
            awayScore = parseInt(boxScore.awayPts) || 0;
        } 
        // Try second format: lineScore structure
        else if (boxScore.lineScore?.home?.totalPts && boxScore.lineScore?.away?.totalPts) {
            homeScore = parseInt(boxScore.lineScore.home.totalPts) || 0;
            awayScore = parseInt(boxScore.lineScore.away.totalPts) || 0;
        }
        // Try third format: check for team-specific score properties
        else if (boxScore.home?.score !== undefined && boxScore.away?.score !== undefined) {
            homeScore = parseInt(boxScore.home.score) || 0;
            awayScore = parseInt(boxScore.away.score) || 0;
        }
        
        return { homeScore, awayScore };
    }

    /**
     * Update game score in database
     */
    async updateGameScore(gameId, homeScore, awayScore) {
        await this.db.run(`
            UPDATE nfl_games 
            SET home_score = ?, away_score = ?, last_updated = CURRENT_TIMESTAMP
            WHERE game_id = ?
        `, [homeScore, awayScore, gameId]);
    }

    /**
     * Get game scores for a specific week
     */
    async getWeekScores(week, season) {
        try {
            const games = await this.db.all(`
                SELECT 
                    game_id,
                    home_team,
                    away_team,
                    home_score,
                    away_score,
                    game_status
                FROM nfl_games 
                WHERE week = ? AND season = ?
                ORDER BY game_time
            `, [week, season]);
            
            return games;
        } catch (error) {
            logError(`Error getting week ${week} scores:`, error);
            throw error;
        }
    }

    /**
     * Verify all games in a week have scores
     */
    async verifyWeekScores(week, season) {
        try {
            const result = await this.db.get(`
                SELECT 
                    COUNT(*) as total_games,
                    COUNT(CASE WHEN home_score IS NOT NULL AND away_score IS NOT NULL THEN 1 END) as games_with_scores,
                    COUNT(CASE WHEN home_score IS NULL OR away_score IS NULL THEN 1 END) as games_without_scores
                FROM nfl_games 
                WHERE week = ? AND season = ?
            `, [week, season]);
            
            return {
                totalGames: result.total_games,
                gamesWithScores: result.games_with_scores,
                gamesWithoutScores: result.games_without_scores,
                complete: result.games_without_scores === 0
            };
        } catch (error) {
            logError(`Error verifying week ${week} scores:`, error);
            throw error;
        }
    }

    /**
     * Utility function for delays
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = GameScoreService;