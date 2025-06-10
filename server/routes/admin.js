const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const router = express.Router();

// Simple admin authentication middleware
const requireAdmin = (req, res, next) => {
    const { adminPassword } = req.body;
    const authHeader = req.headers.authorization;
    
    let password = adminPassword;
    
    // Check for Bearer token in Authorization header
    if (authHeader && authHeader.startsWith('Bearer ')) {
        password = authHeader.substring(7);
    }
    
    if (password !== process.env.ADMIN_PASSWORD) {
        throw new APIError('Unauthorized - Invalid admin password', 401);
    }
    
    next();
};

// Admin authentication check
router.post('/auth', (req, res) => {
    const { password } = req.body;
    
    if (password === process.env.ADMIN_PASSWORD) {
        res.json({
            success: true,
            message: 'Admin authenticated successfully',
            token: process.env.ADMIN_PASSWORD // Simple token approach
        });
    } else {
        throw new APIError('Invalid password', 401);
    }
});

// Add player to team roster
router.post('/roster/add', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId, playerId, rosterPosition = 'bench' } = req.body;
    
    if (!teamId || !playerId) {
        throw new APIError('Team ID and Player ID are required', 400);
    }
    
    if (!['starter', 'bench', 'ir'].includes(rosterPosition)) {
        throw new APIError('Invalid roster position. Must be: starter, bench, or ir', 400);
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
    
    if (!['starter', 'bench', 'ir'].includes(rosterPosition)) {
        throw new APIError('Invalid roster position. Must be: starter, bench, or ir', 400);
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
        db.get('SELECT COUNT(*) as count FROM nfl_players WHERE is_active = 1'),
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
            issues: teamsWithIssues
        }
    });
}));

module.exports = router;