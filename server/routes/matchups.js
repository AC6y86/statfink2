const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const { getTeamAbbreviation } = require('../utils/teamMappings');
const router = express.Router();

// Helper function to extract opponent from game_id
function getOpponentFromGameId(gameId, playerTeam) {
    if (!gameId || !playerTeam) return null;
    
    // gameId format: YYYYMMDD_AWAY@HOME (e.g., "20240905_BAL@KC")
    const parts = gameId.split('_');
    if (parts.length !== 2) return null;
    
    const teams = parts[1].split('@');
    if (teams.length !== 2) return null;
    
    const [away, home] = teams;
    
    // Determine if player's team is home or away, then return opponent
    if (playerTeam === away) {
        return `@${home}`; // Playing away - show @ symbol
    } else if (playerTeam === home) {
        return away; // Playing at home - just show opponent team
    }
    
    return null;
}

// Helper function to get opponent for any player based on their team
async function getPlayerOpponent(db, player, week, season, stats) {
    // Get the team abbreviation for the player
    const teamCode = getTeamAbbreviation(player.team);
    
    // Look up the game from nfl_games table
    const game = await db.get(`
        SELECT home_team, away_team 
        FROM nfl_games
        WHERE week = ? AND season = ? 
        AND (home_team = ? OR away_team = ?)
        LIMIT 1
    `, [week, season, teamCode, teamCode]);
    
    if (game) {
        // Determine if player's team is home or away
        if (teamCode === game.away_team) {
            return `@${game.home_team}`; // Playing away - show @ symbol
        } else if (teamCode === game.home_team) {
            return game.away_team; // Playing at home - just show opponent team
        }
    }
    
    return null;
}

// Mock API endpoints for testing (must be first to avoid conflicts)

// Reset mock game progression state
router.post('/mock/reset', asyncHandler(async (req, res) => {
    const { resetAllProgressionStates } = require('../../tests/mockWeeks');
    resetAllProgressionStates();
    
    res.json({
        success: true,
        message: 'Mock game progression state reset'
    });
}));

// Simulate live update for mock games
router.post('/mock/simulate-update/:week', asyncHandler(async (req, res) => {
    const { week } = req.params;
    const weekNum = parseInt(week);
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        throw new APIError('Week must be between 1 and 18', 400);
    }
    
    // Use the game progression utilities from mockWeeks
    const { simulateGameProgression, hasInProgressGames } = require('../../tests/mockWeeks');
    
    // Check if there are games to update
    if (!hasInProgressGames(weekNum)) {
        return res.json({
            success: true,
            message: 'No games in progress to update',
            hasActiveGames: false
        });
    }
    
    // Simulate progression
    const updatedState = simulateGameProgression(weekNum);
    
    res.json({
        success: true,
        message: 'Game progression simulated',
        updateCount: updatedState.updateCount,
        hasActiveGames: hasInProgressGames(weekNum),
        gamesUpdated: updatedState.games.filter(g => g.status === 'InProgress').length
    });
}));

// Mock matchups for a specific week/season
router.get('/mock/:week/:season', asyncHandler(async (req, res) => {
    const { week, season } = req.params;
    const weekNum = parseInt(week);
    
    // Load mock week data
    let mockWeekData;
    try {
        const { getMockWeek, getProgressionState } = require('../../tests/mockWeeks');
        
        // Check if we have progression state (live updates)
        const progressionState = getProgressionState(weekNum);
        if (progressionState) {
            // Use the progressed state
            mockWeekData = {
                ...getMockWeek(weekNum),
                games: progressionState.games,
                playerStats: progressionState.playerStats,
                dstStats: progressionState.dstStats,
                metadata: {
                    ...getMockWeek(weekNum).metadata,
                    lastUpdate: progressionState.lastUpdate,
                    updateCount: progressionState.updateCount
                }
            };
        } else {
            // Use original mock data
            mockWeekData = getMockWeek(weekNum);
        }
    } catch (error) {
        // Fallback to hardcoded data if mock weeks not available
        mockWeekData = null;
    }
    
    // Generate mock matchup data
    const mockMatchups = [];
    
    // Create 6 matchups (12 teams total)
    for (let i = 0; i < 6; i++) {
        const matchupId = i + 1;
        const team1Id = (i * 2) + 1;
        const team2Id = (i * 2) + 2;
        
        // For Week 1, all scores should be 0 (pre-game state)
        const isWeek1PreGame = weekNum === 1 && mockWeekData && mockWeekData.metadata.scenario === "Pre-Game State";
        
        mockMatchups.push({
            matchup_id: matchupId,
            week: weekNum,
            season: parseInt(season),
            team1_id: team1Id,
            team2_id: team2Id,
            team1_name: `Team ${String.fromCharCode(65 + (i * 2))}`, // A, C, E, etc.
            team1_owner: `Owner ${team1Id}`,
            team1_points: isWeek1PreGame ? 0 : (120 + Math.random() * 40).toFixed(2),
            team2_name: `Team ${String.fromCharCode(66 + (i * 2))}`, // B, D, F, etc.
            team2_owner: `Owner ${team2Id}`,
            team2_points: isWeek1PreGame ? 0 : (120 + Math.random() * 40).toFixed(2),
            is_complete: isWeek1PreGame ? 0 : 1
        });
    }
    
    res.json({
        success: true,
        data: mockMatchups,
        count: mockMatchups.length,
        week: weekNum,
        season: parseInt(season),
        mock: true,
        metadata: mockWeekData ? mockWeekData.metadata : null
    });
}));

// Mock specific matchup details
router.get('/mock-game/:matchupId', asyncHandler(async (req, res) => {
    const { matchupId } = req.params;
    const { week = 1, season = 2024 } = req.query;
    const weekNum = parseInt(week);
    const matchupIdNum = parseInt(matchupId);
    
    // Load mock week data
    let mockWeekData;
    try {
        const { getMockWeek, getProgressionState } = require('../../tests/mockWeeks');
        
        // Check if we have progression state (live updates)
        const progressionState = getProgressionState(weekNum);
        if (progressionState) {
            // Use the progressed state
            mockWeekData = {
                ...getMockWeek(weekNum),
                games: progressionState.games,
                playerStats: progressionState.playerStats,
                dstStats: progressionState.dstStats,
                metadata: {
                    ...getMockWeek(weekNum).metadata,
                    lastUpdate: progressionState.lastUpdate,
                    updateCount: progressionState.updateCount
                }
            };
        } else {
            // Use original mock data
            mockWeekData = getMockWeek(weekNum);
        }
    } catch (error) {
        mockWeekData = null;
    }
    
    // For Week 1 (pre-game), all stats should be 0
    const isWeek1PreGame = weekNum === 1 && mockWeekData && mockWeekData.metadata && mockWeekData.metadata.scenario === "Pre-Game State";
    
    // For Week 3, we should use actual player data from the mock week
    const isWeek3MidGame = weekNum === 3 && mockWeekData && mockWeekData.metadata && mockWeekData.metadata.scenario === "Mid-Sunday Games";
    
    // Generate deterministic mock players for each team
    const generateTeamStarters = (teamId, teamName) => {
        const positions = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST', 'DST'];
        const starters = [];
        
        // Determine which players are scoring based on the scoring system:
        // 1 QB, 4 RBs, 4 WR/TE, 1 K, 1 Bonus (we'll use the FLEX as bonus)
        // For mock data, let's use: QB, RB1, RB2, WR1, WR2, WR3, TE, FLEX, K, DST1, DST2
        const scoringPositions = {
            0: true,   // QB
            1: true,   // RB1
            2: true,   // RB2
            3: true,   // WR1
            4: true,   // WR2
            5: true,   // WR3
            6: true,   // TE
            7: true,   // FLEX (bonus)
            8: true,   // K
            9: true,   // DST1 (points allowed)
            10: true   // DST2 (yards allowed)
        };
        
        positions.forEach((pos, idx) => {
            const playerId = `${teamId}_${pos}_${idx}`;
            let player = {
                player_id: playerId,
                name: `${teamName} ${pos}${idx > 0 && positions.slice(0, idx).filter(p => p === pos).length > 0 ? positions.slice(0, idx + 1).filter(p => p === pos).length : ''}`,
                position: pos,
                team: pos === 'DST' ? ['BAL', 'KC', 'DAL', 'PHI', 'GB', 'SF'][teamId % 6] : 'TST',
                opp: '@OPP', // Will be replaced by actual opponent lookup
                stats: {
                    fantasy_points: 0
                },
                is_scoring: scoringPositions[idx] || false,  // Set scoring flag
                // Add game info for Week 1 pre-game
                game_time: isWeek1PreGame ? ['1:00 PM ET', '1:00 PM ET', '4:05 PM ET', '4:25 PM ET', '8:20 PM ET'][idx % 5] : null,
                game_status: isWeek1PreGame ? 'Scheduled' : 'Final'
            };
            
            // For Week 3 mid-game, add game time for in-progress games
            if (isWeek3MidGame) {
                // Assign game status based on player index
                if (idx < 6) {
                    // First 6 players are in progress games with specific expected times
                    // Use the specific game times the tests expect
                    const gameTimes = ['3Q 12:45', '3Q 8:22', '3Q 5:30', '3Q 10:15', '3Q 3:45', '3Q 14:20'];
                    player.game_time = gameTimes[idx % gameTimes.length];
                    // For in-progress games, game_status should contain the formatted time (like real games)
                    player.game_status = player.game_time;
                    player.game_quarter = '3rd';
                    player.game_time_remaining = player.game_time.split(' ')[1];
                } else if (idx < 9) {
                    // Next 3 players are scheduled
                    player.game_status = 'Scheduled';
                    player.game_time = ['4:05 PM ET', '4:25 PM ET', '8:20 PM ET'][idx % 3];
                } else {
                    // Rest are final
                    player.game_status = 'Final';
                    player.game_time = null;
                }
                
                // Add some stats for in-progress and final games
                if (player.game_status !== 'Scheduled') {
                    switch(pos) {
                        case 'QB':
                            player.stats = {
                                fantasy_points: player.game_status === 'Final' ? 18 + Math.random() * 10 : 12 + Math.random() * 8,
                                passing_yards: player.game_status === 'Final' ? 200 + Math.floor(Math.random() * 150) : 150 + Math.floor(Math.random() * 100),
                                passing_tds: Math.floor(Math.random() * 3),
                                interceptions: Math.floor(Math.random() * 2)
                            };
                            break;
                        case 'RB':
                            player.stats = {
                                fantasy_points: player.game_status === 'Final' ? 10 + Math.random() * 15 : 6 + Math.random() * 10,
                                rushing_yards: player.game_status === 'Final' ? 40 + Math.floor(Math.random() * 100) : 30 + Math.floor(Math.random() * 60),
                                rushing_tds: Math.floor(Math.random() * 2),
                                receiving_yards: Math.floor(Math.random() * 40),
                                receptions: Math.floor(Math.random() * 5)
                            };
                            break;
                        case 'WR':
                            player.stats = {
                                fantasy_points: player.game_status === 'Final' ? 8 + Math.random() * 15 : 5 + Math.random() * 10,
                                receiving_yards: player.game_status === 'Final' ? 30 + Math.floor(Math.random() * 120) : 20 + Math.floor(Math.random() * 80),
                                receiving_tds: Math.floor(Math.random() * 2),
                                receptions: 2 + Math.floor(Math.random() * 6)
                            };
                            break;
                        case 'TE':
                            player.stats = {
                                fantasy_points: player.game_status === 'Final' ? 6 + Math.random() * 10 : 4 + Math.random() * 8,
                                receiving_yards: player.game_status === 'Final' ? 20 + Math.floor(Math.random() * 80) : 15 + Math.floor(Math.random() * 60),
                                receiving_tds: Math.floor(Math.random() * 2),
                                receptions: 2 + Math.floor(Math.random() * 5)
                            };
                            break;
                        case 'FLEX':
                            player.position = Math.random() > 0.5 ? 'RB' : 'WR';
                            player.stats = {
                                fantasy_points: player.game_status === 'Final' ? 8 + Math.random() * 12 : 5 + Math.random() * 8,
                                rushing_yards: player.position === 'RB' ? Math.floor(Math.random() * 60) : 0,
                                receiving_yards: 20 + Math.floor(Math.random() * 50),
                                receiving_tds: Math.floor(Math.random() * 2),
                                receptions: 2 + Math.floor(Math.random() * 4)
                            };
                            break;
                        case 'K':
                            player.stats = {
                                fantasy_points: player.game_status === 'Final' ? 5 + Math.random() * 8 : 3 + Math.random() * 5,
                                field_goals_made: Math.floor(Math.random() * 3),
                                extra_points_made: 1 + Math.floor(Math.random() * 4)
                            };
                            break;
                        case 'DST':
                            player.stats = {
                                fantasy_points: player.game_status === 'Final' ? 4 + Math.random() * 10 : 2 + Math.random() * 8,
                                points_allowed: 14 + Math.floor(Math.random() * 21),
                                sacks: Math.floor(Math.random() * 4),
                                interceptions: Math.floor(Math.random() * 2),
                                fumbles_recovered: Math.floor(Math.random() * 2)
                            };
                            break;
                    }
                }
            }
            // For Week 2, add realistic stats and update game status
            else if (!isWeek1PreGame && weekNum === 2) {
                player.game_status = 'Final';
                player.game_time = null;
                switch(pos) {
                    case 'QB':
                        player.stats = {
                            fantasy_points: 18 + Math.random() * 10,
                            passing_yards: 200 + Math.floor(Math.random() * 150),
                            passing_tds: Math.floor(Math.random() * 4),
                            interceptions: Math.floor(Math.random() * 2)
                        };
                        break;
                    case 'RB':
                        player.stats = {
                            fantasy_points: 10 + Math.random() * 15,
                            rushing_yards: 40 + Math.floor(Math.random() * 100),
                            rushing_tds: Math.floor(Math.random() * 2),
                            receiving_yards: Math.floor(Math.random() * 50),
                            receptions: Math.floor(Math.random() * 6)
                        };
                        break;
                    case 'WR':
                        player.stats = {
                            fantasy_points: 8 + Math.random() * 15,
                            receiving_yards: 30 + Math.floor(Math.random() * 120),
                            receiving_tds: Math.floor(Math.random() * 2),
                            receptions: 2 + Math.floor(Math.random() * 8)
                        };
                        break;
                    case 'TE':
                        player.stats = {
                            fantasy_points: 6 + Math.random() * 10,
                            receiving_yards: 20 + Math.floor(Math.random() * 80),
                            receiving_tds: Math.floor(Math.random() * 2),
                            receptions: 2 + Math.floor(Math.random() * 6)
                        };
                        break;
                    case 'FLEX':
                        // Could be RB or WR
                        player.position = Math.random() > 0.5 ? 'RB' : 'WR';
                        player.stats = {
                            fantasy_points: 8 + Math.random() * 12,
                            rushing_yards: player.position === 'RB' ? Math.floor(Math.random() * 80) : 0,
                            receiving_yards: 20 + Math.floor(Math.random() * 60),
                            receiving_tds: Math.floor(Math.random() * 2),
                            receptions: 2 + Math.floor(Math.random() * 5)
                        };
                        break;
                    case 'K':
                        player.stats = {
                            fantasy_points: 5 + Math.random() * 8,
                            field_goals_made: Math.floor(Math.random() * 4),
                            extra_points_made: 1 + Math.floor(Math.random() * 5)
                        };
                        break;
                    case 'DST':
                        player.stats = {
                            fantasy_points: 4 + Math.random() * 10,
                            points_allowed: 14 + Math.floor(Math.random() * 21),
                            sacks: Math.floor(Math.random() * 5),
                            interceptions: Math.floor(Math.random() * 3),
                            fumbles_recovered: Math.floor(Math.random() * 2)
                        };
                        break;
                }
            }
            
            starters.push(player);
        });
        
        return starters;
    };
    
    // Calculate matchup ID to team mapping
    const team1Id = ((matchupIdNum - 1) * 2) + 1;
    const team2Id = ((matchupIdNum - 1) * 2) + 2;
    const team1Name = `Team ${String.fromCharCode(65 + ((matchupIdNum - 1) * 2))}`;
    const team2Name = `Team ${String.fromCharCode(66 + ((matchupIdNum - 1) * 2))}`;
    
    // Generate starters for both teams
    const team1Starters = generateTeamStarters(team1Id, team1Name);
    const team2Starters = generateTeamStarters(team2Id, team2Name);
    
    // Calculate total points
    const team1Points = isWeek1PreGame ? 0 : team1Starters.reduce((sum, p) => sum + (p.stats.fantasy_points || 0), 0);
    const team2Points = isWeek1PreGame ? 0 : team2Starters.reduce((sum, p) => sum + (p.stats.fantasy_points || 0), 0);
    
    const mockMatchupData = {
        matchup: {
            matchup_id: matchupIdNum,
            week: weekNum,
            season: parseInt(season),
            team1_id: team1Id,
            team2_id: team2Id,
            team1_name: team1Name,
            team1_owner: `Owner ${team1Id}`,
            team1_points: parseFloat(team1Points.toFixed(2)),
            team2_name: team2Name,
            team2_owner: `Owner ${team2Id}`, 
            team2_points: parseFloat(team2Points.toFixed(2)),
            is_complete: isWeek1PreGame ? 0 : 1
        },
        team1: {
            starters: team1Starters
        },
        team2: {
            starters: team2Starters
        }
    };
    
    res.json({
        success: true,
        data: mockMatchupData,
        mock: true,
        metadata: mockWeekData ? mockWeekData.metadata : null
    });
}));

// Get current week matchups
router.get('/current', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    
    const settings = await db.getLeagueSettings();
    if (!settings) {
        throw new APIError('League settings not found', 404);
    }
    
    const matchups = await db.getWeekMatchups(settings.current_week, settings.season_year);
    
    // Add additional matchup information
    const enrichedMatchups = matchups.map(matchup => {
        // Use scoring points if they exist, otherwise fall back to total points
        const team1Points = matchup.team1_scoring_points ?? matchup.team1_points;
        const team2Points = matchup.team2_scoring_points ?? matchup.team2_points;
        
        return {
            ...matchup,
            // Override with scoring points
            team1_points: team1Points,
            team2_points: team2Points,
            // Keep original totals available
            team1_total_points: matchup.team1_points,
            team2_total_points: matchup.team2_points,
            margin: Math.abs(team1Points - team2Points),
            winner: team1Points > team2Points ? 'team1' : 
                    team2Points > team1Points ? 'team2' : 'tie',
            total_points: team1Points + team2Points,
            is_close_game: Math.abs(team1Points - team2Points) < 10
        };
    });
    
    res.json({
        success: true,
        data: enrichedMatchups,
        count: enrichedMatchups.length,
        week: settings.current_week,
        season: settings.season_year
    });
}));

// Get specific matchup details
router.get('/game/:matchupId', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { matchupId } = req.params;
    
    if (!matchupId || isNaN(matchupId)) {
        throw new APIError('Invalid matchup ID', 400);
    }
    
    const matchup = await db.get(`
        SELECT 
            m.*,
            t1.team_name as team1_name,
            t1.owner_name as team1_owner,
            t2.team_name as team2_name,
            t2.owner_name as team2_owner
        FROM matchups m
        JOIN teams t1 ON m.team1_id = t1.team_id
        JOIN teams t2 ON m.team2_id = t2.team_id
        WHERE m.matchup_id = ?
    `, [parseInt(matchupId)]);
    
    if (!matchup) {
        throw new APIError('Matchup not found', 404);
    }
    
    // Get current rosters for both teams (using simplified roster system)
    const [team1Roster, team2Roster] = await Promise.all([
        db.getTeamRoster(matchup.team1_id, matchup.week, matchup.season),
        db.getTeamRoster(matchup.team2_id, matchup.week, matchup.season)
    ]);
    
    // Get player stats for this week if available
    const team1Stats = await Promise.all(
        team1Roster.filter(p => p.roster_position === 'active').map(async player => {
            let stats;
            
            // Direct query now that all IDs are in Tank01 format
            stats = await db.get(`
                SELECT * FROM player_stats
                WHERE player_id = ? AND week = ? AND season = ?
            `, [player.player_id, matchup.week, matchup.season]);
            
            const playerTeam = getTeamAbbreviation(player.team);
            const opponent = await getPlayerOpponent(db, player, matchup.week, matchup.season, stats);
            
            // Get game information from nfl_games table
            const gameInfo = await db.get(`
                SELECT game_time, game_time_epoch, status, quarter, time_remaining 
                FROM nfl_games
                WHERE week = ? AND season = ? 
                AND (home_team = ? OR away_team = ?)
                LIMIT 1
            `, [matchup.week, matchup.season, playerTeam, playerTeam]);
            
            return {
                player_id: player.player_id,
                name: player.name,
                position: player.position === 'DST' ? 'DEF' : player.position,
                team: playerTeam,
                roster_position: player.roster_position,
                is_scoring: player.is_scoring === 1,
                scoring_slot: player.scoring_slot,
                stats: stats || { fantasy_points: 0 },
                opp: opponent || '@OPP',
                game_time: gameInfo?.game_time || null,
                game_time_epoch: gameInfo?.game_time_epoch || null,
                game_status: gameInfo?.status || 'Final',
                game_quarter: gameInfo?.quarter || null,
                game_time_remaining: gameInfo?.time_remaining || null
            };
        })
    );
    
    const team2Stats = await Promise.all(
        team2Roster.filter(p => p.roster_position === 'active').map(async player => {
            let stats;
            
            // Direct query now that all IDs are in Tank01 format
            stats = await db.get(`
                SELECT * FROM player_stats
                WHERE player_id = ? AND week = ? AND season = ?
            `, [player.player_id, matchup.week, matchup.season]);
            
            const playerTeam = getTeamAbbreviation(player.team);
            const opponent = await getPlayerOpponent(db, player, matchup.week, matchup.season, stats);
            
            // Get game information from nfl_games table
            const gameInfo = await db.get(`
                SELECT game_time, game_time_epoch, status, quarter, time_remaining 
                FROM nfl_games
                WHERE week = ? AND season = ? 
                AND (home_team = ? OR away_team = ?)
                LIMIT 1
            `, [matchup.week, matchup.season, playerTeam, playerTeam]);
            
            return {
                player_id: player.player_id,
                name: player.name,
                position: player.position === 'DST' ? 'DEF' : player.position,
                team: playerTeam,
                roster_position: player.roster_position,
                is_scoring: player.is_scoring === 1,
                scoring_slot: player.scoring_slot,
                stats: stats || { fantasy_points: 0 },
                opp: opponent || '@OPP',
                game_time: gameInfo?.game_time || null,
                game_time_epoch: gameInfo?.game_time_epoch || null,
                game_status: gameInfo?.status || 'Final',
                game_quarter: gameInfo?.quarter || null,
                game_time_remaining: gameInfo?.time_remaining || null
            };
        })
    );
    
    res.json({
        success: true,
        data: {
            matchup: {
                ...matchup,
                margin: Math.abs(matchup.team1_points - matchup.team2_points),
                winner: matchup.team1_points > matchup.team2_points ? 'team1' : 
                        matchup.team2_points > matchup.team1_points ? 'team2' : 'tie',
                total_points: matchup.team1_points + matchup.team2_points
            },
            team1: {
                roster: team1Roster,
                starters: team1Stats
            },
            team2: {
                roster: team2Roster,
                starters: team2Stats
            }
        }
    });
}));

// Get head-to-head record between two teams
router.get('/h2h/:team1Id/:team2Id', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { team1Id, team2Id } = req.params;
    
    if (!team1Id || !team2Id || isNaN(team1Id) || isNaN(team2Id)) {
        throw new APIError('Invalid team IDs', 400);
    }
    
    const team1 = parseInt(team1Id);
    const team2 = parseInt(team2Id);
    
    if (team1 === team2) {
        throw new APIError('Cannot compare team to itself', 400);
    }
    
    // Get all matchups between these teams
    const matchups = await db.all(`
        SELECT * FROM matchups 
        WHERE (team1_id = ? AND team2_id = ?) 
           OR (team1_id = ? AND team2_id = ?)
        ORDER BY season DESC, week DESC
    `, [team1, team2, team2, team1]);
    
    // Calculate head-to-head record
    let team1Wins = 0;
    let team2Wins = 0;
    let ties = 0;
    let totalPoints1 = 0;
    let totalPoints2 = 0;
    
    matchups.forEach(matchup => {
        if (matchup.team1_id === team1) {
            totalPoints1 += matchup.team1_points;
            totalPoints2 += matchup.team2_points;
            if (matchup.team1_points > matchup.team2_points) team1Wins++;
            else if (matchup.team2_points > matchup.team1_points) team2Wins++;
            else ties++;
        } else {
            totalPoints1 += matchup.team2_points;
            totalPoints2 += matchup.team1_points;
            if (matchup.team2_points > matchup.team1_points) team1Wins++;
            else if (matchup.team1_points > matchup.team2_points) team2Wins++;
            else ties++;
        }
    });
    
    // Get team names
    const [teamInfo1, teamInfo2] = await Promise.all([
        db.getTeam(team1),
        db.getTeam(team2)
    ]);
    
    res.json({
        success: true,
        data: {
            team1: teamInfo1,
            team2: teamInfo2,
            record: {
                team1_wins: team1Wins,
                team2_wins: team2Wins,
                ties,
                total_games: matchups.length
            },
            points: {
                team1_total: totalPoints1,
                team2_total: totalPoints2,
                team1_average: matchups.length > 0 ? totalPoints1 / matchups.length : 0,
                team2_average: matchups.length > 0 ? totalPoints2 / matchups.length : 0
            },
            recent_matchups: matchups.slice(0, 5) // Last 5 matchups
        }
    });
}));

// This route moved to end of file to avoid conflicts with mock routes

// Get head-to-head record between two teams
router.get('/h2h/:team1Id/:team2Id', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { team1Id, team2Id } = req.params;
    
    if (!team1Id || !team2Id || isNaN(team1Id) || isNaN(team2Id)) {
        throw new APIError('Invalid team IDs', 400);
    }
    
    const team1 = parseInt(team1Id);
    const team2 = parseInt(team2Id);
    
    if (team1 === team2) {
        throw new APIError('Cannot compare team to itself', 400);
    }
    
    // Get all matchups between these teams
    const matchups = await db.all(`
        SELECT * FROM matchups 
        WHERE (team1_id = ? AND team2_id = ?) 
           OR (team1_id = ? AND team2_id = ?)
        ORDER BY season DESC, week DESC
    `, [team1, team2, team2, team1]);
    
    // Calculate head-to-head record
    let team1Wins = 0;
    let team2Wins = 0;
    let ties = 0;
    let totalPoints1 = 0;
    let totalPoints2 = 0;
    
    matchups.forEach(matchup => {
        if (matchup.team1_id === team1) {
            totalPoints1 += matchup.team1_points;
            totalPoints2 += matchup.team2_points;
            if (matchup.team1_points > matchup.team2_points) team1Wins++;
            else if (matchup.team2_points > matchup.team1_points) team2Wins++;
            else ties++;
        } else {
            totalPoints1 += matchup.team2_points;
            totalPoints2 += matchup.team1_points;
            if (matchup.team2_points > matchup.team1_points) team1Wins++;
            else if (matchup.team1_points > matchup.team2_points) team2Wins++;
            else ties++;
        }
    });
    
    // Get team names
    const [teamInfo1, teamInfo2] = await Promise.all([
        db.getTeam(team1),
        db.getTeam(team2)
    ]);
    
    res.json({
        success: true,
        data: {
            team1: teamInfo1,
            team2: teamInfo2,
            record: {
                team1_wins: team1Wins,
                team2_wins: team2Wins,
                ties,
                total_games: matchups.length
            },
            points: {
                team1_total: totalPoints1,
                team2_total: totalPoints2,
                team1_average: matchups.length > 0 ? totalPoints1 / matchups.length : 0,
                team2_average: matchups.length > 0 ? totalPoints2 / matchups.length : 0
            },
            recent_matchups: matchups.slice(0, 5) // Last 5 matchups
        }
    });
}));

// Get matchups for specific week (MUST be last due to generic parameter matching)
router.get('/:week/:season', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { week, season } = req.params;
    
    const weekNum = parseInt(week);
    const seasonYear = parseInt(season);
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        throw new APIError('Week must be between 1 and 18', 400);
    }
    
    if (isNaN(seasonYear) || seasonYear < 2020 || seasonYear > 2030) {
        throw new APIError('Invalid season year', 400);
    }
    
    let matchups = await db.getWeekMatchups(weekNum, seasonYear);
    let actualWeek = weekNum;
    
    // If no matchups found for requested week, fall back to Week 1 matchups
    if (!matchups || matchups.length === 0) {
        matchups = await db.getWeekMatchups(1, seasonYear);
        if (matchups && matchups.length > 0) {
            // Update the matchups to use current week's team scores
            const updatedMatchups = await Promise.all(matchups.map(async (matchup) => {
                // Get team scores for the requested week
                const team1Score = await db.get(`
                    SELECT SUM(ps.fantasy_points) as total_points
                    FROM fantasy_rosters fr
                    JOIN player_stats ps ON fr.player_id = ps.player_id
                    WHERE fr.team_id = ? AND ps.week = ? AND ps.season = ?
                    AND fr.roster_position = 'starter'
                `, [matchup.team1_id, weekNum, seasonYear]);
                
                const team2Score = await db.get(`
                    SELECT SUM(ps.fantasy_points) as total_points
                    FROM fantasy_rosters fr
                    JOIN player_stats ps ON fr.player_id = ps.player_id
                    WHERE fr.team_id = ? AND ps.week = ? AND ps.season = ?
                    AND fr.roster_position = 'starter'
                `, [matchup.team2_id, weekNum, seasonYear]);
                
                return {
                    ...matchup,
                    week: weekNum, // Update to requested week
                    season: seasonYear,
                    team1_points: team1Score?.total_points || 0,
                    team2_points: team2Score?.total_points || 0
                };
            }));
            matchups = updatedMatchups;
        }
    }
    
    // Add additional matchup information
    const enrichedMatchups = matchups.map(matchup => {
        // Use scoring points if they exist, otherwise fall back to total points
        const team1Points = matchup.team1_scoring_points ?? matchup.team1_points;
        const team2Points = matchup.team2_scoring_points ?? matchup.team2_points;
        
        return {
            ...matchup,
            // Override with scoring points
            team1_points: team1Points,
            team2_points: team2Points,
            // Keep original totals available
            team1_total_points: matchup.team1_points,
            team2_total_points: matchup.team2_points,
            margin: Math.abs(team1Points - team2Points),
            winner: team1Points > team2Points ? 'team1' : 
                    team2Points > team1Points ? 'team2' : 'tie',
            total_points: team1Points + team2Points,
            is_close_game: Math.abs(team1Points - team2Points) < 10
        };
    });
    
    res.json({
        success: true,
        data: enrichedMatchups,
        count: enrichedMatchups.length,
        week: weekNum,
        season: seasonYear,
        fallback_used: actualWeek !== weekNum
    });
}));

module.exports = router;