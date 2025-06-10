const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const router = express.Router();

// Get all teams with standings
router.get('/', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const teams = await db.getAllTeams();
    
    res.json({
        success: true,
        data: teams,
        count: teams.length
    });
}));

// Get specific team with roster
router.get('/:teamId', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId } = req.params;
    
    // Validate team ID
    if (!teamId || isNaN(teamId)) {
        throw new APIError('Invalid team ID', 400);
    }
    
    const team = await db.getTeam(parseInt(teamId));
    
    if (!team) {
        throw new APIError('Team not found', 404);
    }
    
    const roster = await db.getTeamRoster(parseInt(teamId));
    
    res.json({
        success: true,
        data: {
            team,
            roster,
            rosterSize: roster.length
        }
    });
}));

// Get team roster only
router.get('/:teamId/roster', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId } = req.params;
    
    if (!teamId || isNaN(teamId)) {
        throw new APIError('Invalid team ID', 400);
    }
    
    const roster = await db.getTeamRoster(parseInt(teamId));
    
    // Group players by position for easier frontend consumption
    const groupedRoster = roster.reduce((acc, player) => {
        const position = player.position;
        if (!acc[position]) {
            acc[position] = [];
        }
        acc[position].push(player);
        return acc;
    }, {});
    
    res.json({
        success: true,
        data: {
            roster,
            groupedByPosition: groupedRoster,
            starters: roster.filter(p => p.roster_position === 'starter'),
            bench: roster.filter(p => p.roster_position === 'bench')
        }
    });
}));

// Update team stats (internal use, could be restricted to admin)
router.put('/:teamId/stats', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId } = req.params;
    const { wins, losses, ties, totalPoints } = req.body;
    
    if (!teamId || isNaN(teamId)) {
        throw new APIError('Invalid team ID', 400);
    }
    
    // Validate input
    if (wins < 0 || losses < 0 || ties < 0 || totalPoints < 0) {
        throw new APIError('Stats values must be non-negative', 400);
    }
    
    await db.updateTeamStats(parseInt(teamId), wins, losses, ties, totalPoints);
    
    const updatedTeam = await db.getTeam(parseInt(teamId));
    
    res.json({
        success: true,
        data: updatedTeam,
        message: 'Team stats updated successfully'
    });
}));

module.exports = router;