const express = require('express');
const { asyncHandler, APIError, logInfo, logError } = require('../utils/errorHandler');
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

// Traffic statistics endpoints
router.get('/traffic/stats', requireAdmin, asyncHandler(async (req, res) => {
    const trafficTracker = req.app.locals.trafficTracker;
    const { days = 30 } = req.query;
    
    if (!trafficTracker) {
        throw new APIError('Traffic tracking not available', 500);
    }
    
    const stats = await trafficTracker.getStats(parseInt(days));
    
    res.json({
        success: true,
        data: stats
    });
}));

router.get('/traffic/realtime', requireAdmin, asyncHandler(async (req, res) => {
    const trafficTracker = req.app.locals.trafficTracker;
    
    if (!trafficTracker) {
        throw new APIError('Traffic tracking not available', 500);
    }
    
    const activeVisitors = await trafficTracker.getRealTimeCount();
    
    res.json({
        success: true,
        data: {
            activeVisitors,
            timestamp: new Date().toISOString()
        }
    });
}));

router.post('/traffic/cleanup', requireAdmin, asyncHandler(async (req, res) => {
    const trafficTracker = req.app.locals.trafficTracker;
    
    if (!trafficTracker) {
        throw new APIError('Traffic tracking not available', 500);
    }
    
    await trafficTracker.cleanup();
    
    res.json({
        success: true,
        message: 'Traffic data older than 90 days has been cleaned up'
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
        
        // Check if all games are complete for defensive bonus calculation
        const gamesComplete = await nflGamesService.areAllWeekGamesComplete(currentWeek, currentSeason);
        logInfo(`Games complete check for Week ${currentWeek}: ${JSON.stringify(gamesComplete)}`);
        
        if (gamesComplete.isComplete) {
            logInfo('All games complete - processing defensive scoring...');
            
            // Step 1: Calculate defensive bonuses (5 pts for fewest points/yards allowed)
            const scoringService = req.app.locals.scoringService;
            if (scoringService) {
                const bonusResult = await scoringService.calculateDefensiveBonuses(
                    currentWeek,
                    currentSeason
                );
                
                if (bonusResult.success) {
                    logInfo(`✓ Defensive bonuses calculated for ${bonusResult.teamsProcessed} DST teams`);
                    
                    // Step 2: Recalculate ALL DST fantasy points (includes TDs + bonuses)
                    const fantasyPointsService = req.app.locals.fantasyPointsCalculationService;
                    if (fantasyPointsService) {
                        const dstResult = await fantasyPointsService.calculateEndOfWeekDSTBonuses(
                            currentSeason
                        );
                        logInfo(`✓ DST fantasy points updated for ${dstResult.updated} teams`);
                        
                        // Log some examples to verify
                        const sample = await db.all(`
                            SELECT player_id, def_int_return_tds, def_fumble_return_tds, 
                                   def_points_bonus, def_yards_bonus, fantasy_points
                            FROM player_stats 
                            WHERE week = ? AND player_id LIKE 'DEF_%' 
                            AND (def_int_return_tds > 0 OR def_fumble_return_tds > 0 
                                 OR def_points_bonus > 0 OR def_yards_bonus > 0)
                            LIMIT 3
                        `, [currentWeek]);
                        
                        sample.forEach(dst => {
                            logInfo(`  ${dst.player_id}: ${dst.fantasy_points} pts ` +
                                   `(TDs: ${dst.def_int_return_tds}/${dst.def_fumble_return_tds}, ` +
                                   `Bonuses: ${dst.def_points_bonus}/${dst.def_yards_bonus})`);
                        });
                    }
                    
                    // Step 3: Recalculate scoring players now that DSTs have points
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
        }
        
        // Recalculate team scores after updating player stats and DST bonuses
        let teamScoresUpdated = false;
        let teamsUpdated = 0;
        try {
            const teamScoreService = req.app.locals.teamScoreService;
            if (teamScoreService) {
                logInfo('Recalculating team scores after player stats update...');
                const teamScoreResult = await teamScoreService.recalculateTeamScores(currentWeek, currentSeason);
                teamScoresUpdated = teamScoreResult.success;
                teamsUpdated = teamScoreResult.teamsUpdated || 0;
                logInfo(`Team scores recalculated: ${teamsUpdated} teams updated`);
            }
        } catch (teamScoreError) {
            logError('Failed to recalculate team scores:', teamScoreError);
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

    if (isNaN(seasonNum) || seasonNum < 2024 || seasonNum > 2025) {
        return res.status(400).json({
            success: false,
            message: 'Invalid season. Must be 2024 or 2025'
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

module.exports = router;