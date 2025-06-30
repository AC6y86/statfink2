const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const router = express.Router();

// Get league settings
router.get('/settings', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const settings = await db.getLeagueSettings();
    
    if (!settings) {
        throw new APIError('League settings not found', 404);
    }
    
    res.json({
        success: true,
        data: settings
    });
}));

// Get current standings
router.get('/standings', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    
    // Get teams ordered by wins, then by total points
    const teams = await db.all(`
        SELECT 
            team_id,
            team_name,
            owner_name,
            wins,
            losses,
            ties,
            total_points,
            (wins + ties * 0.5) as points,
            CASE 
                WHEN (wins + losses + ties) > 0 
                THEN ROUND((wins + ties * 0.5) / (wins + losses + ties) * 100, 1)
                ELSE 0 
            END as win_percentage
        FROM teams 
        ORDER BY points DESC, total_points DESC
    `);
    
    // Add rank to each team
    const standings = teams.map((team, index) => ({
        ...team,
        rank: index + 1,
        games_played: team.wins + team.losses + team.ties
    }));
    
    res.json({
        success: true,
        data: standings,
        count: standings.length
    });
}));

// Get scoring rules
router.get('/scoring', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const rules = await db.getScoringRules();
    
    // Group rules by category for better organization
    const groupedRules = {
        passing: rules.filter(r => r.stat_type.startsWith('passing')),
        rushing: rules.filter(r => r.stat_type.startsWith('rushing')),
        receiving: rules.filter(r => r.stat_type.startsWith('receiving') || r.stat_type === 'receptions'),
        defense: rules.filter(r => r.stat_type.startsWith('def_') || r.stat_type === 'sacks' || r.stat_type === 'safeties'),
        kicking: rules.filter(r => r.stat_type.includes('field_goal') || r.stat_type.includes('extra_point')),
        misc: rules.filter(r => !['passing', 'rushing', 'receiving', 'def_', 'field_goal', 'extra_point', 'sacks', 'safeties', 'receptions'].some(prefix => r.stat_type.startsWith(prefix) || r.stat_type.includes(prefix)))
    };
    
    res.json({
        success: true,
        data: {
            rules,
            groupedRules,
            scoringType: 'PFL'
        }
    });
}));

// Get league summary/overview
router.get('/overview', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    
    const [settings, teams, totalPlayers] = await Promise.all([
        db.getLeagueSettings(),
        db.getAllTeams(),
        db.get('SELECT COUNT(*) as count FROM nfl_players')
    ]);
    
    // Calculate some basic stats
    const totalGames = teams.reduce((sum, team) => sum + team.wins + team.losses + team.ties, 0);
    const avgPointsPerTeam = teams.length > 0 
        ? teams.reduce((sum, team) => sum + team.total_points, 0) / teams.length 
        : 0;
    
    // Get highest and lowest scoring teams
    const sortedByPoints = [...teams].sort((a, b) => b.total_points - a.total_points);
    const highestScoring = sortedByPoints[0];
    const lowestScoring = sortedByPoints[sortedByPoints.length - 1];
    
    res.json({
        success: true,
        data: {
            league: settings,
            stats: {
                totalTeams: teams.length,
                totalPlayers: totalPlayers.count,
                totalGames: Math.floor(totalGames / 2), // Each game involves 2 teams
                averagePoints: Math.round(avgPointsPerTeam * 100) / 100,
                highestScoringTeam: highestScoring ? {
                    name: highestScoring.team_name,
                    owner: highestScoring.owner_name,
                    points: highestScoring.total_points
                } : null,
                lowestScoringTeam: lowestScoring ? {
                    name: lowestScoring.team_name,
                    owner: lowestScoring.owner_name,
                    points: lowestScoring.total_points
                } : null
            }
        }
    });
}));

// Update current week (admin function)
router.put('/week', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { week, adminPassword } = req.body;
    
    // Simple admin authentication (allow bypass for development)
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && adminPassword !== process.env.ADMIN_PASSWORD) {
        throw new APIError('Unauthorized', 401);
    }
    
    if (!week || week < 1 || week > 18) {
        throw new APIError('Week must be between 1 and 18', 400);
    }
    
    await db.updateCurrentWeek(week);
    const updatedSettings = await db.getLeagueSettings();
    
    res.json({
        success: true,
        data: updatedSettings,
        message: `Current week updated to ${week}`
    });
}));

// Update league settings (admin function for debugging)
router.put('/settings', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { current_week, season_year, league_name, adminPassword } = req.body;
    
    // Simple admin authentication (allow bypass for development)
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && adminPassword !== process.env.ADMIN_PASSWORD) {
        throw new APIError('Unauthorized', 401);
    }
    
    // Validate inputs
    if (current_week !== undefined && (current_week < 1 || current_week > 18)) {
        throw new APIError('Week must be between 1 and 18', 400);
    }
    
    if (season_year !== undefined && (season_year < 2020 || season_year > 2030)) {
        throw new APIError('Season year must be between 2020 and 2030', 400);
    }
    
    // Update settings
    const settingsToUpdate = {};
    if (current_week !== undefined) settingsToUpdate.current_week = current_week;
    if (season_year !== undefined) settingsToUpdate.season_year = season_year;
    if (league_name !== undefined) settingsToUpdate.league_name = league_name;
    
    if (Object.keys(settingsToUpdate).length === 0) {
        throw new APIError('No valid settings provided to update', 400);
    }
    
    await db.updateLeagueSettings(settingsToUpdate);
    const updatedSettings = await db.getLeagueSettings();
    
    const changes = Object.keys(settingsToUpdate).map(key => 
        `${key.replace('_', ' ')} updated to ${settingsToUpdate[key]}`
    ).join(', ');
    
    res.json({
        success: true,
        data: updatedSettings,
        message: `League settings updated: ${changes}`
    });
}));

// Get sync status
router.get('/sync-status', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    
    try {
        // Get the latest data information from player_stats
        const syncStatus = await db.get(`
            SELECT 
                MAX(week) as latest_week,
                COUNT(DISTINCT week) as weeks_synced,
                COUNT(DISTINCT player_id) as players_synced,
                MAX(season) as latest_season
            FROM player_stats
            WHERE season = 2024
        `);
        
        // For now, use current time as last sync time since we don't track it
        const lastSyncTime = new Date().toISOString();
        
        res.json({
            success: true,
            data: {
                last_sync_time: lastSyncTime,
                latest_week: syncStatus?.latest_week || 0,
                weeks_synced: syncStatus?.weeks_synced || 0,
                players_synced: syncStatus?.players_synced || 0,
                latest_season: syncStatus?.latest_season || 2024
            }
        });
    } catch (error) {
        console.error('Error in sync-status:', error);
        res.json({
            success: true,
            data: {
                last_sync_time: null,
                latest_week: 0,
                weeks_synced: 0,
                players_synced: 0,
                latest_season: 2024
            }
        });
    }
}));


module.exports = router;