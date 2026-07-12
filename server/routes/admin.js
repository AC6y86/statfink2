const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { asyncHandler, APIError, logInfo, logError } = require('../utils/errorHandler');
const DataCleanupService = require('../services/dataCleanupService');
const router = express.Router();

// Admin authentication - localhost bypass for local scripts
const requireAdmin = (req, res, next) => {
    // Get client IP address
    const clientIp = req.ip ||
                    req.connection?.remoteAddress ||
                    req.socket?.remoteAddress ||
                    req.headers['x-forwarded-for']?.split(',')[0];

    // Check if request is from localhost
    // Include IPv4, IPv6, and loopback variations
    const localhostPatterns = [
        '127.0.0.1',
        '::1',
        '::ffff:127.0.0.1',
        'localhost'
    ];

    const isLocalhost = localhostPatterns.some(pattern =>
        clientIp && (clientIp === pattern || clientIp.includes(pattern))
    );

    if (isLocalhost) {
        // Allow localhost requests without authentication
        console.log(`Admin API access from localhost: ${req.method} ${req.path}`);
        return next();
    }

    // For external requests, require authentication
    if (!req.session || !req.session.userId) {
        console.log(`Unauthorized admin API attempt from ${clientIp}: ${req.method} ${req.path}`);
        return res.status(401).json({
            error: 'Authentication required for external access',
            message: 'Please login to access admin functions'
        });
    }

    // Authenticated external user
    next();
};

// Add player to team roster
router.post('/roster/add', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId, playerId, rosterPosition = 'active' } = req.body;

    if (!teamId || !playerId) {
        throw new APIError('Team ID and Player ID are required', 400);
    }

    if (!['active', 'injured_reserve'].includes(rosterPosition)) {
        throw new APIError('Invalid roster position. Must be: active or injured_reserve', 400);
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

// Execute paired roster move (drop + add)
router.post('/roster/move', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId, dropPlayerId, addPlayerId, moveType, partnerTeamId, partnerPlayerId } = req.body;

    if (!moveType) {
        throw new APIError('Move Type is required', 400);
    }

    if (!['ir', 'supplemental', 'ir_return', 'trade'].includes(moveType)) {
        throw new APIError('Invalid move type. Must be: ir, supplemental, ir_return, or trade', 400);
    }

    // Handle trade moves separately
    if (moveType === 'trade') {
        if (!teamId || !dropPlayerId || !partnerTeamId || !partnerPlayerId) {
            throw new APIError('For trades: Team ID, Player ID, Partner Team ID, and Partner Player ID are required', 400);
        }

        // Validate both teams exist
        const [team1, team2] = await Promise.all([
            db.getTeam(parseInt(teamId)),
            db.getTeam(parseInt(partnerTeamId))
        ]);

        if (!team1) {
            throw new APIError('Team not found', 404);
        }
        if (!team2) {
            throw new APIError('Partner team not found', 404);
        }

        try {
            const result = await db.executeTrade(
                parseInt(teamId),
                dropPlayerId,
                parseInt(partnerTeamId),
                partnerPlayerId
            );

            res.json({
                success: true,
                message: `Trade completed: ${team1.team_name} traded ${result.team1.gave.name} to ${team2.team_name} for ${result.team1.received.name}`,
                data: {
                    tradeId: result.tradeId,
                    team1: {
                        name: team1.team_name,
                        gave: {
                            id: result.team1.gave.player_id,
                            name: result.team1.gave.name,
                            position: result.team1.gave.position
                        },
                        received: {
                            id: result.team1.received.player_id,
                            name: result.team1.received.name,
                            position: result.team1.received.position
                        }
                    },
                    team2: {
                        name: team2.team_name,
                        gave: {
                            id: result.team2.gave.player_id,
                            name: result.team2.gave.name,
                            position: result.team2.gave.position
                        },
                        received: {
                            id: result.team2.received.player_id,
                            name: result.team2.received.name,
                            position: result.team2.received.position
                        }
                    }
                }
            });
        } catch (error) {
            throw new APIError(error.message, 400);
        }
    } else {
        // Handle regular moves (ir, supplemental, ir_return)
        if (!teamId || !dropPlayerId || !addPlayerId) {
            throw new APIError('Team ID, Drop Player ID, and Add Player ID are required', 400);
        }

        // Validate team exists
        const team = await db.getTeam(parseInt(teamId));
        if (!team) {
            throw new APIError('Team not found', 404);
        }

        try {
            const result = await db.executeRosterMove(
                parseInt(teamId),
                dropPlayerId,
                addPlayerId,
                moveType
            );

            let message;
            if (moveType === 'ir') {
                message = `Roster move completed: ${result.dropped.name} to IR, ${result.added.name} added`;
            } else if (moveType === 'ir_return') {
                message = `IR return completed: ${result.added.name} activated from IR, ${result.dropped.name} dropped`;
            } else {
                message = `Roster move completed: ${result.dropped.name} dropped, ${result.added.name} added`;
            }

            res.json({
                success: true,
                message: message,
                data: {
                    team: team.team_name,
                    moveType: moveType,
                    dropped: {
                        id: result.dropped.player_id,
                        name: result.dropped.name,
                        position: result.dropped.position
                    },
                    added: {
                        id: result.added.player_id,
                        name: result.added.name,
                        position: result.added.position
                    }
                }
            });
        } catch (error) {
            throw new APIError(error.message, 400);
        }
    }
}));

// Check player availability
router.get('/roster/check-availability/:playerId', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { playerId } = req.params;

    if (!playerId) {
        throw new APIError('Player ID is required', 400);
    }

    const availability = await db.isPlayerAvailable(playerId);

    res.json({
        success: true,
        playerId: playerId,
        available: availability.available,
        reason: availability.reason,
        player: availability.player,
        currentTeam: availability.currentTeam || null,
        currentOwner: availability.currentOwner || null
    });
}));

// Update roster position (active/injured_reserve)
router.post('/roster/position', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { teamId, playerId, rosterPosition } = req.body;

    if (!teamId || !playerId || !rosterPosition) {
        throw new APIError('Team ID, Player ID, and roster position are required', 400);
    }

    if (!['active', 'injured_reserve'].includes(rosterPosition)) {
        throw new APIError('Invalid roster position. Must be: active or injured_reserve', 400);
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

// Get admin dashboard summary
router.get('/dashboard', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    
    const [teams, totalPlayers, settings] = await Promise.all([
        db.getAllTeams(),
        db.get('SELECT COUNT(*) as count FROM nfl_players'),
        db.getLeagueSettings()
    ]);
    
    // Count total rostered players from current week
    const currentSeason = settings.season_year;
    const latestWeek = await db.get(`
        SELECT MAX(week) as week FROM weekly_rosters WHERE season = ?
    `, [currentSeason]);
    
    const rosteredPlayers = await db.get(`
        SELECT COUNT(*) as count FROM weekly_rosters 
        WHERE week = ? AND season = ?
    `, [latestWeek.week, currentSeason]);
    
    // Get teams with roster issues (every team must have exactly 19 active players)
    const teamsWithIssues = [];
    for (const team of teams) {
        const roster = await db.getTeamRoster(team.team_id);
        const active = roster.filter(p => p.roster_position === 'active');

        if (active.length !== 19) {
            teamsWithIssues.push({
                ...team,
                activeCount: active.length,
                issue: active.length < 19 ? 'Too few active players' : 'Too many active players'
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
    const scoringPlayersService = req.app.locals.scoringPlayersService;
    const db = req.app.locals.db;

    if (!playerSyncService) {
        throw new APIError('Player sync service not available', 500);
    }

    // Step 1: Sync player data
    const result = await playerSyncService.forceSyncPlayers();

    // Step 2: Get current week and season
    const settings = await db.get('SELECT * FROM league_settings WHERE league_id = 1');
    const currentWeek = settings.current_week;
    const currentSeason = settings.season_year;

    // Step 3: Sync player stats for current week
    let statsResult = null;
    if (playerSyncService.syncPlayerStats) {
        logInfo(`Syncing player stats for week ${currentWeek}, season ${currentSeason}`);
        statsResult = await playerSyncService.syncPlayerStats(currentWeek, currentSeason);
    }

    // Step 4: Re-mark scoring lineups and update matchup totals from them.
    // (Never teamScoreService's old full-roster recalculation - it corrupted
    // official matchup scores; see teamScoreService.js.)
    let teamScoresUpdated = false;
    let teamsUpdated = 0;
    try {
        if (scoringPlayersService) {
            logInfo('Recalculating scoring lineups and matchup totals after force sync...');
            const scoringResult = await scoringPlayersService.calculateScoringPlayers(currentWeek, currentSeason);
            teamScoresUpdated = scoringResult.success;
            teamsUpdated = scoringResult.teamsProcessed || 0;
            logInfo(`Scoring lineups recalculated: ${teamsUpdated} teams updated`);
        }
    } catch (teamScoreError) {
        logError('Failed to recalculate scoring lineups:', teamScoreError);
    }

    res.json({
        success: true,
        message: `Force sync completed. ${teamsUpdated} team scores updated.`,
        data: {
            playerSync: result,
            statsSync: statsResult,
            teamScoresUpdated,
            teamsUpdated,
            week: currentWeek,
            season: currentSeason
        }
    });
}));

// Force sync current week games (full sync - all games with cache bypass)
router.post('/sync/games/current-week', requireAdmin, asyncHandler(async (req, res) => {
    const nflGamesService = req.app.locals.nflGamesService;
    const tank01Service = req.app.locals.tank01Service;
    const db = req.app.locals.db;
    
    if (!nflGamesService) {
        throw new APIError('NFL Games service not available', 500);
    }
    
    if (!tank01Service) {
        throw new APIError('Tank01 service not available', 500);
    }
    
    try {
        // Get current week and season from league settings
        const settings = await db.get('SELECT * FROM league_settings WHERE league_id = 1');
        const currentWeek = settings.current_week;
        const currentSeason = settings.season_year;

        logInfo(`Starting full sync (with cache bypass) for week ${currentWeek}, season ${currentSeason}`);

        // Initialize cleanup service and wipe existing stats for this week
        const dataCleanupService = new DataCleanupService(db);
        logInfo(`Wiping existing stats for week ${currentWeek}, season ${currentSeason}...`);
        const cleanupResult = await dataCleanupService.cleanWeekData(currentWeek, currentSeason);
        logInfo(`Cleaned ${cleanupResult.statsDeleted} player stats and ${cleanupResult.gamesDeleted} games`);

        // First, get the list of games for the week (1 API call, bypassing cache)
        const gamesData = await tank01Service.getNFLGamesForWeek(currentWeek, currentSeason, true);
        
        if (!gamesData || typeof gamesData !== 'object') {
            throw new APIError('No games data received from Tank01 API', 500);
        }
        
        // Extract games from Tank01 response format
        const allValues = Object.values(gamesData);
        const games = allValues.filter(game => game && typeof game === 'object' && game.gameID);
        
        logInfo(`Found ${games.length} total games for week ${currentWeek}`);
        
        // Check existing game statuses in database
        const existingGames = await db.all(
            'SELECT game_id, status FROM nfl_games WHERE week = ? AND season = ?',
            [currentWeek, currentSeason]
        );
        
        const existingGameMap = new Map(existingGames.map(g => [g.game_id, g.status]));
        
        let gamesUpdated = 0;
        let gamesSkipped = 0;
        let apiCallsMade = 1; // Already made one for the games list
        const results = [];
        
        // Process each game
        for (const game of games) {
            const existingStatus = existingGameMap.get(game.gameID);
            
            // Always update all games in full sync mode
            try {
                // First update the game info
                await nflGamesService.upsertGame(game, currentWeek, currentSeason);
                    
                // Use updateGameFromAPI which handles both scores AND player stats
                logInfo(`Updating game and player stats for ${game.gameID} (bypassing cache)`);
                const updated = await nflGamesService.updateGameFromAPI(game.gameID, true); // Pass bypassCache flag
                apiCallsMade++;
                    
                if (updated) {
                    // Get the updated game info for the response
                    const updatedGame = await db.get(`
                        SELECT home_score, away_score, status 
                        FROM nfl_games 
                        WHERE game_id = ?
                    `, [game.gameID]);
                    
                    gamesUpdated++;
                    results.push({
                        gameID: game.gameID,
                        action: 'updated',
                        status: updatedGame.status,
                        scores: `${updatedGame.away_score}-${updatedGame.home_score}`,
                        playerStatsUpdated: true
                    });
                    logInfo(`Updated game ${game.gameID}: ${updatedGame.status} (${updatedGame.away_score}-${updatedGame.home_score}) with player stats`);
                } else {
                    results.push({
                        gameID: game.gameID,
                        action: 'failed',
                        reason: 'Failed to update from API'
                    });
                }
            } catch (gameError) {
                logError(`Failed to update game ${game.gameID}:`, gameError);
                results.push({
                    gameID: game.gameID,
                    action: 'error',
                    error: gameError.message
                });
            }
        }
        
        // Always calculate DST fantasy points (defensive TDs count immediately)
        const fantasyPointsService = req.app.locals.fantasyPointsCalculationService;
        if (fantasyPointsService) {
            logInfo('Calculating DST fantasy points (including defensive TDs)...');
            const dstResult = await fantasyPointsService.calculateEndOfWeekDSTBonuses(
                currentSeason
            );
            logInfo(`✓ DST fantasy points updated for ${dstResult.updated} teams`);

            // Log some examples to verify
            const sample = await db.all(`
                SELECT player_id, def_int_return_tds, def_fumble_return_tds,
                       def_blocked_return_tds, def_points_bonus, def_yards_bonus, fantasy_points
                FROM player_stats
                WHERE week = ? AND season = ? AND player_id LIKE 'DEF_%'
                AND (def_int_return_tds > 0 OR def_fumble_return_tds > 0
                     OR def_blocked_return_tds > 0 OR def_points_bonus > 0 OR def_yards_bonus > 0)
                LIMIT 5
            `, [currentWeek, currentSeason]);

            sample.forEach(dst => {
                logInfo(`  ${dst.player_id}: ${dst.fantasy_points} pts ` +
                       `(TDs: INT=${dst.def_int_return_tds}/FUM=${dst.def_fumble_return_tds}/BLK=${dst.def_blocked_return_tds}, ` +
                       `Bonuses: ${dst.def_points_bonus}/${dst.def_yards_bonus})`);
            });
        }

        // Check if all games are complete for defensive bonus calculation
        const gamesComplete = await nflGamesService.areAllWeekGamesComplete(currentWeek, currentSeason);
        logInfo(`Games complete check for Week ${currentWeek}: ${JSON.stringify(gamesComplete)}`);

        if (gamesComplete.isComplete) {
            logInfo('All games complete - calculating defensive bonuses...');

            // Calculate defensive bonuses (5 pts for fewest points/yards allowed)
            const scoringService = req.app.locals.scoringService;
            if (scoringService) {
                const bonusResult = await scoringService.calculateDefensiveBonuses(
                    currentWeek,
                    currentSeason
                );

                if (bonusResult.success) {
                    logInfo(`✓ Defensive bonuses calculated for ${bonusResult.teamsProcessed} DST teams`);

                    // Recalculate DST fantasy points again to include bonuses
                    if (fantasyPointsService) {
                        const dstBonusResult = await fantasyPointsService.calculateEndOfWeekDSTBonuses(
                            currentSeason
                        );
                        logInfo(`✓ DST fantasy points updated with bonuses for ${dstBonusResult.updated} teams`);
                    }

                    // Recalculate scoring players now that DSTs have final points
                    const scoringPlayersService = req.app.locals.scoringPlayersService;
                    if (scoringPlayersService) {
                        logInfo(`Starting scoring players calculation for Week ${currentWeek}...`);
                        const scoringResult = await scoringPlayersService.calculateScoringPlayers(
                            currentWeek,
                            currentSeason
                        );
                        logInfo(`✓ Scoring players recalculated: ${scoringResult.playersMarked} players marked`);
                    } else {
                        logInfo('WARNING: scoringPlayersService not available');
                    }
                }
            }
        } else {
            logInfo(`Week ${currentWeek} not complete (${gamesComplete.completedGames}/${gamesComplete.totalGames} games done) - bonuses will be calculated when all games finish`);
        }
        
        // Re-mark scoring lineups and update matchup totals from them after
        // the stats update. (Never teamScoreService's old full-roster
        // recalculation - it corrupted official matchup scores.)
        let teamScoresUpdated = false;
        let teamsUpdated = 0;
        try {
            const scoringPlayersService = req.app.locals.scoringPlayersService;
            if (scoringPlayersService) {
                logInfo('Recalculating scoring lineups after player stats update...');
                const scoringResult = await scoringPlayersService.calculateScoringPlayers(currentWeek, currentSeason);
                teamScoresUpdated = scoringResult.success;
                teamsUpdated = scoringResult.teamsProcessed || 0;
                logInfo(`Scoring lineups recalculated: ${teamsUpdated} teams updated`);
            }
        } catch (teamScoreError) {
            logError('Failed to recalculate scoring lineups:', teamScoreError);
        }
        
        const message = `Full sync completed: ${gamesUpdated} games updated, ${teamsUpdated} team scores recalculated`;
        logInfo(message);
        
        res.json({
            success: true,
            message,
            data: {
                week: currentWeek,
                season: currentSeason,
                totalGames: games.length,
                gamesUpdated,
                gamesSkipped,
                apiCallsMade,
                results,
                teamScoresUpdated,
                teamsUpdated
            }
        });
        
    } catch (error) {
        logError('Failed to sync current week games:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to sync current week games',
            error: error.message
        });
    }
}));

// Force sync specific week games (full sync - all games with cache bypass for a specific week)
router.post('/sync/games/specific-week', requireAdmin, asyncHandler(async (req, res) => {
    const nflGamesService = req.app.locals.nflGamesService;
    const tank01Service = req.app.locals.tank01Service;
    const db = req.app.locals.db;

    const { season, week } = req.body;

    // Validate inputs
    if (!season || !week) {
        return res.status(400).json({
            success: false,
            message: 'Season and week are required'
        });
    }

    const seasonNum = parseInt(season);
    const weekNum = parseInt(week);

    const settings = await db.getLeagueSettings();
    const maxSeason = (settings?.season_year || new Date().getFullYear()) + 1;
    if (isNaN(seasonNum) || seasonNum < 2024 || seasonNum > maxSeason) {
        return res.status(400).json({
            success: false,
            message: `Invalid season. Must be between 2024 and ${maxSeason}`
        });
    }

    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        return res.status(400).json({
            success: false,
            message: 'Invalid week. Must be between 1 and 18'
        });
    }

    if (!nflGamesService) {
        throw new APIError('NFL Games service not available', 500);
    }

    if (!tank01Service) {
        throw new APIError('Tank01 service not available', 500);
    }

    try {
        logInfo(`Starting full sync (with cache bypass) for specific week ${weekNum}, season ${seasonNum}`);

        // Initialize cleanup service and wipe existing stats for this week
        const dataCleanupService = new DataCleanupService(db);
        logInfo(`Wiping existing stats for week ${weekNum}, season ${seasonNum}...`);
        const cleanupResult = await dataCleanupService.cleanWeekData(weekNum, seasonNum);
        logInfo(`Cleaned ${cleanupResult.statsDeleted} player stats and ${cleanupResult.gamesDeleted} games`);

        // First, get the list of games for the week (1 API call, bypassing cache)
        const gamesData = await tank01Service.getNFLGamesForWeek(weekNum, seasonNum, true);

        if (!gamesData || typeof gamesData !== 'object') {
            throw new APIError('No games data received from Tank01 API', 500);
        }

        // Extract games from Tank01 response format
        const allValues = Object.values(gamesData);
        const games = allValues.filter(game => game && typeof game === 'object' && game.gameID);

        logInfo(`Found ${games.length} total games for week ${weekNum}`);

        // Check existing game statuses in database
        const existingGames = await db.all(
            'SELECT game_id, status FROM nfl_games WHERE week = ? AND season = ?',
            [weekNum, seasonNum]
        );

        const existingGameMap = new Map(existingGames.map(g => [g.game_id, g.status]));

        let gamesUpdated = 0;
        let gamesSkipped = 0;
        let apiCallsMade = 1; // Already made one for the games list
        const results = [];

        // Process each game
        for (const game of games) {
            const existingStatus = existingGameMap.get(game.gameID);

            // Always update all games in full sync mode
            try {
                // First update the game info
                await nflGamesService.upsertGame(game, weekNum, seasonNum);

                // Use updateGameFromAPI which handles both scores AND player stats
                logInfo(`Updating game and player stats for ${game.gameID} (bypassing cache)`);
                const updated = await nflGamesService.updateGameFromAPI(game.gameID, true); // Pass bypassCache flag
                apiCallsMade++;

                if (updated) {
                    // Get the updated game info for the response
                    const updatedGame = await db.get(`
                        SELECT home_score, away_score, status
                        FROM nfl_games
                        WHERE game_id = ?
                    `, [game.gameID]);

                    gamesUpdated++;
                    results.push({
                        gameID: game.gameID,
                        action: 'updated',
                        status: updatedGame.status,
                        scores: `${updatedGame.away_score}-${updatedGame.home_score}`,
                        playerStatsUpdated: true
                    });
                    logInfo(`Updated game ${game.gameID}: ${updatedGame.status} (${updatedGame.away_score}-${updatedGame.home_score}) with player stats`);
                } else {
                    results.push({
                        gameID: game.gameID,
                        action: 'failed',
                        reason: 'Failed to update from API'
                    });
                }

            } catch (error) {
                logError(`Failed to update game ${game.gameID}:`, error);
                results.push({
                    gameID: game.gameID,
                    action: 'error',
                    error: error.message
                });
            }
        }

        // After all games are updated, calculate defensive bonuses
        const scoringService = req.app.locals.scoringService;
        if (scoringService) {
            const bonusResult = await scoringService.calculateDefensiveBonuses(
                weekNum,
                seasonNum
            );

            if (bonusResult.success) {
                logInfo(`✓ Defensive bonuses calculated for ${bonusResult.teamsProcessed} DST teams`);

                // Step 2: Recalculate ALL DST fantasy points (includes TDs + bonuses)
                const fantasyPointsService = req.app.locals.fantasyPointsCalculationService;
                if (fantasyPointsService) {
                    const dstResult = await fantasyPointsService.calculateEndOfWeekDSTBonuses(
                        seasonNum
                    );
                    logInfo(`✓ DST fantasy points updated for ${dstResult.updated} teams`);

                    // Log some examples to verify
                    const sample = await db.all(`
                        SELECT player_id, def_int_return_tds, def_fumble_return_tds,
                               def_points_bonus, def_yards_bonus, fantasy_points
                        FROM player_stats
                        WHERE week = ? AND season = ? AND player_id LIKE 'DEF_%'
                        AND (def_int_return_tds > 0 OR def_fumble_return_tds > 0
                             OR def_points_bonus > 0 OR def_yards_bonus > 0)
                        LIMIT 3
                    `, [weekNum, seasonNum]);

                    sample.forEach(dst => {
                        logInfo(`  ${dst.player_id}: ${dst.fantasy_points} pts ` +
                               `(TDs: ${dst.def_int_return_tds}/${dst.def_fumble_return_tds}, ` +
                               `Bonuses: ${dst.def_points_bonus}/${dst.def_yards_bonus})`);
                    });
                }

                // Step 3: Recalculate scoring players now that DSTs have points
                const scoringPlayersService = req.app.locals.scoringPlayersService;
                if (scoringPlayersService) {
                    logInfo(`Starting scoring players calculation for Week ${weekNum}...`);
                    const scoringResult = await scoringPlayersService.calculateScoringPlayers(
                        weekNum,
                        seasonNum
                    );
                    logInfo(`✓ Scoring players recalculated: ${scoringResult.playersMarked} players marked`);
                } else {
                    logInfo('WARNING: scoringPlayersService not available');
                }
            }
        }

        // After defensive bonuses and DST points are calculated, recalculate team scores
        let teamScoresUpdated = false;
        let teamsUpdated = 0;

        try {
            const teamUpdates = await db.all(`
                SELECT DISTINCT t.team_id, t.owner_name
                FROM teams t
                WHERE EXISTS (
                    SELECT 1 FROM weekly_rosters wr
                    WHERE wr.team_id = t.team_id
                    AND wr.week = ?
                    AND wr.season = ?
                )
            `, [weekNum, seasonNum]);

            for (const team of teamUpdates) {
                try {
                    await db.run(`
                        UPDATE teams
                        SET week_${weekNum}_score = (
                            SELECT COALESCE(SUM(ps.fantasy_points), 0)
                            FROM weekly_rosters wr
                            JOIN player_stats ps ON wr.player_id = ps.player_id
                                AND wr.week = ps.week
                                AND wr.season = ps.season
                            WHERE wr.team_id = ?
                            AND wr.week = ?
                            AND wr.season = ?
                            AND wr.roster_position = 'active'
                        )
                        WHERE team_id = ?
                    `, [team.team_id, weekNum, seasonNum, team.team_id]);

                    teamsUpdated++;
                    logInfo(`Recalculated week ${weekNum} score for team ${team.owner_name}`);
                } catch (error) {
                    logError(`Failed to update team score for ${team.owner_name}:`, error);
                }
            }

            teamScoresUpdated = true;
            logInfo(`Recalculated scores for ${teamsUpdated} teams`);
        } catch (error) {
            logError('Failed to recalculate team scores:', error);
        }

        logInfo(`Full sync completed: ${gamesUpdated} games updated, ${gamesSkipped} skipped, ${apiCallsMade} API calls made`);

        res.json({
            success: true,
            message: `Successfully synced ${gamesUpdated} games for week ${weekNum}`,
            data: {
                week: weekNum,
                season: seasonNum,
                totalGames: games.length,
                gamesUpdated,
                gamesSkipped,
                apiCallsMade,
                results,
                teamScoresUpdated,
                teamsUpdated
            }
        });

    } catch (error) {
        logError(`Failed to sync week ${weekNum} games:`, error);
        res.status(500).json({
            success: false,
            message: `Failed to sync week ${weekNum} games`,
            error: error.message
        });
    }
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

// Scheduler endpoints
router.post('/scheduler/daily', requireAdmin, asyncHandler(async (req, res) => {
    const schedulerService = req.app.locals.schedulerService;
    
    if (!schedulerService) {
        throw new APIError('Scheduler service not available', 500);
    }
    
    const result = await schedulerService.performDailyUpdate();
    
    if (result.success) {
        res.json({
            success: true,
            message: result.message,
            data: result
        });
    } else {
        res.status(500).json({
            success: false,
            message: result.message,
            data: result
        });
    }
}));

router.post('/scheduler/weekly', requireAdmin, asyncHandler(async (req, res) => {
    const schedulerService = req.app.locals.schedulerService;
    
    if (!schedulerService) {
        throw new APIError('Scheduler service not available', 500);
    }
    
    const result = await schedulerService.performWeeklyUpdate();
    
    if (result.success) {
        res.json({
            success: true,
            message: result.message,
            data: result
        });
    } else {
        res.status(500).json({
            success: false,
            message: result.message,
            data: result
        });
    }
}));

router.post('/scheduler/live', requireAdmin, asyncHandler(async (req, res) => {
    const schedulerService = req.app.locals.schedulerService;
    
    if (!schedulerService) {
        throw new APIError('Scheduler service not available', 500);
    }
    
    const result = await schedulerService.performLiveGameUpdate();
    
    if (result.success) {
        res.json({
            success: true,
            message: result.message,
            data: result
        });
    } else {
        res.status(500).json({
            success: false,
            message: result.message,
            data: result
        });
    }
}));

router.get('/scheduler/status', requireAdmin, asyncHandler(async (req, res) => {
    const schedulerService = req.app.locals.schedulerService;
    
    if (!schedulerService) {
        throw new APIError('Scheduler service not available', 500);
    }
    
    const status = schedulerService.getStatus();
    
    res.json({
        success: true,
        data: status
    });
}));

// Get current cron schedules
router.get('/scheduler/schedules', requireAdmin, asyncHandler(async (req, res) => {
    const PM2ConfigUpdater = require('../utils/pm2ConfigUpdater');
    const updater = new PM2ConfigUpdater();
    
    try {
        const schedules = await updater.getCurrentSchedules();
        res.json({
            success: true,
            data: schedules
        });
    } catch (error) {
        throw new APIError('Failed to get current schedules', 500);
    }
}));

// Update cron schedule
router.post('/scheduler/update-schedule', requireAdmin, asyncHandler(async (req, res) => {
    const { taskName, scheduleConfig } = req.body;
    
    if (!taskName || !scheduleConfig) {
        throw new APIError('Task name and schedule configuration are required', 400);
    }
    
    const PM2ConfigUpdater = require('../utils/pm2ConfigUpdater');
    const updater = new PM2ConfigUpdater();
    
    try {
        const result = await updater.updateSchedule(taskName, scheduleConfig);
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        throw new APIError(`Failed to update schedule: ${error.message}`, 500);
    }
}));

// Enable real-time scoring
router.post('/scheduler/realtime/enable', requireAdmin, asyncHandler(async (req, res) => {
    const schedulerService = req.app.locals.schedulerService;
    const { interval = 5 } = req.body; // Default 5 minutes
    
    if (!schedulerService) {
        throw new APIError('Scheduler service not available', 500);
    }
    
    schedulerService.enableRealTimeScoring(interval);
    
    res.json({
        success: true,
        message: `Real-time scoring enabled with ${interval} minute interval`,
        data: {
            enabled: true,
            interval: interval
        }
    });
}));

// Disable real-time scoring
router.post('/scheduler/realtime/disable', requireAdmin, asyncHandler(async (req, res) => {
    const schedulerService = req.app.locals.schedulerService;
    
    if (!schedulerService) {
        throw new APIError('Scheduler service not available', 500);
    }
    
    schedulerService.disableRealTimeScoring();
    
    res.json({
        success: true,
        message: 'Real-time scoring disabled',
        data: {
            enabled: false
        }
    });
}));

// Get real-time scoring status
router.get('/scheduler/realtime/status', requireAdmin, asyncHandler(async (req, res) => {
    const schedulerService = req.app.locals.schedulerService;
    
    if (!schedulerService) {
        throw new APIError('Scheduler service not available', 500);
    }
    
    const status = schedulerService.getRealTimeStatus();
    
    res.json({
        success: true,
        data: status
    });
}));

// Debug endpoint to undo weekly update
router.post('/debug/undo-weekly-update', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { undoWeeklyUpdate } = require('../utils/undoWeeklyUpdate');
    
    const result = await undoWeeklyUpdate(db);
    
    if (result.success) {
        res.json(result);
    } else {
        res.status(500).json(result);
    }
}));

// Generate weekly report
router.post('/weekly-report/generate', requireAdmin, asyncHandler(async (req, res) => {
    const weeklyReportService = req.app.locals.weeklyReportService;
    const { week, season } = req.body;
    
    if (!weeklyReportService) {
        throw new APIError('Weekly report service not initialized', 500);
    }
    
    // Use current week/season if not provided
    let reportWeek = week;
    let reportSeason = season;
    
    if (!reportWeek || !reportSeason) {
        const db = req.app.locals.db;
        const settings = await db.get(
            'SELECT current_week, season_year FROM league_settings WHERE league_id = 1'
        );
        reportWeek = reportWeek || settings.current_week;
        reportSeason = reportSeason || settings.season_year;
    }
    
    const result = await weeklyReportService.generateWeeklyReport(reportWeek, reportSeason);
    
    if (result.success) {
        res.json({
            success: true,
            message: result.message,
            filepath: result.filepath,
            filename: result.filename,
            week: reportWeek,
            season: reportSeason,
            validation: result.validation
        });
    } else {
        res.status(500).json({
            success: false,
            message: result.message
        });
    }
}));

// Test runner endpoints
const TestRunnerService = require('../services/testRunnerService');

// Clear data for a specific week
router.post('/test/clear-week-data', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { week } = req.body;
    const season = req.body.season ? parseInt(req.body.season) : (await db.getLeagueSettings()).season_year;

    if (!week) {
        throw new APIError('Week number is required', 400);
    }

    const dataCleanupService = new DataCleanupService(db);

    logInfo(`Admin request to clear data for week ${week}, season ${season}`);

    try {
        const result = await dataCleanupService.cleanWeekData(week, season);

        logInfo(`Successfully cleared week ${week} data: ${result.statsDeleted} stats, ${result.gamesDeleted} games, ${result.matchupsReset} matchups reset`);

        res.json({
            success: true,
            message: `Cleared data for week ${week}, season ${season}`,
            statsDeleted: result.statsDeleted,
            gamesDeleted: result.gamesDeleted,
            matchupsReset: result.matchupsReset
        });
    } catch (error) {
        logError(`Failed to clear week ${week} data:`, error);
        throw new APIError(`Failed to clear data: ${error.message}`, 500);
    }
}));

// Get available weeks for testing
router.get('/test/available-weeks', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const testRunner = new TestRunnerService(db);
    const season = parseInt(req.query.season) || (await db.getLeagueSettings()).season_year;

    const weeks = await testRunner.getAvailableWeeks(season);

    res.json({
        success: true,
        season: season,
        weeks: weeks
    });
}));

// Run validateEndOfWeek test
router.post('/test/validate-week', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const testRunner = new TestRunnerService(db);
    const { week } = req.body;
    const season = req.body.season ? parseInt(req.body.season) : (await db.getLeagueSettings()).season_year;

    if (!week) {
        throw new APIError('Week number is required', 400);
    }

    logInfo(`Running validateEndOfWeek test for week ${week}, season ${season}`);

    const results = await testRunner.runValidateEndOfWeekTest(parseInt(week), parseInt(season));

    res.json({
        success: true,
        results: results
    });
}));

// Run stats completeness test
router.post('/test/stats-completeness', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const testRunner = new TestRunnerService(db);
    const { week } = req.body;
    const season = req.body.season ? parseInt(req.body.season) : (await db.getLeagueSettings()).season_year;

    if (!week) {
        throw new APIError('Week number is required', 400);
    }

    logInfo(`Running stats completeness test for week ${week}, season ${season}`);

    const results = await testRunner.runStatsCompletenessTest(parseInt(week), parseInt(season));

    res.json({
        success: true,
        results: results
    });
}));

// List pending email moves. ?status=pending|needs_review|approved|rejected|failed
router.get('/pending-moves', requireAdmin, asyncHandler(async (req, res) => {
    const pendingMovesService = req.app.locals.pendingMovesService;
    if (!pendingMovesService) {
        throw new APIError('Pending moves service not available', 500);
    }

    const items = await pendingMovesService.getItems({ status: req.query.status || null });
    const pendingCount = await pendingMovesService.getPendingCount();

    res.json({ success: true, data: { items, pendingCount } });
}));

// Approve a pending email move - re-validates, then executes the move
router.post('/pending-moves/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
    const pendingMovesService = req.app.locals.pendingMovesService;
    if (!pendingMovesService) {
        throw new APIError('Pending moves service not available', 500);
    }

    const moveTypeOverride = req.body?.moveType || null;
    logInfo(`Approving pending email move ${req.params.id}${moveTypeOverride ? ` as ${moveTypeOverride}` : ''}`);
    const item = await pendingMovesService.approveItem(req.params.id, 'commissioner', { moveTypeOverride });

    res.json({
        success: item.status === 'approved',
        data: item,
        message: item.status === 'approved'
            ? `Move executed: ${item.executionResult.message}`
            : `Move failed: ${item.executionResult?.message || 'unknown error'}`
    });
}));

// Reject a pending email move
router.post('/pending-moves/:id/reject', requireAdmin, asyncHandler(async (req, res) => {
    const pendingMovesService = req.app.locals.pendingMovesService;
    if (!pendingMovesService) {
        throw new APIError('Pending moves service not available', 500);
    }

    logInfo(`Rejecting pending email move ${req.params.id}`);
    const item = await pendingMovesService.rejectItem(req.params.id, req.body?.reason || null);

    res.json({ success: true, data: item });
}));

// Get health alerts (newest first). ?unacknowledged=true to filter.
router.get('/health/alerts', requireAdmin, asyncHandler(async (req, res) => {
    const healthCheckService = req.app.locals.healthCheckService;
    if (!healthCheckService) {
        throw new APIError('Health check service not available', 500);
    }

    const unacknowledgedOnly = req.query.unacknowledged === 'true';
    const alerts = await healthCheckService.getAlerts({ unacknowledgedOnly });
    const unacknowledgedCount = unacknowledgedOnly
        ? alerts.length
        : alerts.filter(a => !a.acknowledged).length;

    res.json({
        success: true,
        data: {
            alerts,
            unacknowledgedCount
        }
    });
}));

// Acknowledge health alerts. Body: { ids: [...] } or empty to ack all.
router.post('/health/alerts/ack', requireAdmin, asyncHandler(async (req, res) => {
    const healthCheckService = req.app.locals.healthCheckService;
    if (!healthCheckService) {
        throw new APIError('Health check service not available', 500);
    }

    const { ids } = req.body || {};
    const result = await healthCheckService.acknowledgeAlerts(ids || null);

    res.json({
        success: true,
        data: result
    });
}));

// Manually run health validation. Body: { week, season, mode } (defaults to
// current week/season from league settings, full mode).
router.post('/health/validate', requireAdmin, asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const healthCheckService = req.app.locals.healthCheckService;
    if (!healthCheckService) {
        throw new APIError('Health check service not available', 500);
    }

    const settings = await db.getLeagueSettings();
    const week = parseInt(req.body?.week) || settings.current_week;
    const season = parseInt(req.body?.season) || settings.season_year;
    const mode = req.body?.mode === 'light' ? 'light' : 'full';

    logInfo(`Manual health validation triggered for week ${week}, season ${season} (${mode})`);

    const results = await healthCheckService.runValidation(week, season, { mode });

    res.json({
        success: true,
        data: results
    });
}));

// Latest scheduled weekly validation status (written by scripts/weekly-validate.js).
// Returns data: null when no run has happened yet.
router.get('/health/weekly-validation', requireAdmin, asyncHandler(async (req, res) => {
    const statusFile = path.join(__dirname, '../../logs/weekly-validation-latest.json');
    let data = null;
    try {
        data = JSON.parse(await fs.readFile(statusFile, 'utf8'));
    } catch (error) {
        // Missing or corrupt file: no run yet
    }
    res.json({ success: true, data });
}));

module.exports = router;