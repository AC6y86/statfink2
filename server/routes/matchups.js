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
    // If we have stats with game_id, use that
    if (stats?.game_id && stats?.team) {
        return getOpponentFromGameId(stats.game_id, stats.team);
    }
    
    // Otherwise, look up the game for this team in this week
    // Use the team from the roster data (player.team) 
    const teamCode = getTeamAbbreviation(player.team); // Convert team name to abbreviation
    
    // Find any game_id for this team in this week/season
    const gameInfo = await db.get(`
        SELECT DISTINCT game_id, team FROM player_stats
        WHERE team = ? AND week = ? AND season = ?
        LIMIT 1
    `, [teamCode, week, season]);
    
    if (gameInfo?.game_id && gameInfo?.team) {
        return getOpponentFromGameId(gameInfo.game_id, gameInfo.team);
    }
    
    return null;
}

// Mock API endpoints for testing (must be first to avoid conflicts)
// Mock matchups for a specific week/season
router.get('/mock/:week/:season', asyncHandler(async (req, res) => {
    const { week, season } = req.params;
    
    // Generate mock matchup data
    const mockMatchups = [
        {
            matchup_id: 1,
            week: parseInt(week),
            season: parseInt(season),
            team1_id: 1,
            team2_id: 2,
            team1_name: "Team Alpha",
            team1_owner: "Test Owner 1",
            team1_points: 125.50,
            team2_name: "Team Beta", 
            team2_owner: "Test Owner 2",
            team2_points: 118.75,
            is_complete: 1
        },
        {
            matchup_id: 2,
            week: parseInt(week),
            season: parseInt(season),
            team1_id: 3,
            team2_id: 4,
            team1_name: "Team Gamma",
            team1_owner: "Test Owner 3",
            team1_points: 142.25,
            team2_name: "Team Delta",
            team2_owner: "Test Owner 4", 
            team2_points: 139.80,
            is_complete: 1
        }
    ];
    
    res.json({
        success: true,
        data: mockMatchups,
        count: mockMatchups.length,
        week: parseInt(week),
        season: parseInt(season),
        mock: true
    });
}));

// Mock specific matchup details
router.get('/mock-game/:matchupId', asyncHandler(async (req, res) => {
    const { matchupId } = req.params;
    
    const mockMatchupData = {
        matchup: {
            matchup_id: parseInt(matchupId),
            week: 1,
            season: 2024,
            team1_id: 1,
            team2_id: 2,
            team1_name: "Team Alpha",
            team1_owner: "Test Owner 1",
            team1_points: 125.50,
            team2_name: "Team Beta",
            team2_owner: "Test Owner 2", 
            team2_points: 118.75,
            is_complete: 1
        },
        team1: {
            starters: [
                {
                    player_id: "QB123",
                    name: "Mock QB (Test)",
                    position: "QB",
                    team: "TST",
                    opp: "@OPP",
                    stats: {
                        fantasy_points: 24.5,
                        passing_yards: 285,
                        passing_tds: 2,
                        interceptions: 1
                    }
                },
                {
                    player_id: "RB456", 
                    name: "Mock RB (Test)",
                    position: "RB",
                    team: "TST",
                    opp: "@OPP",
                    stats: {
                        fantasy_points: 18.7,
                        rushing_yards: 87,
                        rushing_tds: 1,
                        receiving_yards: 25,
                        receptions: 3
                    }
                }
            ]
        },
        team2: {
            starters: [
                {
                    player_id: "QB789",
                    name: "Mock QB2 (Test)",
                    position: "QB", 
                    team: "TST",
                    opp: "@KC",
                    stats: {
                        fantasy_points: 22.1,
                        passing_yards: 245,
                        passing_tds: 2,
                        interceptions: 0
                    }
                },
                {
                    player_id: "RB101",
                    name: "Mock RB2 (Test)",
                    position: "RB",
                    team: "TST",
                    opp: "BAL", 
                    stats: {
                        fantasy_points: 15.3,
                        rushing_yards: 73,
                        rushing_tds: 0,
                        receiving_yards: 35,
                        receptions: 4
                    }
                }
            ]
        }
    };
    
    res.json({
        success: true,
        data: mockMatchupData,
        mock: true
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
            
            return {
                player_id: player.player_id,
                name: player.name,
                position: player.position === 'DST' ? 'DEF' : player.position,
                team: playerTeam,
                roster_position: player.roster_position,
                is_scoring: player.is_scoring === 1,
                scoring_slot: player.scoring_slot,
                stats: stats || { fantasy_points: 0 },
                opp: opponent || '@OPP'
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
            
            return {
                player_id: player.player_id,
                name: player.name,
                position: player.position === 'DST' ? 'DEF' : player.position,
                team: playerTeam,
                roster_position: player.roster_position,
                is_scoring: player.is_scoring === 1,
                scoring_slot: player.scoring_slot,
                stats: stats || { fantasy_points: 0 },
                opp: opponent || '@OPP'
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