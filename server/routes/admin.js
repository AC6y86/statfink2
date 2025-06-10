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
    
    // Count total rostered players
    const rosteredPlayers = await db.get('SELECT COUNT(*) as count FROM fantasy_rosters');
    
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

// Sync player stats for a specific week
router.post('/sync/stats', requireAdmin, asyncHandler(async (req, res) => {
    const playerSyncService = req.app.locals.playerSyncService;
    const { week, season } = req.body;
    
    if (!playerSyncService) {
        throw new APIError('Player sync service not available', 500);
    }
    
    if (!week || !season) {
        throw new APIError('Week and season are required', 400);
    }
    
    const result = await playerSyncService.syncPlayerStats(parseInt(week), parseInt(season));
    
    if (result.success) {
        res.json({
            success: true,
            message: `Stats sync completed for week ${week}, season ${season}`,
            data: result
        });
    } else {
        res.status(500).json({
            success: false,
            message: 'Stats sync failed',
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

module.exports = router;