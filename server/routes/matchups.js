const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const router = express.Router();

// Get matchups for specific week
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
    
    const matchups = await db.getWeekMatchups(weekNum, seasonYear);
    
    // Add additional matchup information
    const enrichedMatchups = matchups.map(matchup => ({
        ...matchup,
        margin: Math.abs(matchup.team1_points - matchup.team2_points),
        winner: matchup.team1_points > matchup.team2_points ? 'team1' : 
                matchup.team2_points > matchup.team1_points ? 'team2' : 'tie',
        total_points: matchup.team1_points + matchup.team2_points,
        is_close_game: Math.abs(matchup.team1_points - matchup.team2_points) < 10
    }));
    
    res.json({
        success: true,
        data: enrichedMatchups,
        count: enrichedMatchups.length,
        week: weekNum,
        season: seasonYear
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
    const enrichedMatchups = matchups.map(matchup => ({
        ...matchup,
        margin: Math.abs(matchup.team1_points - matchup.team2_points),
        winner: matchup.team1_points > matchup.team2_points ? 'team1' : 
                matchup.team2_points > matchup.team1_points ? 'team2' : 'tie',
        total_points: matchup.team1_points + matchup.team2_points,
        is_close_game: Math.abs(matchup.team1_points - matchup.team2_points) < 10
    }));
    
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
    
    // Get rosters for both teams
    const [team1Roster, team2Roster] = await Promise.all([
        db.getTeamRoster(matchup.team1_id),
        db.getTeamRoster(matchup.team2_id)
    ]);
    
    // Get player stats for this week if available
    const team1Stats = await Promise.all(
        team1Roster.filter(p => p.roster_position === 'starter' && p.roster_position !== 'injured_reserve').map(async player => {
            const stats = await db.getPlayerStats(player.player_id, matchup.week, matchup.season);
            return {
                ...player,
                stats: stats || { fantasy_points: 0 }
            };
        })
    );
    
    const team2Stats = await Promise.all(
        team2Roster.filter(p => p.roster_position === 'starter' && p.roster_position !== 'injured_reserve').map(async player => {
            const stats = await db.getPlayerStats(player.player_id, matchup.week, matchup.season);
            return {
                ...player,
                stats: stats || { fantasy_points: 0 }
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

module.exports = router;