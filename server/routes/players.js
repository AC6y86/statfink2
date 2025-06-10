const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const router = express.Router();

// Get all active players
router.get('/', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { position, team, available } = req.query;
    
    let players;
    
    if (position) {
        // Validate position
        const validPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
        if (!validPositions.includes(position.toUpperCase())) {
            throw new APIError(`Invalid position. Must be one of: ${validPositions.join(', ')}`, 400);
        }
        players = await db.getPlayersByPosition(position.toUpperCase());
    } else {
        players = await db.getAllPlayers();
    }
    
    // Filter by team if specified
    if (team) {
        players = players.filter(p => p.team.toLowerCase() === team.toLowerCase());
    }
    
    // Filter available players (not on any roster) if requested
    if (available === 'true') {
        // Get all rostered players
        const rosteredPlayers = await db.all(`
            SELECT DISTINCT player_id FROM fantasy_rosters
        `);
        const rosteredIds = new Set(rosteredPlayers.map(p => p.player_id));
        
        players = players.filter(p => !rosteredIds.has(p.player_id));
    }
    
    res.json({
        success: true,
        data: players,
        count: players.length,
        filters: {
            position: position || 'all',
            team: team || 'all',
            available: available === 'true'
        }
    });
}));

// Get players by position (convenience endpoint)
router.get('/position/:position', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { position } = req.params;
    
    const validPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
    if (!validPositions.includes(position.toUpperCase())) {
        throw new APIError(`Invalid position. Must be one of: ${validPositions.join(', ')}`, 400);
    }
    
    const players = await db.getPlayersByPosition(position.toUpperCase());
    
    res.json({
        success: true,
        data: players,
        count: players.length,
        position: position.toUpperCase()
    });
}));

// Get all available players (not on any roster)
router.get('/available', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    
    // Get all rostered players
    const rosteredPlayers = await db.all(`
        SELECT DISTINCT player_id FROM fantasy_rosters
    `);
    const rosteredIds = new Set(rosteredPlayers.map(p => p.player_id));
    
    const players = await db.getAllPlayers();
    const availablePlayers = players.filter(p => !rosteredIds.has(p.player_id));
    
    res.json({
        success: true,
        data: availablePlayers,
        count: availablePlayers.length,
        position: 'all'
    });
}));

// Get available players by position (not on any roster)
router.get('/available/:position', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { position } = req.params;
    
    // Get all rostered players
    const rosteredPlayers = await db.all(`
        SELECT DISTINCT player_id FROM fantasy_rosters
    `);
    const rosteredIds = new Set(rosteredPlayers.map(p => p.player_id));
    
    const validPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
    if (!validPositions.includes(position.toUpperCase())) {
        throw new APIError(`Invalid position. Must be one of: ${validPositions.join(', ')}`, 400);
    }
    
    const players = await db.getPlayersByPosition(position.toUpperCase());
    
    // Filter out rostered players
    const availablePlayers = players.filter(p => !rosteredIds.has(p.player_id));
    
    res.json({
        success: true,
        data: availablePlayers,
        count: availablePlayers.length,
        position: position ? position.toUpperCase() : 'all'
    });
}));

// Search players by name
router.get('/search/:query', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { query } = req.params;
    const { position } = req.query;
    
    if (!query || query.length < 2) {
        throw new APIError('Search query must be at least 2 characters', 400);
    }
    
    let searchQuery = `
        SELECT * FROM nfl_players 
        WHERE is_active = 1 
        AND LOWER(name) LIKE LOWER(?)
    `;
    const params = [`%${query}%`];
    
    if (position) {
        const validPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
        if (!validPositions.includes(position.toUpperCase())) {
            throw new APIError(`Invalid position. Must be one of: ${validPositions.join(', ')}`, 400);
        }
        searchQuery += ' AND position = ?';
        params.push(position.toUpperCase());
    }
    
    searchQuery += ' ORDER BY name LIMIT 50';
    
    const players = await db.all(searchQuery, params);
    
    res.json({
        success: true,
        data: players,
        count: players.length,
        query,
        position: position || 'all'
    });
}));

// Get specific player details
router.get('/:playerId', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { playerId } = req.params;
    
    if (!playerId) {
        throw new APIError('Player ID is required', 400);
    }
    
    const player = await db.get('SELECT * FROM nfl_players WHERE player_id = ?', [playerId]);
    
    if (!player) {
        throw new APIError('Player not found', 404);
    }
    
    // Check if player is on a roster
    const rosterInfo = await db.get(`
        SELECT fr.*, t.team_name, t.owner_name 
        FROM fantasy_rosters fr
        JOIN teams t ON fr.team_id = t.team_id
        WHERE fr.player_id = ?
    `, [playerId]);
    
    res.json({
        success: true,
        data: {
            player,
            rosterInfo: rosterInfo || null,
            isRostered: !!rosterInfo
        }
    });
}));

module.exports = router;