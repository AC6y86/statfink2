const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const router = express.Router();

// Get all roster moves for the current season
router.get('/', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const season = req.query.season || 2025;

    // Get all teams with owner info
    const teams = await db.all(`
        SELECT team_id, team_name, owner_name
        FROM teams
        ORDER BY team_id
    `);

    const rosterMoves = {};

    for (const team of teams) {
        // Get all moves from the roster_moves table
        const moves = await db.all(`
            SELECT
                move_id,
                move_type,
                dropped_player_id,
                dropped_player_name,
                dropped_player_position,
                added_player_id,
                added_player_name,
                added_player_position,
                week,
                move_timestamp
            FROM roster_moves
            WHERE team_id = ? AND season = ?
            ORDER BY move_timestamp DESC
        `, [team.team_id, season]);

        // Separate moves by type
        const irMoves = moves.filter(m => m.move_type === 'ir');
        const supplementalMoves = moves.filter(m => m.move_type === 'supplemental');

        rosterMoves[team.team_id] = {
            team_id: team.team_id,
            team_name: team.team_name,
            owner_name: team.owner_name,
            ir_moves: irMoves,
            ir_move_count: irMoves.length,
            supplemental_moves: supplementalMoves,
            supplemental_move_count: supplementalMoves.length,
            all_moves: moves
        };
    }

    res.json({
        success: true,
        season: season,
        data: rosterMoves
    });
}));

// Get roster moves for a specific team
router.get('/team/:teamId', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId } = req.params;
    const season = req.query.season || 2025;

    if (!teamId || isNaN(teamId)) {
        throw new APIError('Invalid team ID', 400);
    }

    const team = await db.get(`
        SELECT team_id, team_name, owner_name
        FROM teams
        WHERE team_id = ?
    `, [parseInt(teamId)]);

    if (!team) {
        throw new APIError('Team not found', 404);
    }

    // Get all moves from the roster_moves table
    const moves = await db.all(`
        SELECT
            move_id,
            move_type,
            dropped_player_id,
            dropped_player_name,
            dropped_player_position,
            added_player_id,
            added_player_name,
            added_player_position,
            week,
            move_timestamp
        FROM roster_moves
        WHERE team_id = ? AND season = ?
        ORDER BY move_timestamp DESC
    `, [parseInt(teamId), season]);

    // Separate moves by type
    const irMoves = moves.filter(m => m.move_type === 'ir');
    const supplementalMoves = moves.filter(m => m.move_type === 'supplemental');

    res.json({
        success: true,
        season: season,
        data: {
            team_id: team.team_id,
            team_name: team.team_name,
            owner_name: team.owner_name,
            ir_moves: irMoves,
            ir_move_count: irMoves.length,
            supplemental_moves: supplementalMoves,
            supplemental_move_count: supplementalMoves.length,
            all_moves: moves
        }
    });
}));

module.exports = router;