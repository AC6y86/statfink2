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
        // Get current season and latest week
        const currentSeason = 2024; // TODO: Make this dynamic
        const latestWeek = await db.get(`
            SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
        `, [currentSeason]);
        
        // Get all rostered players from current week
        const rosteredPlayers = await db.all(`
            SELECT DISTINCT player_id FROM weekly_rosters
            WHERE week = ? AND season = ?
              AND roster_position != 'injured_reserve'
        `, [latestWeek.week, currentSeason]);
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
    
    // Get current season and latest week
    const currentSeason = 2024; // TODO: Make this dynamic
    const latestWeek = await db.get(`
        SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
    `, [currentSeason]);
    
    // Use efficient LEFT JOIN to get available players in one query
    const availablePlayers = await db.all(`
        SELECT p.* 
        FROM nfl_players p
        LEFT JOIN weekly_rosters r ON p.player_id = r.player_id 
            AND r.week = ? AND r.season = ?
            AND r.roster_position != 'injured_reserve'
        WHERE r.player_id IS NULL
        ORDER BY p.position, p.name
    `, [latestWeek.week, currentSeason]);
    
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
    
    const validPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
    if (!validPositions.includes(position.toUpperCase())) {
        throw new APIError(`Invalid position. Must be one of: ${validPositions.join(', ')}`, 400);
    }
    
    // Get current season and latest week
    const currentSeason = 2024; // TODO: Make this dynamic
    const latestWeek = await db.get(`
        SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
    `, [currentSeason]);
    
    // Use efficient LEFT JOIN to get available players by position in one query
    const availablePlayers = await db.all(`
        SELECT p.* 
        FROM nfl_players p
        LEFT JOIN weekly_rosters r ON p.player_id = r.player_id
            AND r.week = ? AND r.season = ?
            AND r.roster_position != 'injured_reserve'
        WHERE r.player_id IS NULL AND p.position = ?
        ORDER BY p.name
    `, [latestWeek.week, currentSeason, position.toUpperCase()]);
    
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
        WHERE LOWER(name) LIKE LOWER(?)
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
    
    // Get current season and latest week
    const currentSeason = 2024; // TODO: Make this dynamic
    const latestWeek = await db.get(`
        SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
    `, [currentSeason]);
    
    // Check if player is on a roster
    const rosterInfo = await db.get(`
        SELECT wr.*, t.team_name, t.owner_name 
        FROM weekly_rosters wr
        JOIN teams t ON wr.team_id = t.team_id
        WHERE wr.player_id = ? AND wr.week = ? AND wr.season = ?
    `, [playerId, latestWeek.week, currentSeason]);
    
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