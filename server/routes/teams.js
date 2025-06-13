const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const router = express.Router();

// PFL Roster Constraints (from PFL_RULES.md)
const ROSTER_CONSTRAINTS = {
    QB: { min: 2, max: null }, // Minimum 2 QBs
    RB: { min: 5, max: null }, // Minimum 5 RBs  
    WR: { min: 6, max: null }, // 6 WRs and/or TEs combined
    TE: { min: 6, max: null }, // 6 WRs and/or TEs combined (shared with WR)
    K: { min: 2, max: null },  // Minimum 2 Kickers
    DST: { min: 2, max: null } // Minimum 2 Defenses
};

// Validate roster constraints for PFL rules
async function validateRosterConstraints(db, teamId, position, action) {
    // Get current roster by position
    const roster = await db.all(`
        SELECT p.position, COUNT(*) as count
        FROM fantasy_rosters r
        JOIN nfl_players p ON r.player_id = p.player_id
        WHERE r.team_id = ? AND r.roster_position = 'active'
        GROUP BY p.position
    `, [teamId]);
    
    const currentCounts = {};
    roster.forEach(row => {
        currentCounts[row.position] = parseInt(row.count);
    });
    
    // Handle WR/TE combined constraint (6 total minimum)
    const wrTeCount = (currentCounts.WR || 0) + (currentCounts.TE || 0);
    
    if (action === 'add') {
        // Check if adding this position would exceed any constraints
        // For now, we only enforce minimums, not maximums
        // Future: could add maximum roster size constraints here
        return true;
        
    } else if (action === 'remove') {
        // Check if removing would violate minimum constraints
        const newCount = (currentCounts[position] || 0) - 1;
        const constraint = ROSTER_CONSTRAINTS[position];
        
        if (constraint && newCount < constraint.min) {
            // Special handling for WR/TE combined constraint
            if ((position === 'WR' || position === 'TE') && wrTeCount - 1 >= 6) {
                return true; // OK to remove if combined WR/TE still >= 6
            }
            throw new APIError(`Cannot remove ${position}. Team must maintain at least ${constraint.min} ${position}s on roster.`, 400);
        }
    }
    
    return true;
}

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
            active: roster.filter(p => p.roster_position === 'active'),
            injured_reserve: roster.filter(p => p.roster_position === 'injured_reserve')
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

// Add player to roster
router.post('/:teamId/roster/add', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId } = req.params;
    const { playerId, rosterPosition = 'active' } = req.body;
    
    if (!teamId || isNaN(teamId)) {
        throw new APIError('Invalid team ID', 400);
    }
    
    if (!playerId) {
        throw new APIError('Player ID is required', 400);
    }
    
    if (!['active', 'injured_reserve'].includes(rosterPosition)) {
        throw new APIError('Invalid roster position. Must be: active or injured_reserve', 400);
    }
    
    // Validate team exists
    const team = await db.getTeam(parseInt(teamId));
    if (!team) {
        throw new APIError('Team not found', 404);
    }
    
    // Validate player exists and is available
    const player = await db.get('SELECT * FROM nfl_players WHERE player_id = ?', [playerId]);
    if (!player) {
        throw new APIError('Player not found', 404);
    }
    
    // Check if player is already on a roster
    const existingRoster = await db.get(
        'SELECT team_id FROM fantasy_rosters WHERE player_id = ?', 
        [playerId]
    );
    
    if (existingRoster) {
        throw new APIError('Player is already on a roster', 400);
    }

    // Validate roster constraints for active players (not IR)
    if (rosterPosition === 'active') {
        await validateRosterConstraints(db, parseInt(teamId), player.position, 'add');
    }
    
    await db.addPlayerToRoster(parseInt(teamId), playerId, rosterPosition);
    
    res.json({
        success: true,
        message: `${player.name} added to ${team.team_name}`,
        data: {
            team: team.team_name,
            player: {
                id: player.player_id,
                name: player.name,
                position: player.position,
                team: player.team
            },
            rosterPosition
        }
    });
}));

// Remove player from roster
router.delete('/:teamId/roster/remove', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId } = req.params;
    const { playerId } = req.body;
    
    if (!teamId || isNaN(teamId)) {
        throw new APIError('Invalid team ID', 400);
    }
    
    if (!playerId) {
        throw new APIError('Player ID is required', 400);
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
    
    // Check if player is actually on this team's roster
    const rosterEntry = await db.get(
        'SELECT * FROM fantasy_rosters WHERE team_id = ? AND player_id = ?',
        [parseInt(teamId), playerId]
    );
    
    if (!rosterEntry) {
        throw new APIError('Player is not on this team\'s roster', 400);
    }
    
    // Validate roster constraints for active players (not IR)
    if (rosterEntry.roster_position === 'active') {
        await validateRosterConstraints(db, parseInt(teamId), player.position, 'remove');
    }
    
    await db.removePlayerFromRoster(parseInt(teamId), playerId);
    
    res.json({
        success: true,
        message: `${player.name} removed from ${team.team_name}`,
        data: {
            team: team.team_name,
            player: {
                id: player.player_id,
                name: player.name,
                position: player.position,
                team: player.team
            }
        }
    });
}));

// Move player between roster positions (starter/injured_reserve)
router.put('/:teamId/roster/move', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId } = req.params;
    const { playerId, rosterPosition } = req.body;
    
    if (!teamId || isNaN(teamId)) {
        throw new APIError('Invalid team ID', 400);
    }
    
    if (!playerId || !rosterPosition) {
        throw new APIError('Player ID and roster position are required', 400);
    }
    
    if (!['active', 'injured_reserve'].includes(rosterPosition)) {
        throw new APIError('Invalid roster position. Must be: active or injured_reserve', 400);
    }
    
    // Validate team and player exist
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
    
    // Check if player is on this team's roster
    const rosterEntry = await db.get(
        'SELECT * FROM fantasy_rosters WHERE team_id = ? AND player_id = ?',
        [parseInt(teamId), playerId]
    );
    
    if (!rosterEntry) {
        throw new APIError('Player is not on this team\'s roster', 400);
    }

    // No limit on injured reserve players
    
    // Update roster position
    await db.run(
        'UPDATE fantasy_rosters SET roster_position = ? WHERE team_id = ? AND player_id = ?',
        [rosterPosition, parseInt(teamId), playerId]
    );
    
    res.json({
        success: true,
        message: `${player.name} moved to ${rosterPosition}`,
        data: {
            team: team.team_name,
            player: {
                id: player.player_id,
                name: player.name,
                position: player.position,
                team: player.team
            },
            oldPosition: rosterEntry.roster_position,
            newPosition: rosterPosition
        }
    });
}));

module.exports = router;