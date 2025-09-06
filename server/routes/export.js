const express = require('express');
const { asyncHandler, APIError, logError, logInfo } = require('../utils/errorHandler');
const GoogleSheetsExportService = require('../services/googleSheetsExportService');
const StandingsExportService = require('../services/standingsExportService');

const router = express.Router();

/**
 * Export standings to Google Sheets
 * POST body: { sheetId: "spreadsheet_id_or_url", week: 8, season: 2025 }
 */
router.post('/standings/sheet', asyncHandler(async (req, res) => {
    const { sheetId, week, season } = req.body;
    
    // Validate inputs
    if (!sheetId) {
        throw new APIError('Google Sheet ID or URL is required', 400);
    }
    
    const weekNum = parseInt(week);
    const seasonNum = parseInt(season);
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        throw new APIError('Invalid week. Must be between 1 and 18.', 400);
    }
    
    if (isNaN(seasonNum) || seasonNum < 2020 || seasonNum > 2030) {
        throw new APIError('Invalid season. Must be between 2020 and 2030.', 400);
    }
    
    const db = req.app.locals.db;
    
    try {
        // Initialize services
        const googleSheets = new GoogleSheetsExportService();
        await googleSheets.initialize();
        
        const exportService = new StandingsExportService(db);
        
        // Extract spreadsheet ID from URL if needed
        const spreadsheetId = googleSheets.extractSpreadsheetId(sheetId);
        
        // Collect data using new horizontal grid format
        logInfo(`Collecting data for Week ${weekNum}, Season ${seasonNum}`);
        const gridData = await exportService.getHorizontalGridData(weekNum, seasonNum);
        
        // Write to Google Sheets using new format
        logInfo(`Writing to Google Sheets: ${spreadsheetId}`);
        await googleSheets.writeWeeklyData(spreadsheetId, weekNum, seasonNum, null, gridData);
        
        res.json({
            success: true,
            message: `Successfully exported Week ${weekNum} standings to Google Sheets`,
            spreadsheetId,
            week: weekNum,
            season: seasonNum
        });
    } catch (error) {
        logError('Error exporting to Google Sheets:', error);
        throw new APIError(`Failed to export standings: ${error.message}`, 500);
    }
}));

/**
 * Export all completed weeks to Google Sheets
 * POST body: { sheetId: "spreadsheet_id_or_url", season: 2025 }
 */
router.post('/standings/sheet/all', asyncHandler(async (req, res) => {
    const { sheetId, season } = req.body;
    
    // Validate inputs
    if (!sheetId) {
        throw new APIError('Google Sheet ID or URL is required', 400);
    }
    
    const seasonNum = parseInt(season);
    
    if (isNaN(seasonNum) || seasonNum < 2020 || seasonNum > 2030) {
        throw new APIError('Invalid season. Must be between 2020 and 2030.', 400);
    }
    
    const db = req.app.locals.db;
    
    try {
        // Initialize services
        const googleSheets = new GoogleSheetsExportService();
        await googleSheets.initialize();
        
        const exportService = new StandingsExportService(db);
        
        // Extract spreadsheet ID from URL if needed
        const spreadsheetId = googleSheets.extractSpreadsheetId(sheetId);
        
        // Get all completed weeks
        const weeks = await exportService.getCompletedWeeks(seasonNum);
        
        if (weeks.length === 0) {
            throw new APIError(`No completed weeks found for season ${seasonNum}`, 404);
        }
        
        logInfo(`Exporting ${weeks.length} weeks for season ${seasonNum}`);
        
        // Export each week
        const results = [];
        for (const week of weeks) {
            logInfo(`Exporting Week ${week}...`);
            const gridData = await exportService.getHorizontalGridData(week, seasonNum);
            await googleSheets.writeWeeklyData(spreadsheetId, week, seasonNum, null, gridData);
            results.push(week);
        }
        
        res.json({
            success: true,
            message: `Successfully exported ${weeks.length} weeks to Google Sheets`,
            spreadsheetId,
            season: seasonNum,
            weeks: results
        });
    } catch (error) {
        logError('Error exporting all weeks to Google Sheets:', error);
        throw new APIError(`Failed to export standings: ${error.message}`, 500);
    }
}));

/**
 * Get export status/info
 */
router.get('/status', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    
    try {
        // Check if Google Sheets auth is available
        const googleSheets = new GoogleSheetsExportService();
        let authAvailable = false;
        let authMessage = '';
        
        try {
            await googleSheets.initialize();
            authAvailable = true;
            authMessage = 'Google Sheets authentication is configured';
        } catch (error) {
            authMessage = 'Google Sheets authentication not configured: ' + error.message;
        }
        
        // Get available weeks
        const exportService = new StandingsExportService(db);
        const settings = await db.getLeagueSettings();
        const weeks = await exportService.getCompletedWeeks(settings.season_year);
        
        res.json({
            success: true,
            authAvailable,
            authMessage,
            currentSeason: settings.season_year,
            currentWeek: settings.current_week,
            completedWeeks: weeks
        });
    } catch (error) {
        logError('Error getting export status:', error);
        throw new APIError('Failed to get export status', 500);
    }
}));

module.exports = router;