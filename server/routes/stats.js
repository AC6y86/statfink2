const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const router = express.Router();

// Get player stats for specific week
router.get('/:playerId/:week/:season', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { playerId, week, season } = req.params;
    
    // Validate parameters
    if (!playerId) {
        throw new APIError('Player ID is required', 400);
    }
    
    const weekNum = parseInt(week);
    const seasonYear = parseInt(season);
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        throw new APIError('Week must be between 1 and 18', 400);
    }
    
    if (isNaN(seasonYear) || seasonYear < 2020 || seasonYear > 2030) {
        throw new APIError('Invalid season year', 400);
    }
    
    const stats = await db.getPlayerStats(playerId, weekNum, seasonYear);
    
    if (!stats) {
        // Return empty stats structure instead of 404
        const emptyStats = {
            player_id: playerId,
            week: weekNum,
            season: seasonYear,
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
            field_goals_50_plus: 0,
            fantasy_points: 0,
            last_updated: null
        };
        
        return res.json({
            success: true,
            data: emptyStats,
            hasData: false
        });
    }
    
    res.json({
        success: true,
        data: stats,
        hasData: true
    });
}));

// Get player stats for entire season
router.get('/:playerId/season/:season', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { playerId, season } = req.params;
    
    if (!playerId) {
        throw new APIError('Player ID is required', 400);
    }
    
    const seasonYear = parseInt(season);
    if (isNaN(seasonYear) || seasonYear < 2020 || seasonYear > 2030) {
        throw new APIError('Invalid season year', 400);
    }
    
    const stats = await db.all(`
        SELECT * FROM player_stats 
        WHERE player_id = ? AND season = ? 
        ORDER BY week ASC
    `, [playerId, seasonYear]);
    
    // Calculate season totals
    const seasonTotals = stats.reduce((totals, weekStats) => {
        Object.keys(weekStats).forEach(key => {
            if (typeof weekStats[key] === 'number' && 
                !['stat_id', 'week', 'season'].includes(key)) {
                totals[key] = (totals[key] || 0) + weekStats[key];
            }
        });
        return totals;
    }, {});
    
    res.json({
        success: true,
        data: {
            weeklyStats: stats,
            seasonTotals,
            gamesPlayed: stats.length,
            averagePoints: stats.length > 0 ? seasonTotals.fantasy_points / stats.length : 0
        }
    });
}));

// Get weekly rankings for a specific week
router.get('/rankings/:week/:season', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const scoringService = req.app.locals.scoringService;
    const { week, season } = req.params;
    const { position, limit } = req.query;
    
    const weekNum = parseInt(week);
    const seasonYear = parseInt(season);
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        throw new APIError('Week must be between 1 and 18', 400);
    }
    
    if (isNaN(seasonYear) || seasonYear < 2020 || seasonYear > 2030) {
        throw new APIError('Invalid season year', 400);
    }
    
    const rankings = await scoringService.getWeeklyRankings(weekNum, seasonYear, position);
    
    // Apply limit if specified
    const limitedRankings = limit ? rankings.slice(0, parseInt(limit)) : rankings;
    
    // Add rank numbers
    const rankedPlayers = limitedRankings.map((player, index) => ({
        ...player,
        rank: index + 1
    }));
    
    res.json({
        success: true,
        data: rankedPlayers,
        count: rankedPlayers.length,
        filters: {
            week: weekNum,
            season: seasonYear,
            position: position || 'all',
            limit: limit || 'none'
        }
    });
}));

// Get top performers for current/specific week
router.get('/top/:week/:season', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { week, season } = req.params;
    const { limit = 10 } = req.query;
    
    const weekNum = parseInt(week);
    const seasonYear = parseInt(season);
    const limitNum = parseInt(limit);
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        throw new APIError('Week must be between 1 and 18', 400);
    }
    
    if (isNaN(seasonYear) || seasonYear < 2020 || seasonYear > 2030) {
        throw new APIError('Invalid season year', 400);
    }
    
    const topPerformers = await db.all(`
        SELECT 
            ps.*,
            p.name,
            p.position,
            p.team
        FROM player_stats ps
        JOIN nfl_players p ON ps.player_id = p.player_id
        WHERE ps.week = ? AND ps.season = ?
        ORDER BY ps.fantasy_points DESC
        LIMIT ?
    `, [weekNum, seasonYear, limitNum]);
    
    res.json({
        success: true,
        data: topPerformers.map((player, index) => ({
            ...player,
            rank: index + 1
        })),
        count: topPerformers.length,
        week: weekNum,
        season: seasonYear
    });
}));

// Get player projections
router.get('/projections/:playerId/:week/:season', asyncHandler(async (req, res) => {
    const scoringService = req.app.locals.scoringService;
    const { playerId, week, season } = req.params;
    
    if (!playerId) {
        throw new APIError('Player ID is required', 400);
    }
    
    const weekNum = parseInt(week);
    const seasonYear = parseInt(season);
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        throw new APIError('Week must be between 1 and 18', 400);
    }
    
    if (isNaN(seasonYear) || seasonYear < 2020 || seasonYear > 2030) {
        throw new APIError('Invalid season year', 400);
    }
    
    try {
        const projection = await scoringService.getPlayerProjections(playerId, weekNum, seasonYear);
        
        res.json({
            success: true,
            data: {
                player_id: playerId,
                week: weekNum,
                season: seasonYear,
                projected_points: projection,
                note: 'Projection based on recent performance average'
            }
        });
    } catch (error) {
        res.json({
            success: true,
            data: {
                player_id: playerId,
                week: weekNum,
                season: seasonYear,
                projected_points: 0,
                note: 'No recent data available for projection'
            }
        });
    }
}));

module.exports = router;