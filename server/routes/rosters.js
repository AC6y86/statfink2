const express = require('express');
const { asyncHandler, APIError } = require('../utils/errorHandler');
const router = express.Router();

// Get all team rosters for a specific week
router.get('/:season/:week', asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { season, week } = req.params;
    
    // Validate inputs
    const seasonNum = parseInt(season);
    const weekNum = parseInt(week);
    
    if (isNaN(seasonNum) || seasonNum < 2020 || seasonNum > 2030) {
        throw new APIError('Invalid season', 400);
    }
    
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
        throw new APIError('Invalid week', 400);
    }
    
    // Get all teams
    const teams = await db.all(`
        SELECT DISTINCT t.team_id, t.team_name, t.owner_name
        FROM teams t
        ORDER BY t.team_name
    `);
    
    // Get all rosters for the week
    const rosters = await db.all(`
        SELECT 
            r.team_id,
            r.player_id,
            r.player_name as name,
            CASE 
                WHEN r.player_position = 'DST' THEN 'Defense'
                ELSE r.player_position
            END as position,
            r.player_team as team,
            CASE 
                WHEN r.roster_position = 'injured_reserve' THEN 'IR'
                ELSE 'Active'
            END as status,
            r.is_scoring,
            r.scoring_slot
        FROM weekly_rosters r
        WHERE r.week = ? AND r.season = ?
        ORDER BY 
            r.team_id,
            CASE r.player_position 
                WHEN 'QB' THEN 1 
                WHEN 'RB' THEN 2 
                WHEN 'WR' THEN 3 
                WHEN 'TE' THEN 4 
                WHEN 'K' THEN 5
                WHEN 'DST' THEN 6
                WHEN 'Defense' THEN 6
                ELSE 7 
            END,
            r.player_name
    `, [weekNum, seasonNum]);
    
    // Group rosters by team
    const teamRosters = {};
    teams.forEach(team => {
        teamRosters[team.team_id] = {
            team_id: team.team_id,
            team_name: team.team_name,
            owner_name: team.owner_name,
            roster: []
        };
    });
    
    rosters.forEach(player => {
        if (teamRosters[player.team_id]) {
            teamRosters[player.team_id].roster.push(player);
        }
    });
    
    res.json({
        success: true,
        data: {
            season: seasonNum,
            week: weekNum,
            teams: Object.values(teamRosters)
        }
    });
}));

module.exports = router;