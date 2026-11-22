const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { asyncHandler, APIError, logInfo, logError } = require('../utils/errorHandler');
const DataCleanupService = require('../services/dataCleanupService');
const { trustedVia } = require('../auth/trust');
const { parseQuestionId, AWARD_CLASSES } = require('../services/jobStatusService');
const router = express.Router();

// Admin authentication. Password-free only for the loopback Tailscale
// listener and bare local calls (cron scripts) - decided by the socket the
// request arrived on, see server/auth/trust.js. (setupAuth's requireAuth
// already guards /api/admin; this is the per-route second gate.)
const requireAdmin = (req, res, next) => {
    const trust = trustedVia(req);
    if (trust.via) {
        req.adminVia = trust.via;
        return next();
    }

    // For external requests, require authentication
    if (!req.session || !req.session.userId) {
        console.log(`Unauthorized admin API attempt from ${req.ip}: ${req.method} ${req.path}`);
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
                partnerPlayerId,
                { asOf: req.body.requestedAt || null } // when the owner asked (drop lock); omitted = now
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
                moveType,
                { asOf: req.body.requestedAt || null } // when the owner asked (drop lock); omitted = now
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
            }
        }

        // ALWAYS re-select the scoring lineups and rewrite the matchup totals:
        // cleanWeekData() above zeroed matchups.team*_scoring_points, and until
        // 2026-09-13 this only ran when the defensive bonuses succeeded (i.e. the
        // week was complete), leaving every matchup at 0 for an in-progress week.
        {
            const scoringPlayersService = req.app.locals.scoringPlayersService;
            if (scoringPlayersService) {
                logInfo(`Starting scoring players calculation for Week ${weekNum}...`);
                const scoringResult = await scoringPlayersService.calculateScoringPlayers(weekNum, seasonNum);
                logInfo(`✓ Scoring players recalculated: ${scoringResult.playersMarked} players marked`);
            } else {
                logInfo('WARNING: scoringPlayersService not available - matchup totals left at 0 by cleanWeekData!');
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

// Weekly advance hold: logs/HOLD-ADVANCE blocks the automatic Wednesday advance
// (scripts/weekly-advance.js) until released. The manual advance above ignores it.
const HOLD_ADVANCE_FILE = path.join(__dirname, '../../logs/HOLD-ADVANCE');
async function readAdvanceHold() {
    try {
        const raw = await fs.readFile(HOLD_ADVANCE_FILE, 'utf8');
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch (_) { /* plain file */ }
        return { held: true, reason: parsed.reason || 'held', at: parsed.at || null };
    } catch (_) {
        return { held: false, reason: null, at: null };
    }
}
router.get('/advance/hold', requireAdmin, asyncHandler(async (req, res) => {
    res.json({ success: true, data: await readAdvanceHold() });
}));
router.post('/advance/hold', requireAdmin, asyncHandler(async (req, res) => {
    const hold = req.body && req.body.hold !== false;
    if (hold) {
        const reason = String((req.body && req.body.reason) || 'held from /admin').slice(0, 200);
        await fs.mkdir(path.dirname(HOLD_ADVANCE_FILE), { recursive: true });
        await fs.writeFile(HOLD_ADVANCE_FILE, JSON.stringify({ reason, at: new Date().toISOString() }, null, 2) + '\n');
        logInfo(`Weekly advance held: ${reason}`);
    } else {
        await fs.rm(HOLD_ADVANCE_FILE, { force: true });
        logInfo('Weekly advance hold released');
    }
    res.json({ success: true, data: await readAdvanceHold() });
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

// List pending email moves. ?status=pending|needs_review|failed|approved|rejected
// (pendingCount = items still waiting on the commissioner: pending, needs_review, failed)
router.get('/pending-moves', requireAdmin, asyncHandler(async (req, res) => {
    const pendingMovesService = req.app.locals.pendingMovesService;
    if (!pendingMovesService) {
        throw new APIError('Pending moves service not available', 500);
    }

    const items = await pendingMovesService.getItems({ status: req.query.status || null });
    const pendingCount = await pendingMovesService.getPendingCount();

    res.json({ success: true, data: { items, pendingCount } });
}));

// Attach an informational commissioner ruling to a specific proposal, without execution.
router.post('/pending-moves/:id/link-ruling', requireAdmin, asyncHandler(async (req, res) => {
    const service = req.app.locals.pendingMovesService;
    if (!service) throw new APIError('Pending moves service not available', 500);
    if (typeof req.body?.moveId !== 'string') throw new APIError('moveId is required', 400);
    const note = await service.linkRuling(req.params.id, req.body.moveId);
    res.json({ success: true, data: note });
}));

// Approve a pending email move - re-validates, then executes the move.
// A failed item may be approved again (retry); it stays failed, with the
// execution error on the item, until it succeeds or is rejected.
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

// Commissioner override: execute ONE move the validator refuses (failed
// dry-run or failed execution) despite the refusal. Separate from approve on
// purpose: it requires a written reason, is recorded on the item and in
// roster_moves.notes, and applies only to the selected item.
router.post('/pending-moves/:id/override', requireAdmin, asyncHandler(async (req, res) => {
    const pendingMovesService = req.app.locals.pendingMovesService;
    if (!pendingMovesService) {
        throw new APIError('Pending moves service not available', 500);
    }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) throw new APIError('Override requires a reason', 400);
    const moveTypeOverride = req.body?.moveType || null;
    logInfo(`Commissioner override of pending email move ${req.params.id}${moveTypeOverride ? ` as ${moveTypeOverride}` : ''}`, { reason });
    let item;
    try {
        item = await pendingMovesService.overrideItem(req.params.id, 'commissioner', { reason, moveTypeOverride });
    } catch (error) {
        // Precondition failures (not found, already resolved, not deemed invalid, no reason)
        throw new APIError(error.message, 400);
    }

    res.json({
        success: item.status === 'approved',
        data: item,
        message: item.status === 'approved'
            ? `Override executed: ${item.executionResult.message}${(item.override?.overriddenErrors || []).length ? ` (overrode: ${item.override.overriddenErrors.join('; ')})` : ''}`
            : `Override failed: ${item.executionResult?.message || 'unknown error'}`
    });
}));

// Re-run the read-only validation (fresh NFL.com fetch for IR moves) for an
// unresolved pending/needs_review item. Never executes; may promote
// needs_review -> pending when everything passes.
router.post('/pending-moves/:id/recheck', requireAdmin, asyncHandler(async (req, res) => {
    const pendingMovesService = req.app.locals.pendingMovesService;
    if (!pendingMovesService) {
        throw new APIError('Pending moves service not available', 500);
    }

    logInfo(`Rechecking pending email move ${req.params.id} against NFL.com`);
    const item = await pendingMovesService.revalidateItem(req.params.id, 'commissioner');
    const v = item.validation || {};
    const nfl = v.nflEligibility;

    res.json({
        success: v.valid === true,
        data: item,
        message: v.valid
            ? `Validation passed${nfl ? `: ${nfl.reason}` : ''} - item is ${item.status}`
            : `Validation failed: ${(v.errors || []).join('; ') || 'unknown'}`
    });
}));

// Reject a pending email move (for a failed item: dismiss it)
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
    const unacked = unacknowledgedOnly ? alerts : alerts.filter(a => !a.acknowledged);
    const unacknowledgedCount = unacked.length;
    // Badges count only warning/critical: an 'info' alert (recovery, move queued) is never a call to action
    const actionableCount = unacked.filter(a => a.severity !== 'info').length;

    res.json({
        success: true,
        data: {
            alerts,
            unacknowledgedCount,
            actionableCount
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

// How this request got in (session | tailscale | localhost) and the tailnet
// URL, so the admin app can offer the password-free hand-off when the
// browser turns out to be on the tailnet (helm/admin/js/main.js).
router.get('/context', requireAdmin, (req, res) => {
    res.json({
        success: true,
        data: {
            via: req.adminVia || 'session',
            tailnetUrl: process.env.TAILSCALE_HOSTNAME ? `https://${process.env.TAILSCALE_HOSTNAME}` : null
        }
    });
});

// Latest live-scoring watchdog check (scripts/live-watchdog.js writes
// logs/watchdog/live-latest.json every 2 min) plus the notifier's incident
// state (scripts/watchdog-notifier.js). Either is null before a first run.
router.get('/health/live-watchdog', requireAdmin, asyncHandler(async (req, res) => {
    const dir = path.join(__dirname, '../../logs/watchdog');
    const readJson = async file => {
        try {
            return JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
        } catch (error) {
            return null; // Missing or corrupt: no run yet
        }
    };
    res.json({
        success: true,
        data: {
            latest: await readJson('live-latest.json'),
            notifier: await readJson('notifier-state.json')
        }
    });
}));

// ==================== Verification status ====================
// One snapshot of every scheduled job, the live watchdog, the daily
// validation, the Double Check (questions + Opus resolutions + rulings),
// recaps and unacked alerts (server/services/jobStatusService.js). Drawn by
// /admin/status; the same data is on /api/internal/status for cron scripts.
router.get('/status', requireAdmin, asyncHandler(async (req, res) => {
    const jobStatusService = req.app.locals.jobStatusService;
    if (!jobStatusService) {
        throw new APIError('Job status service not available', 500);
    }
    res.json({ success: true, data: await jobStatusService.snapshot() });
}));

// Commissioner ruling on a Double Check question. Body: { questionId,
// awardClass, note, season?, week? }. Upserts logs/doublecheck/rulings.json,
// then re-runs the script-only finalize so report.md / latest.json reflect it.
router.post('/doublecheck/ruling', requireAdmin, asyncHandler(async (req, res) => {
    const jobStatusService = req.app.locals.jobStatusService;
    if (!jobStatusService) {
        throw new APIError('Job status service not available', 500);
    }
    const { questionId, awardClass, note } = req.body || {};
    const parsed = parseQuestionId(questionId);
    const season = parseInt(req.body?.season) || (parsed && parsed.season);
    const week = parseInt(req.body?.week) || (parsed && parsed.week);
    if (!questionId || typeof questionId !== 'string') {
        throw new APIError('questionId is required', 400);
    }
    if (!AWARD_CLASSES.includes(awardClass)) {
        throw new APIError(`awardClass must be one of: ${AWARD_CLASSES.join(', ')}`, 400);
    }
    if (!season || !week) {
        throw new APIError('season and week are required (or a questionId like 2026-wk01-...)', 400);
    }

    const ruling = jobStatusService.saveRuling({ questionId, awardClass, note, by: req.adminVia || 'session' });
    logInfo(`Ruling saved for ${questionId}: ${awardClass} (${ruling.by})`);
    const finalize = await jobStatusService.runFinalize(season, week, { timeoutMs: 60000 });
    if (finalize.exitCode !== 0) {
        logError(`doublecheck-finalize after ruling ${questionId} exited ${finalize.exitCode}${finalize.error ? `: ${finalize.error}` : ''}`);
    }
    res.json({ success: true, data: { ruling, finalize: { exitCode: finalize.exitCode, timedOut: Boolean(finalize.timedOut), error: finalize.error || null } } });
}));

// ==================== Log sentinel: known-noise acks ====================
// POST /api/admin/log-noise/ack { id, text } marks a log-error fingerprint
// (scripts/log-sentinel.js) as known noise: counted and listed on
// /admin/status, never coloured. DELETE /api/admin/log-noise/ack/:id undoes
// it. A ruling-style write to logs/log-sentinel/known.json, outside the DB.
const LOG_NOISE_DIR = path.join(__dirname, '../../logs/log-sentinel');
const LOG_NOISE_ID_RE = /^[0-9a-f]{10}$/;

/** logs/log-sentinel/known.json (app.locals.logSentinelDir overrides the directory for tests). */
function logNoiseAckFile(req) {
    return path.join((req.app && req.app.locals && req.app.locals.logSentinelDir) || LOG_NOISE_DIR, 'known.json');
}

async function updateLogNoiseAcks(file, mutate) {
    let all = {};
    try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) all = raw;
    } catch (_) { /* first ack, or corrupt: start over */ }
    mutate(all);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(all, null, 2));
    await fs.rename(tmp, file);
    return all;
}

router.post('/log-noise/ack', requireAdmin, asyncHandler(async (req, res) => {
    const { id, text } = req.body || {};
    if (typeof id !== 'string' || !LOG_NOISE_ID_RE.test(id)) {
        throw new APIError('id must be a 10-character hex fingerprint id', 400);
    }
    const record = { text: String(text || '').slice(0, 200), ackedAt: new Date().toISOString(), by: req.adminVia || 'session' };
    await updateLogNoiseAcks(logNoiseAckFile(req), all => { all[id] = record; });
    logInfo(`Log noise acknowledged: ${id} (${record.by})${record.text ? ` ${record.text}` : ''}`);
    res.json({ success: true, data: { id, ...record } });
}));

// POST /api/admin/warnings/clear - the "Clear all warnings" button. Acknowledges
// every open health alert AND marks every log-error shape the sentinel currently
// flags as new as seen (logs/log-sentinel/known.json, via 'clear-all'), then
// re-runs the sentinel once so /admin/status turns green now instead of at its
// next 10-minute pass. Known shapes are still spike-checked. Never touches the DB.
router.post('/warnings/clear', requireAdmin, asyncHandler(async (req, res) => {
    const by = req.adminVia || 'session';
    const healthCheckService = req.app.locals.healthCheckService;
    const alerts = healthCheckService ? await healthCheckService.acknowledgeAlerts(null) : { acknowledged: 0 };

    const sentinelDir = (req.app.locals.logSentinelDir) || LOG_NOISE_DIR;
    let latest = null;
    try { latest = JSON.parse(await fs.readFile(path.join(sentinelDir, 'latest.json'), 'utf8')); } catch (_) { /* sentinel has not run yet */ }
    const fresh = ((latest && latest.fingerprints) || []).filter(f => f.new && LOG_NOISE_ID_RE.test(String(f.id || '')));
    if (fresh.length) {
        const ackedAt = new Date().toISOString();
        await updateLogNoiseAcks(path.join(sentinelDir, 'known.json'), all => {
            for (const f of fresh) all[f.id] = { text: String(f.fingerprint || '').slice(0, 200), ackedAt, by, via: 'clear-all' };
        });
    }

    let sentinel = null;
    try {
        const { main } = require('../../scripts/log-sentinel');
        const args = ['node', 'log-sentinel', '--once', '--quiet', '--out', sentinelDir];
        if (req.app.locals.logSentinelLogDir) args.push('--dir', req.app.locals.logSentinelLogDir);
        await main(args);
        const after = JSON.parse(await fs.readFile(path.join(sentinelDir, 'latest.json'), 'utf8'));
        sentinel = after.summary ? { status: after.summary.status, summary: after.summary.summary } : null;
    } catch (error) {
        sentinel = { status: 'unknown', summary: `sentinel re-run failed: ${error.message}` };
    }

    logInfo(`All warnings cleared by ${by}: ${alerts.acknowledged} alert(s), ${fresh.length} log shape(s)`);
    res.json({ success: true, data: { alertsAcknowledged: alerts.acknowledged, logShapesAcknowledged: fresh.length, logShapes: fresh.map(f => f.id), sentinel } });
}));

router.delete('/log-noise/ack/:id', requireAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!LOG_NOISE_ID_RE.test(String(id || ''))) {
        throw new APIError('id must be a 10-character hex fingerprint id', 400);
    }
    let existed = false;
    await updateLogNoiseAcks(logNoiseAckFile(req), all => { existed = Boolean(all[id]); delete all[id]; });
    logInfo(`Log noise un-acknowledged: ${id} (${req.adminVia || 'session'})${existed ? '' : ' - was not acked'}`);
    res.json({ success: true, data: { id, removed: existed } });
}));

// ==================== Weekly Recaps ====================
// Persona-style owner recaps generated under recaps/{season}/ by the /recap
// pipeline (scripts/weekly-recap-run.js, started from the Generate button here).
// Writes: the per-week themes list, the Gmail-draft action, and the two spawns.

const recapFiles = require('../utils/recapFiles');
const recapThemes = require('../utils/recapThemes');
const recapRatings = require('../utils/recapRatings');
const { createGmailDraft } = require('../../scripts/lib/gmailDraft');
const { spawn } = require('child_process');
const { envWithClaude } = require('../../scripts/lib/claudeHeadless');
const { STATUS_DIR: JOB_STATUS_DIR } = require('../../scripts/lib/jobStatus');
const RECAPS_ROOT = path.join(__dirname, '../../recaps');
const SCRIPTS_ROOT = path.join(__dirname, '../../scripts');

/** Fire-and-forget a repo script (its own job status file reports progress). */
function spawnScript(script, args, label) {
    const logFile = path.join(__dirname, '../../logs', `${script.replace(/\.js$/, '')}-admin.log`);
    const fsSync = require('fs');
    const out = fsSync.openSync(logFile, 'a');
    const child = spawn(process.execPath, [path.join(SCRIPTS_ROOT, script), ...args], {
        cwd: path.join(__dirname, '../..'), detached: true, stdio: ['ignore', out, out],
        env: { ...envWithClaude(), STATFINK_TRIGGER: 'admin' }
    });
    child.unref();
    logInfo(`${label}: spawned ${script} ${args.join(' ')} (pid ${child.pid}, log ${path.relative(path.join(__dirname, '../..'), logFile)})`);
    return { pid: child.pid, log: path.relative(path.join(__dirname, '../..'), logFile) };
}

/** Test seams: app.locals.recapsEnv = { root, statusDir, spawnScript } (unit tests never touch recaps/ or logs/). */
function recapsEnv(req) {
    const env = (req && req.app && req.app.locals && req.app.locals.recapsEnv) || {};
    return {
        root: env.root || RECAPS_ROOT,
        statusDir: env.statusDir || JOB_STATUS_DIR,
        spawnScript: env.spawnScript || spawnScript
    };
}

async function readJobStatusFile(job, statusDir = JOB_STATUS_DIR) {
    try { return JSON.parse(await fs.readFile(path.join(statusDir, `${job}.json`), 'utf8')); } catch (_) { return null; }
}

const RECAP_RUN_ACTIVE_MS = 45 * 60 * 1000;
const RECAP_REGEN_ACTIVE_MS = 30 * 60 * 1000;

function pidAlive(pid) {
    if (!pid) return true; // not recorded yet (the route wrote the status, the script has not) - assume alive
    try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** A single-recap regeneration that is genuinely still running (fresh and its process alive), or null. */
function activeRegeneration(regen) {
    if (!regen || regen.status !== 'running') return null;
    if (Date.now() - Date.parse(regen.ts) > RECAP_REGEN_ACTIVE_MS) return null;
    if (!pidAlive(regen.details && regen.details.pid)) return null;
    return regen;
}

/** Why a new recap generation cannot start now (a weekly run or a single-recap rewrite is in flight), or null. */
async function activeRecapGeneration(env) {
    let latest = null;
    try { latest = JSON.parse(await fs.readFile(path.join(__dirname, '../../logs/weekly-recaps-latest.json'), 'utf8')); } catch (_) { /* none */ }
    if (latest && latest.overallStatus === 'RUNNING' && Date.now() - Date.parse(latest.runAt) < RECAP_RUN_ACTIVE_MS) return 'A recap run is already in progress';
    const regen = activeRegeneration(await readJobStatusFile('recap-regenerate', env.statusDir));
    if (regen) return `Already rewriting ${regen.details && regen.details.styleName ? regen.details.styleName : 'a recap'} for ${regen.season} week ${regen.week} - wait for it to finish`;
    return null;
}

/** Themes doc + what the Generate button needs to know. */
async function themesView(season, week) {
    const doc = recapThemes.readThemes(season, week);
    let validation = null;
    try {
        const v = JSON.parse(await fs.readFile(path.join(__dirname, '../../logs/weekly-validation-latest.json'), 'utf8'));
        if (Number(v.season) === season && Number(v.week) === week) validation = { overallStatus: v.overallStatus, runAt: v.runAt };
    } catch (_) { /* none */ }
    let files = [];
    try { files = await fs.readdir(path.join(RECAPS_ROOT, String(season))); } catch (_) { /* none */ }
    const existingSlugs = new Set(files.map(f => recapFiles.parseRecapFilename(f)).filter(p => p && p.week === week).map(p => p.slug));
    const factcheck = await readFactcheck(season, week);
    const ratings = recapRatings.readRatings(season, week);
    return {
        season, week,
        themes: doc ? doc.themes.map(t => ({ ...t, generated: existingSlugs.has(t.slug), factcheck: factcheck && factcheck[t.slug] ? factcheck[t.slug].verdict : null, rating: recapRatings.ratingFor(ratings, t.slug) })) : [],
        ratings: ratings ? { ratedAt: ratings.ratedAt, ratedBy: ratings.ratedBy, recommended: ratings.recommended } : null,
        proposedAt: doc ? doc.proposedAt : null,
        generatedAt: doc ? doc.generatedAt : null,
        lastRun: doc ? doc.lastRun || null : null,
        exists: !!doc,
        recapCount: existingSlugs.size,
        validation,
        canGenerate: !!validation && ['PASS', 'WARN'].includes(validation.overallStatus)
    };
}

function recapWeekParams(req) {
    const { season, week } = req.params;
    if (!recapFiles.isValidSeason(season) || !recapFiles.isValidWeek(week)) {
        throw new APIError('Invalid season or week', 400);
    }
    return { season: parseInt(season), week: parseInt(week) };
}

async function readFactcheck(season, week) {
    const file = path.join(RECAPS_ROOT, String(season), 'data', `week${recapFiles.weekPad(week)}-factcheck.md`);
    try {
        return recapFiles.parseFactcheckReport(await fs.readFile(file, 'utf8'));
    } catch (error) {
        return null; // no fact-check report for this week
    }
}

// Inventory of all generated recaps + the latest scheduled run's status
// (written by scripts/weekly-recap-run.js).
router.get('/recaps', requireAdmin, asyncHandler(async (req, res) => {
    let latestRun = null;
    try {
        latestRun = JSON.parse(await fs.readFile(path.join(__dirname, '../../logs/weekly-recaps-latest.json'), 'utf8'));
    } catch (error) {
        // No scheduled run yet
    }

    const seasons = [];
    let seasonDirs = [];
    try {
        seasonDirs = (await fs.readdir(RECAPS_ROOT)).filter(d => /^\d{4}$/.test(d)).sort().reverse();
    } catch (error) {
        // recaps/ missing entirely
    }
    for (const seasonDir of seasonDirs) {
        let files = [];
        try {
            files = await fs.readdir(path.join(RECAPS_ROOT, seasonDir));
        } catch (error) {
            continue;
        }
        const weekCounts = new Map();
        for (const f of files) {
            const parsed = recapFiles.parseRecapFilename(f);
            if (parsed) weekCounts.set(parsed.week, (weekCounts.get(parsed.week) || 0) + 1);
        }
        let dataFiles = [];
        try {
            dataFiles = await fs.readdir(path.join(RECAPS_ROOT, seasonDir, 'data'));
        } catch (error) { /* no data dir */ }
        const factchecked = new Set(
            dataFiles.map(f => (/^week(\d{2})-factcheck\.md$/.exec(f) || [])[1])
                .filter(Boolean).map(Number)
        );
        seasons.push({
            season: parseInt(seasonDir),
            weeks: [...weekCounts.entries()]
                .sort((a, b) => b[0] - a[0])
                .map(([week, count]) => ({ week, count, hasFactcheck: factchecked.has(week) }))
        });
    }

    // The newest themes file (the week waiting for review), plus the setup job's last word
    let themes = null;
    for (const seasonDir of seasonDirs) {
        const docs = recapThemes.listThemeWeeks(parseInt(seasonDir));
        if (docs.length) { themes = await themesView(docs[0].season, docs[0].week); break; }
    }
    const setup = await readJobStatusFile('recap-setup');
    const generating = latestRun && latestRun.overallStatus === 'RUNNING';

    res.json({ success: true, data: { latestRun, seasons, themes, setup, generating } });
}));

// ---- Themes: the reviewed list the recaps are generated from ----
router.get('/recaps/:season/:week/themes', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    res.json({ success: true, data: await themesView(season, week) });
}));

router.post('/recaps/:season/:week/themes', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    const doc = recapThemes.readThemes(season, week) || { season, week, proposedAt: null, proposedBy: 'manual', generatedAt: null, themes: [] };
    let theme;
    try { theme = recapThemes.addTheme(doc, req.body || {}, 'commissioner'); } catch (error) { throw new APIError(error.message, 400); }
    recapThemes.writeThemes(doc);
    logInfo(`Recap theme added for ${season} week ${week}: ${theme.slug}`);
    res.json({ success: true, data: { added: theme, ...(await themesView(season, week)) } });
}));

router.delete('/recaps/:season/:week/themes/:slug', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    if (!recapFiles.isValidSlug(req.params.slug)) throw new APIError('Invalid theme slug', 400);
    const doc = recapThemes.readThemes(season, week);
    if (!doc) throw new APIError('No themes for that week', 404);
    try { recapThemes.removeTheme(doc, req.params.slug); } catch (error) { throw new APIError(error.message, 404); }
    recapThemes.writeThemes(doc);
    logInfo(`Recap theme removed for ${season} week ${week}: ${req.params.slug}`);
    res.json({ success: true, data: await themesView(season, week) });
}));

// Ask claude for (more) suggestions now - the setup job does this on its own once the week is final.
router.post('/recaps/:season/:week/themes/propose', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    const setup = await readJobStatusFile('recap-setup');
    if (setup && setup.status === 'running' && Date.now() - Date.parse(setup.ts) < 10 * 60 * 1000) throw new APIError('Theme proposal already running', 409);
    const spawned = spawnScript('recap-setup.js', ['--season', String(season), '--week', String(week), '--force'], 'Recap themes');
    res.json({ success: true, data: { ...spawned, message: 'Proposing themes - refresh in a minute' } });
}));

// Generate the recaps from the reviewed theme list (headless /recap, ~10-30 min).
router.post('/recaps/:season/:week/generate', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    const view = await themesView(season, week);
    if (!view.themes.length) throw new APIError('No themes on the list - add at least one first', 400);
    if (!view.canGenerate) throw new APIError(`Week ${week} has no PASS/WARN validation yet - run the daily validation first`, 409);
    const busyReason = await activeRecapGeneration(recapsEnv(req));
    if (busyReason) throw new APIError(busyReason, 409);
    const args = ['--season', String(season), '--week', String(week)];
    if (req.body && req.body.regenerate) args.push('--force-regenerate');
    const spawned = spawnScript('weekly-recap-run.js', args, 'Recap generation');
    res.json({ success: true, data: { ...spawned, themes: view.themes.length, message: `Generating ${view.themes.length} recap(s) - this takes 10-30 minutes` } });
}));

// One week's recaps: style list with fact-check verdicts.
router.get('/recaps/:season/:week', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    let files = [];
    try {
        files = await fs.readdir(path.join(RECAPS_ROOT, String(season)));
    } catch (error) {
        throw new APIError('Season not found', 404);
    }
    const factcheck = await readFactcheck(season, week);
    const ratings = recapRatings.readRatings(season, week);
    const styles = files
        .map(f => recapFiles.parseRecapFilename(f))
        .filter(p => p && p.week === week)
        .map(p => ({
            slug: p.slug,
            styleName: recapFiles.slugToDisplayName(p.slug),
            file: recapFiles.recapFilename(season, week, p.slug),
            factcheck: factcheck ? (factcheck[p.slug]?.verdict || null) : null,
            rating: recapRatings.ratingFor(ratings, p.slug)
        }))
        // Recommended first, then by stars, then by name
        .sort((a, b) => (b.rating?.recommended ? 1 : 0) - (a.rating?.recommended ? 1 : 0) || (b.rating?.stars || 0) - (a.rating?.stars || 0) || a.slug.localeCompare(b.slug));
    if (!styles.length) throw new APIError('No recaps for that week', 404);
    res.json({ success: true, data: { season, week, hasFactcheck: !!factcheck, ratings: ratings ? { ratedAt: ratings.ratedAt, ratedBy: ratings.ratedBy, recommended: ratings.recommended } : null, styles } });
}));

// Rate (or re-rate) the week's recaps on storytelling + interest and pick the recommended one.
router.post('/recaps/:season/:week/rate', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    let files = [];
    try { files = await fs.readdir(path.join(RECAPS_ROOT, String(season))); } catch (_) { /* none */ }
    const count = files.map(f => recapFiles.parseRecapFilename(f)).filter(p => p && p.week === week).length;
    if (count < 2) throw new APIError(`Only ${count} recap(s) for ${season} week ${week} - nothing to compare`, 400);
    const spawned = spawnScript('recap-rate.js', ['--season', String(season), '--week', String(week)], 'Recap ratings');
    res.json({ success: true, data: { ...spawned, message: `Rating ${count} recaps - about two minutes` } });
}));

function resolveRecapPath(season, week, slug, root = RECAPS_ROOT) {
    if (!recapFiles.isValidSlug(slug)) throw new APIError('Invalid style slug', 400);
    const file = path.resolve(root, String(season), recapFiles.recapFilename(season, week, slug));
    if (!file.startsWith(path.resolve(root) + path.sep)) {
        throw new APIError('Invalid path', 400);
    }
    return file;
}

// One recap's markdown content.
router.get('/recaps/:season/:week/:slug', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    const file = resolveRecapPath(season, week, req.params.slug);
    let markdown;
    try {
        markdown = await fs.readFile(file, 'utf8');
    } catch (error) {
        throw new APIError('Recap not found', 404);
    }
    let factcheck = null;
    try {
        const report = await fs.readFile(path.join(RECAPS_ROOT, String(season), 'data', `week${recapFiles.weekPad(week)}-factcheck.md`), 'utf8');
        factcheck = recapFiles.factcheckSection(report, req.params.slug);
    } catch (_) { /* no fact-check report for this week */ }
    const rating = recapRatings.ratingFor(recapRatings.readRatings(season, week), req.params.slug);
    res.json({ success: true, data: { season, week, slug: req.params.slug, markdown, factcheck, rating } });
}));

// Rewrite ONE recap from the commissioner's feedback ("Give feedback and run
// again" in the reader): scripts/recap-regenerate.js runs the narrator for
// that style alone with the feedback in its prompt, fact-checks the draft,
// and only then swaps it in - the current version stays until the new one is
// ready. One generation at a time (weekly run or rewrite); the running
// status is written here, before the spawn, so a double submit gets a 409.
router.post('/recaps/:season/:week/:slug/regenerate', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    const env = recapsEnv(req);
    const slug = req.params.slug;
    const file = resolveRecapPath(season, week, slug, env.root);
    let feedback;
    try { feedback = recapFiles.normaliseFeedback(req.body ? req.body.feedback : undefined); } catch (error) { throw new APIError(error.message, 400); }
    try { await fs.access(file); } catch (_) { throw new APIError('Recap not found', 404); }
    const busyReason = await activeRecapGeneration(env);
    if (busyReason) throw new APIError(busyReason, 409);

    const themesDoc = recapThemes.readThemes(season, week, env.root);
    const theme = themesDoc && themesDoc.themes.find(t => t.slug === slug);
    const styleName = theme ? theme.name : recapFiles.slugToDisplayName(slug);
    await writeJobStatusTo(env.statusDir, 'recap-regenerate', { status: 'running', summary: `rewriting ${styleName} for ${season} week ${week} from your feedback`, season, week, link: '/admin/recaps',
        details: { slug, styleName, feedback, pid: null, startedAt: new Date().toISOString(), by: req.adminVia || 'session' } });
    const spawned = env.spawnScript('recap-regenerate.js', ['--season', String(season), '--week', String(week), '--slug', slug, '--feedback', feedback], 'Recap regeneration');
    logInfo(`Recap regeneration requested for ${season} week ${week} ${slug} (${req.adminVia || 'session'}): ${feedback.slice(0, 160).replace(/\n/g, ' ')}`);
    res.json({ success: true, data: { ...spawned, season, week, slug, styleName, message: `Rewriting ${styleName} from your feedback - about five minutes. The current version stays until the new one is ready.` } });
}));

/** Same record shape (and atomic write) as scripts/lib/jobStatus.writeJobStatus, into `dir` (the test seam); no history line - the script writes the final one. */
async function writeJobStatusTo(dir, job, { status, summary = '', season = null, week = null, details = null, link = null }) {
    await fs.mkdir(dir, { recursive: true });
    const record = { job, ts: new Date().toISOString(), status, summary: String(summary).slice(0, 500), season, week, durationMs: null, link, details: details || {} };
    const file = path.join(dir, `${job}.json`);
    await fs.writeFile(`${file}.${process.pid}.tmp`, JSON.stringify(record, null, 2));
    await fs.rename(`${file}.${process.pid}.tmp`, file);
    return record;
}

// Progress of the single-recap rewrite for this recap: { regeneration: {status, ts, summary, details} | null, active }.
// `regeneration` is null when the last rewrite was some other recap's; `active` says whether ANY rewrite is running.
router.get('/recaps/:season/:week/:slug/regenerate', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    const env = recapsEnv(req);
    const slug = req.params.slug;
    if (!recapFiles.isValidSlug(slug)) throw new APIError('Invalid style slug', 400);
    const regen = await readJobStatusFile('recap-regenerate', env.statusDir);
    const live = activeRegeneration(regen);
    const mine = regen && Number(regen.season) === season && Number(regen.week) === week && regen.details && regen.details.slug === slug;
    let regeneration = null;
    if (mine) {
        // A 'running' record whose process is gone never got its final write: report it as failed, not stuck.
        const status = regen.status === 'running' && !live ? 'critical' : regen.status;
        const summary = status !== regen.status ? `${regen.summary} - the rewrite stopped without reporting (see logs/recap-regenerate-admin.log)` : regen.summary;
        regeneration = { status, ts: regen.ts, summary, details: regen.details || {} };
    }
    res.json({ success: true, data: { season, week, slug, regeneration, active: !!live } });
}));

// Turn the chosen recap into a Gmail draft in the league mailer account.
// No recipients are set - the commissioner adds them in Gmail and sends.
router.post('/recaps/:season/:week/:slug/draft', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    const file = resolveRecapPath(season, week, req.params.slug);
    let markdown;
    try {
        markdown = await fs.readFile(file, 'utf8');
    } catch (error) {
        throw new APIError('Recap not found', 404);
    }

    const styleName = recapFiles.slugToDisplayName(req.params.slug);
    const subject = `PFL ${season} Week ${week} Recap — ${styleName}`;
    try {
        const draft = await createGmailDraft({
            subject,
            text: markdown,
            html: recapFiles.markdownToHtml(markdown)
        });
        logInfo(`Gmail draft created for ${season} week ${week} ${req.params.slug} (draft ${draft.draftId})`);
        res.json({ success: true, data: { ...draft, subject } });
    } catch (error) {
        const scopeProblem = /insufficient|scope|invalid_grant|forbidden/i.test(error.message);
        throw new APIError(
            scopeProblem
                ? `Gmail refused (${error.message}). The token likely lacks the gmail.compose scope - run: node roster_moves/authSetup.js`
                : `Failed to create Gmail draft: ${error.message}`,
            502
        );
    }
}));

module.exports = router;// ---- Podcast (/admin/podcast): The PFL Cast outlines for Jellypod ----
// Hosts live in podcast/hosts.json; scripts/podcast-outlines.js writes five
// outlines + Claude's favorite to podcast/{season}/data/week{NN}-episode.json.
const podcastStore = require('../utils/podcastStore');
const PODCAST_ACTIVE_MS = 40 * 60 * 1000;

/** Test seam: app.locals.podcastEnv = { root, recapsRoot, statusDir, validationFile, spawnScript }. */
function podcastEnv(req) {
    const env = (req && req.app && req.app.locals && req.app.locals.podcastEnv) || {};
    return {
        root: env.root || podcastStore.DEFAULT_ROOT,
        recapsRoot: env.recapsRoot || RECAPS_ROOT,
        statusDir: env.statusDir || JOB_STATUS_DIR,
        validationFile: env.validationFile || path.join(__dirname, '../../logs/weekly-validation-latest.json'),
        spawnScript: env.spawnScript || spawnScript
    };
}

/** The outline run that is genuinely still going (fresh, process alive), or null. */
async function activePodcastRun(env) {
    const st = await readJobStatusFile('podcast-outlines', env.statusDir);
    if (!st || st.status !== 'running') return null;
    if (Date.now() - Date.parse(st.ts) > PODCAST_ACTIVE_MS) return null;
    if (!pidAlive(st.details && st.details.pid)) return null;
    return st;
}

async function readValidation(env) {
    try { return JSON.parse(await fs.readFile(env.validationFile, 'utf8')); } catch (_) { return null; }
}

/** Weeks that have a recap digest on disk: Set of "season-week". */
async function digestWeeks(env) {
    const out = new Set();
    for (const root of [env.recapsRoot, env.root]) {
        let seasons = [];
        try { seasons = (await fs.readdir(root)).filter(d => /^\d{4}$/.test(d)); } catch (_) { continue; }
        for (const s of seasons) {
            let files = [];
            try { files = await fs.readdir(path.join(root, s, 'data')); } catch (_) { continue; }
            for (const f of files) { const m = /^week(\d{2})-digest\.md$/.exec(f); if (m) out.add(`${s}-${Number(m[1])}`); }
        }
    }
    return out;
}

/** Why outlines cannot be generated for this week, or null. */
async function podcastGate(env, season, week) {
    if ((await digestWeeks(env)).has(`${season}-${week}`)) return null;
    const v = await readValidation(env);
    if (v && Number(v.season) === season && Number(v.week) === week && ['PASS', 'WARN'].includes(v.overallStatus)) return null;
    return `Week ${week} is not validated yet - outlines need the 13:00 UTC daily validation to pass first`;
}

router.get('/podcast', requireAdmin, asyncHandler(async (req, res) => {
    const env = podcastEnv(req);
    const { hosts, updatedAt } = podcastStore.readHosts(env.root);
    const keys = new Map();
    for (const e of podcastStore.listEpisodeWeeks(env.root)) keys.set(`${e.season}-${e.week}`, { ...e, hasEpisode: true });
    for (const k of await digestWeeks(env)) {
        const [season, week] = k.split('-').map(Number);
        if (!keys.has(k)) keys.set(k, { season, week, hasEpisode: false });
    }
    const v = await readValidation(env);
    if (v && v.season && v.week && ['PASS', 'WARN'].includes(v.overallStatus)) {
        const k = `${Number(v.season)}-${Number(v.week)}`;
        if (!keys.has(k)) keys.set(k, { season: Number(v.season), week: Number(v.week), hasEpisode: false });
    }
    const weeks = [...keys.values()].sort((a, b) => b.season - a.season || b.week - a.week);
    const run = await activePodcastRun(env);
    res.json({ success: true, data: { hosts, hostsUpdatedAt: updatedAt, maxHosts: podcastStore.MAX_HOSTS, weeks, running: run ? { season: run.season, week: run.week, summary: run.summary, since: run.ts } : null } });
}));

router.put('/podcast/hosts', requireAdmin, asyncHandler(async (req, res) => {
    const env = podcastEnv(req);
    let doc;
    try { doc = podcastStore.writeHosts(req.body ? req.body.hosts : null, env.root); } catch (error) { throw new APIError(error.message, 400); }
    logInfo(`Podcast hosts saved: ${doc.hosts.map(h => `${h.name} (${h.role})`).join(', ')}`);
    res.json({ success: true, data: doc });
}));

router.get('/podcast/:season/:week', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    const env = podcastEnv(req);
    const episode = podcastStore.readEpisode(season, week, env.root);
    const run = await activePodcastRun(env);
    const runningHere = !!(run && Number(run.season) === season && Number(run.week) === week);
    if (episode && episode.status === 'running' && !runningHere) {
        episode.status = 'failed';
        episode.error = episode.error || 'The run stopped without reporting (see logs/podcast-outlines-admin.log)';
    }
    res.json({ success: true, data: { season, week, episode, running: runningHere, busy: !!run, gate: await podcastGate(env, season, week) } });
}));

// Ready-to-send emails about the show (podcast/emails/*.md), for Copy for Gmail.
router.get('/podcast/emails', requireAdmin, asyncHandler(async (req, res) => {
    res.json({ success: true, data: { emails: podcastStore.listEmails(podcastEnv(req).root) } });
}));

// Mark the outline Joe is using (the one that airs); next week's run builds on it.
router.post('/podcast/:season/:week/choose', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    const env = podcastEnv(req);
    const doc = podcastStore.readEpisode(season, week, env.root);
    if (!doc || !Array.isArray(doc.outlines)) throw new APIError('No outlines for that week', 404);
    const id = req.body && req.body.id;
    if (!doc.outlines.some(o => o.id === id)) throw new APIError('Unknown outline', 400);
    doc.chosen = id;
    doc.chosenAt = new Date().toISOString();
    podcastStore.writeEpisode(doc, env.root);
    logInfo(`Podcast ${season} week ${week}: using ${id}`);
    res.json({ success: true, data: { chosen: id } });
}));

router.post('/podcast/:season/:week/generate', requireAdmin, asyncHandler(async (req, res) => {
    const { season, week } = recapWeekParams(req);
    const env = podcastEnv(req);
    const gate = await podcastGate(env, season, week);
    if (gate) throw new APIError(gate, 409);
    const run = await activePodcastRun(env);
    if (run) throw new APIError(`Already writing outlines for ${run.season} week ${run.week} - wait for it to finish`, 409);
    // Written before the spawn so a double tap gets a 409; the script overwrites it with its pid.
    await writeJobStatusTo(env.statusDir, 'podcast-outlines', { status: 'running', summary: `writing outlines for ${season} week ${week}`, season, week, link: '/admin/podcast', details: { pid: null, by: req.adminVia || 'session' } });
    const spawned = env.spawnScript('podcast-outlines.js', ['--season', String(season), '--week', String(week)], 'Podcast outlines');
    res.json({ success: true, data: { ...spawned, season, week, message: 'Writing 5 outlines and picking a favorite - about 5 minutes' } });
}));

