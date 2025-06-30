const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const router = express.Router();

// Mock NFL games endpoint
router.get('/mock/:week/:season', asyncHandler(async (req, res) => {
    const { week, season } = req.params;
    const weekNum = parseInt(week);
    const seasonYear = parseInt(season);
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        throw new APIError('Week must be between 1 and 18', 400);
    }
    
    // Load mock week data
    let mockGames = [];
    try {
        const { getMockGames, getProgressionState } = require('../../tests/mockWeeks');
        
        // Check if we have progression state (live updates)
        const progressionState = getProgressionState(weekNum);
        const games = progressionState ? progressionState.games : getMockGames(weekNum);
        
        // Process mock games to match the expected format
        mockGames = games.map(game => {
            // Parse game_id to extract date
            const datePart = game.game_id.split('_')[1]; // e.g., "2024" from "mock_2024_01_KC_BAL"
            
            // Generate CBS Sports game URL (using mock prefix)
            const cbsUrl = `https://www.cbssports.com/nfl/gametracker/live/NFL_${game.game_id}/`;
            
            return {
                game_id: game.game_id,
                date: datePart,
                home_team: game.home_team,
                away_team: game.away_team,
                home_score: game.home_score || 0,
                away_score: game.away_score || 0,
                status: game.status || 'Final',
                game_time: game.game_time || null,
                game_url: cbsUrl
            };
        });
    } catch (error) {
        console.error('Error loading mock games:', error);
        // Return empty array if mock data not available
        mockGames = [];
    }
    
    res.json({
        success: true,
        data: mockGames,
        week: weekNum,
        season: seasonYear,
        mock: true
    });
}));

// Get NFL game scores for a specific week
router.get('/:week/:season', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { week, season } = req.params;
    
    const weekNum = parseInt(week);
    const seasonYear = parseInt(season);
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        throw new APIError('Week must be between 1 and 18', 400);
    }
    
    if (isNaN(seasonYear) || seasonYear < 2020 || seasonYear > 2030) {
        throw new APIError('Invalid season year', 400);
    }
    
    // Get all games for the week from nfl_games table
    const games = await db.all(`
        SELECT game_id, home_team, away_team, home_score, away_score, status, game_date, game_time
        FROM nfl_games
        WHERE week = ? AND season = ?
        ORDER BY game_date, game_id
    `, [weekNum, seasonYear]);
    
    if (!games || games.length === 0) {
        return res.json({
            success: true,
            data: [],
            week: weekNum,
            season: seasonYear
        });
    }
    
    // Process each game to format the response
    const gameScores = [];
    
    for (const game of games) {
        try {
            if (!game.game_id) continue;
            
            // Parse game_id format: YYYYMMDD_AWAY@HOME
            const parts = game.game_id.split('_');
            if (parts.length !== 2) continue;
            
            const datePart = parts[0];
            
            // Generate CBS Sports game URL
            // CBS uses format: https://www.cbssports.com/nfl/gametracker/live/NFL_YYYYMMDD_AWAY@HOME/
            const cbsUrl = `https://www.cbssports.com/nfl/gametracker/live/NFL_${game.game_id}/`;
            
            gameScores.push({
                game_id: game.game_id,
                date: datePart,
                home_team: game.home_team,
                away_team: game.away_team,
                home_score: game.home_score || 0,
                away_score: game.away_score || 0,
                status: game.status || 'Final',
                game_time: game.game_time || null,
                game_url: cbsUrl
            });
        } catch (err) {
            console.error(`Error processing game ${game.game_id}:`, err);
        }
    }
    
    res.json({
        success: true,
        data: gameScores,
        week: weekNum,
        season: seasonYear
    });
}));

module.exports = router;