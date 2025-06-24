const express = require('express');
const { asyncHandler, APIError, logError } = require('../utils/errorHandler');
const StandingsService = require('../services/standingsService');

const router = express.Router();

// Get standings for a specific week
router.get('/:season/:week', asyncHandler(async (req, res) => {
    const { season, week } = req.params;
    const seasonNum = parseInt(season);
    const weekNum = parseInt(week);
    
    // Validate parameters
    if (isNaN(seasonNum) || seasonNum < 2020 || seasonNum > 2030) {
        throw new APIError('Invalid season. Must be between 2020 and 2030.', 400);
    }
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        throw new APIError('Invalid week. Must be between 1 and 18.', 400);
    }
    
    const db = req.app.locals.db;
    const standingsService = new StandingsService(db);
    
    try {
        const standings = await standingsService.getStandingsForWeek(weekNum, seasonNum);
        res.json(standings);
    } catch (error) {
        logError('Error getting standings:', error);
        throw new APIError('Failed to get standings data', 500);
    }
}));

// Get current standings (redirects to current week)
router.get('/current', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    
    try {
        const settings = await db.getLeagueSettings();
        const standingsService = new StandingsService(db);
        const standings = await standingsService.getStandingsForWeek(settings.current_week, settings.season_year);
        res.json(standings);
    } catch (error) {
        logError('Error getting current standings:', error);
        throw new APIError('Failed to get current standings', 500);
    }
}));

// Get weekly winners for a season
router.get('/weekly-winners/:season', asyncHandler(async (req, res) => {
    const { season } = req.params;
    const seasonNum = parseInt(season);
    
    // Validate parameters
    if (isNaN(seasonNum) || seasonNum < 2020 || seasonNum > 2030) {
        throw new APIError('Invalid season. Must be between 2020 and 2030.', 400);
    }
    
    const db = req.app.locals.db;
    const standingsService = new StandingsService(db);
    
    try {
        const weeklyWinners = await standingsService.getWeeklyWinners(seasonNum);
        res.json(weeklyWinners);
    } catch (error) {
        logError('Error getting weekly winners:', error);
        throw new APIError('Failed to get weekly winners data', 500);
    }
}));

module.exports = router;