const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const router = express.Router();

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
    
    // Get all unique games for the week
    const games = await db.all(`
        SELECT DISTINCT game_id
        FROM player_stats
        WHERE week = ? AND season = ?
        ORDER BY game_id
    `, [weekNum, seasonYear]);
    
    if (!games || games.length === 0) {
        return res.json({
            success: true,
            data: [],
            week: weekNum,
            season: seasonYear
        });
    }
    
    // Process each game to get scores
    const gameScores = [];
    
    for (const { game_id } of games) {
        try {
            if (!game_id) continue;
            
            // Parse game_id format: YYYYMMDD_AWAY@HOME
            const parts = game_id.split('_');
            if (parts.length !== 2) continue;
            
            const datePart = parts[0];
            const teams = parts[1].split('@');
            if (teams.length !== 2) continue;
            
            const [awayTeam, homeTeam] = teams;
            
            // Get defense points allowed which contains actual game scores
            const homeDefense = await db.get(`
                SELECT points_allowed FROM player_stats
                WHERE game_id = ? AND team = ? AND position IN ('DEF', 'DST')
                AND week = ? AND season = ?
                LIMIT 1
            `, [game_id, homeTeam, weekNum, seasonYear]);
            
            const awayDefense = await db.get(`
                SELECT points_allowed FROM player_stats
                WHERE game_id = ? AND team = ? AND position IN ('DEF', 'DST')
                AND week = ? AND season = ?
                LIMIT 1
            `, [game_id, awayTeam, weekNum, seasonYear]);
            
            // The defense's points_allowed is what the opponent scored
            const homeScore = awayDefense?.points_allowed || 0;
            const awayScore = homeDefense?.points_allowed || 0;
            
            // Generate ESPN game URL
            // ESPN URL format: https://www.espn.com/nfl/game/_/gameId/YYYYMMDDTEAMTEAM
            const espnGameId = `${datePart}${awayTeam.toLowerCase()}${homeTeam.toLowerCase()}`;
            const espnUrl = `https://www.espn.com/nfl/game/_/gameId/${espnGameId}`;
            
            gameScores.push({
                game_id,
                date: datePart,
                home_team: homeTeam,
                away_team: awayTeam,
                home_score: homeScore,
                away_score: awayScore,
                status: 'Final',
                espn_url: espnUrl
            });
        } catch (err) {
            console.error(`Error processing game ${game_id}:`, err);
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