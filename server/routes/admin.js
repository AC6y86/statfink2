const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const router = express.Router();

// No admin authentication required - network-only access
const requireAdmin = (req, res, next) => {
    // Skip authentication for network-only deployment
    next();
};

// Add player to team roster
router.post('/roster/add', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId, playerId, rosterPosition = 'starter' } = req.body;
    
    if (!teamId || !playerId) {
        throw new APIError('Team ID and Player ID are required', 400);
    }
    
    if (!['starter', 'injured_reserve'].includes(rosterPosition)) {
        throw new APIError('Invalid roster position. Must be: starter or injured_reserve', 400);
    }
    
    // Validate team exists
    const team = await db.getTeam(parseInt(teamId));
    if (!team) {
        throw new APIError('Team not found', 404);
    }
    
    // Validate player exists
    const player = await db.get('SELECT * FROM nfl_players WHERE player_id = ?', [playerId]);
    if (!player) {
        throw new APIError('Player not found', 404);
    }
    
    await db.addPlayerToRoster(parseInt(teamId), playerId, rosterPosition);
    
    res.json({
        success: true,
        message: `${player.name} added to ${team.team_name}`,
        data: {
            team: team.team_name,
            player: player.name,
            position: rosterPosition
        }
    });
}));

// Remove player from roster
router.post('/roster/remove', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId, playerId } = req.body;
    
    if (!teamId || !playerId) {
        throw new APIError('Team ID and Player ID are required', 400);
    }
    
    // Get player and team info for response
    const [team, player] = await Promise.all([
        db.getTeam(parseInt(teamId)),
        db.get('SELECT * FROM nfl_players WHERE player_id = ?', [playerId])
    ]);
    
    if (!team) {
        throw new APIError('Team not found', 404);
    }
    
    if (!player) {
        throw new APIError('Player not found', 404);
    }
    
    await db.removePlayerFromRoster(parseInt(teamId), playerId);
    
    res.json({
        success: true,
        message: `${player.name} removed from ${team.team_name}`,
        data: {
            team: team.team_name,
            player: player.name
        }
    });
}));

// Update roster position (starter/bench)
router.post('/roster/position', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId, playerId, rosterPosition } = req.body;
    
    if (!teamId || !playerId || !rosterPosition) {
        throw new APIError('Team ID, Player ID, and roster position are required', 400);
    }
    
    if (!['starter', 'injured_reserve'].includes(rosterPosition)) {
        throw new APIError('Invalid roster position. Must be: starter or injured_reserve', 400);
    }
    
    // Get player and team info for response
    const [team, player] = await Promise.all([
        db.getTeam(parseInt(teamId)),
        db.get('SELECT * FROM nfl_players WHERE player_id = ?', [playerId])
    ]);
    
    if (!team) {
        throw new APIError('Team not found', 404);
    }
    
    if (!player) {
        throw new APIError('Player not found', 404);
    }
    
    await db.updateRosterPosition(parseInt(teamId), playerId, rosterPosition);
    
    res.json({
        success: true,
        message: `${player.name} moved to ${rosterPosition}`,
        data: {
            team: team.team_name,
            player: player.name,
            position: rosterPosition
        }
    });
}));

// Validate lineup for a team
router.post('/lineup/validate', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const scoringService = req.app.locals.scoringService;
    const { teamId } = req.body;
    
    if (!teamId) {
        throw new APIError('Team ID is required', 400);
    }
    
    const roster = await db.getTeamRoster(parseInt(teamId));
    
    try {
        const isValid = scoringService.validateLineup(roster);
        
        res.json({
            success: true,
            isValid: true,
            message: 'Lineup is valid',
            data: {
                starters: roster.filter(p => p.roster_position === 'starter').length,
                bench: roster.filter(p => p.roster_position === 'bench').length
            }
        });
    } catch (error) {
        res.json({
            success: true,
            isValid: false,
            message: error.message,
            data: {
                starters: roster.filter(p => p.roster_position === 'starter').length,
                bench: roster.filter(p => p.roster_position === 'bench').length
            }
        });
    }
}));

// Get admin dashboard summary
router.get('/dashboard', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    
    const [teams, totalPlayers, settings] = await Promise.all([
        db.getAllTeams(),
        db.get('SELECT COUNT(*) as count FROM nfl_players'),
        db.getLeagueSettings()
    ]);
    
    // Count total rostered players from current week
    const currentSeason = 2024; // TODO: Make this dynamic
    const latestWeek = await db.get(`
        SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
    `, [currentSeason]);
    
    const rosteredPlayers = await db.get(`
        SELECT COUNT(*) as count FROM weekly_rosters 
        WHERE week = ? AND season = ?
    `, [latestWeek.week, currentSeason]);
    
    // Get teams with roster issues
    const teamsWithIssues = [];
    for (const team of teams) {
        const roster = await db.getTeamRoster(team.team_id);
        const starters = roster.filter(p => p.roster_position === 'starter');
        
        if (starters.length !== 9) {
            teamsWithIssues.push({
                ...team,
                starterCount: starters.length,
                issue: starters.length < 9 ? 'Too few starters' : 'Too many starters'
            });
        }
    }
    
    // Get sync status if available
    const playerSyncService = req.app.locals.playerSyncService;
    let syncStatus = null;
    if (playerSyncService) {
        syncStatus = playerSyncService.getSyncStatus();
    }
    
    res.json({
        success: true,
        data: {
            league: settings,
            summary: {
                totalTeams: teams.length,
                totalPlayers: totalPlayers.count,
                rosteredPlayers: rosteredPlayers.count,
                availablePlayers: totalPlayers.count - rosteredPlayers.count,
                teamsWithIssues: teamsWithIssues.length
            },
            issues: teamsWithIssues,
            sync: syncStatus
        }
    });
}));

// Sync players from Tank01 API
router.post('/sync/players', requireAdmin, asyncHandler(async (req, res) => {
    const playerSyncService = req.app.locals.playerSyncService;
    
    if (!playerSyncService) {
        throw new APIError('Player sync service not available', 500);
    }
    
    const result = await playerSyncService.syncPlayers();
    
    if (result.success) {
        res.json({
            success: true,
            message: 'Player sync completed successfully',
            data: result
        });
    } else {
        res.status(500).json({
            success: false,
            message: 'Player sync failed',
            error: result.error || result.message
        });
    }
}));


// Get sync status
router.get('/sync/status', requireAdmin, asyncHandler(async (req, res) => {
    const playerSyncService = req.app.locals.playerSyncService;
    const tank01Service = req.app.locals.tank01Service;
    
    if (!playerSyncService) {
        throw new APIError('Player sync service not available', 500);
    }
    
    const syncStatus = playerSyncService.getSyncStatus();
    
    // Get Tank01 health if available
    let tank01Health = null;
    if (tank01Service) {
        tank01Health = await tank01Service.healthCheck();
    }
    
    res.json({
        success: true,
        data: {
            sync: syncStatus,
            tank01: tank01Health
        }
    });
}));

// Force sync (for testing)
router.post('/sync/force', requireAdmin, asyncHandler(async (req, res) => {
    const playerSyncService = req.app.locals.playerSyncService;
    
    if (!playerSyncService) {
        throw new APIError('Player sync service not available', 500);
    }
    
    const result = await playerSyncService.forceSyncPlayers();
    
    res.json({
        success: true,
        message: 'Force sync initiated',
        data: result
    });
}));

// Debug endpoint to inspect Tank01 API data
router.get('/debug/tank01/:week/:season', requireAdmin, asyncHandler(async (req, res) => {
    const tank01Service = req.app.locals.tank01Service;
    const { week, season } = req.params;
    
    if (!tank01Service) {
        throw new APIError('Tank01 service not available', 500);
    }
    
    try {
        const rawData = await tank01Service.getPlayerStats(parseInt(week), parseInt(season));
        res.json({
            success: true,
            dataType: typeof rawData,
            dataKeys: rawData ? Object.keys(rawData) : null,
            sampleData: rawData,
            hasPlayerStats: rawData && rawData.playerStats ? 'Yes' : 'No'
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
}));


// Recalculate all fantasy points using current scoring system
router.post('/recalculate/fantasy-points', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const scoringService = req.app.locals.scoringService;
    const { recalculateAllFantasyPoints } = require('../utils/recalculateFantasyPoints');
    
    if (!scoringService) {
        throw new APIError('Scoring service not available', 500);
    }
    
    try {
        const result = await recalculateAllFantasyPoints(db, scoringService);
        
        res.json({
            success: true,
            message: 'Fantasy points recalculation completed',
            data: result
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Fantasy points recalculation failed',
            error: error.message
        });
    }
}));

// Cache management endpoints
router.get('/cache/stats', requireAdmin, asyncHandler(async (req, res) => {
    const tank01Service = req.app.locals.tank01Service;
    const db = req.app.locals.db;
    
    if (!tank01Service) {
        throw new APIError('Tank01 service not available', 500);
    }
    
    const cacheStats = await tank01Service.getCacheStats();
    const storageStats = await db.getCacheStorageSize();
    const mostAccessed = await db.getMostAccessedCacheEntries(10);
    
    res.json({
        success: true,
        data: {
            cacheStats,
            storageStats,
            mostAccessed
        }
    });
}));

router.post('/cache/cleanup', requireAdmin, asyncHandler(async (req, res) => {
    const tank01Service = req.app.locals.tank01Service;
    const db = req.app.locals.db;
    const { onlyExpired = true } = req.body;
    
    if (!tank01Service) {
        throw new APIError('Tank01 service not available', 500);
    }
    
    // Clean up using tank01Service method
    await tank01Service.clearCache(onlyExpired);
    
    // Also run database cleanup
    const deletedCount = await db.cleanupExpiredCache();
    
    res.json({
        success: true,
        message: onlyExpired ? 'Expired cache entries cleaned up' : 'Non-historical cache cleared',
        data: {
            deletedEntries: deletedCount
        }
    });
}));

router.get('/cache/entries/:endpoint', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { endpoint } = req.params;
    
    const entries = await db.getCacheEntriesByEndpoint(`/${endpoint}`);
    
    res.json({
        success: true,
        data: {
            endpoint: `/${endpoint}`,
            entries
        }
    });
}));

module.exports = router;