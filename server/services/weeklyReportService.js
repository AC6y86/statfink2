const fs = require('fs').promises;
const path = require('path');
const { logInfo, logError, logWarn } = require('../utils/errorHandler');

class WeeklyReportService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Generate a comprehensive weekly report in JSON format
     * @param {number} week - Week number
     * @param {number} season - Season year
     * @returns {object} Result with success status and file path
     */
    async generateWeeklyReport(week, season) {
        try {
            logInfo(`Generating weekly report for Week ${week}, Season ${season}`);
            
            const report = {
                week,
                season,
                generated_at: new Date().toISOString(),
                teams: [],
                matchups: [],
                validation: {
                    all_teams_have_19_players: true,
                    teams_with_issues: []
                }
            };

            // Get all teams
            const teams = await this.db.all(`
                SELECT team_id, team_name, owner_name 
                FROM teams 
                ORDER BY team_id
            `);

            // Process each team
            for (const team of teams) {
                const teamData = await this.getTeamData(team, week, season);
                report.teams.push(teamData);
                
                // Validate roster size
                if (teamData.roster.length !== 19) {
                    report.validation.all_teams_have_19_players = false;
                    report.validation.teams_with_issues.push({
                        team_id: team.team_id,
                        team_name: team.team_name,
                        player_count: teamData.roster.length,
                        expected: 19
                    });
                    logWarn(`Team ${team.team_name} has ${teamData.roster.length} players instead of 19`);
                }
            }

            // Get matchups
            const matchups = await this.getMatchups(week, season);
            report.matchups = matchups;

            // Save to file
            const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            const filename = `${date}_week${week}_data.json`;
            const backupDir = path.join(__dirname, '../../backup_data');
            const filepath = path.join(backupDir, filename);
            
            // Ensure backup directory exists
            await fs.mkdir(backupDir, { recursive: true });
            
            await fs.writeFile(filepath, JSON.stringify(report, null, 2));
            
            logInfo(`Weekly report saved to ${filepath}`);
            
            return {
                success: true,
                filepath,
                filename,
                message: `Weekly report generated successfully for Week ${week}`,
                validation: report.validation
            };
            
        } catch (error) {
            logError('Failed to generate weekly report', error);
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * Get all data for a specific team
     */
    async getTeamData(team, week, season) {
        try {
            // Get roster
            const roster = await this.db.all(`
                SELECT 
                    wr.player_id,
                    wr.player_name,
                    wr.player_position,
                    wr.player_team,
                    wr.roster_position,
                    wr.is_scoring,
                    wr.scoring_slot,
                    ps.fantasy_points,
                    ps.passing_yards,
                    ps.passing_tds,
                    ps.interceptions,
                    ps.rushing_yards,
                    ps.rushing_tds,
                    ps.receiving_yards,
                    ps.receiving_tds,
                    ps.receptions,
                    ps.fumbles,
                    ps.two_point_conversions_pass,
                    ps.two_point_conversions_run,
                    ps.two_point_conversions_rec,
                    ps.return_tds,
                    ps.field_goals_made,
                    ps.field_goals_attempted,
                    ps.extra_points_made,
                    ps.field_goals_0_39,
                    ps.field_goals_40_49,
                    ps.field_goals_50_plus,
                    ps.sacks,
                    ps.def_interceptions,
                    ps.fumbles_recovered,
                    ps.def_touchdowns,
                    ps.safeties,
                    ps.points_allowed,
                    ps.yards_allowed,
                    ps.def_points_bonus,
                    ps.def_yards_bonus
                FROM weekly_rosters wr
                LEFT JOIN player_stats ps ON 
                    wr.player_id = ps.player_id 
                    AND ps.week = ? 
                    AND ps.season = ?
                WHERE wr.team_id = ? 
                AND wr.week = ? 
                AND wr.season = ?
                ORDER BY 
                    CASE wr.roster_position 
                        WHEN 'active' THEN 1 
                        WHEN 'injured_reserve' THEN 2 
                        ELSE 3 
                    END,
                    ps.fantasy_points DESC NULLS LAST
            `, [week, season, team.team_id, week, season]);

            // Calculate total points
            const totalPoints = roster
                .filter(p => p.roster_position === 'active')
                .reduce((sum, p) => sum + (p.fantasy_points || 0), 0);

            // Get scoring points from matchup
            const matchupData = await this.db.get(`
                SELECT 
                    CASE 
                        WHEN team1_id = ? THEN team1_scoring_points
                        WHEN team2_id = ? THEN team2_scoring_points
                        ELSE 0
                    END as scoring_points
                FROM matchups
                WHERE week = ? AND season = ?
                AND (team1_id = ? OR team2_id = ?)
            `, [team.team_id, team.team_id, week, season, team.team_id, team.team_id]);

            const scoringPoints = matchupData?.scoring_points || 0;

            // Format roster data
            const formattedRoster = roster.map(player => ({
                player_id: player.player_id,
                player_name: player.player_name,
                position: player.player_position,
                team: player.player_team,
                status: player.roster_position,
                is_scoring: player.is_scoring === 1,
                scoring_slot: player.scoring_slot,
                fantasy_points: player.fantasy_points || 0,
                stats: this.extractPlayerStats(player)
            }));

            return {
                team_id: team.team_id,
                team_name: team.team_name,
                owner: team.owner_name,
                total_points: parseFloat(totalPoints.toFixed(2)),
                scoring_points: parseFloat(scoringPoints),
                active_players: roster.filter(p => p.roster_position === 'active').length,
                ir_players: roster.filter(p => p.roster_position === 'injured_reserve').length,
                roster: formattedRoster
            };
            
        } catch (error) {
            logError(`Failed to get team data for team ${team.team_id}`, error);
            throw error;
        }
    }

    /**
     * Extract relevant stats based on player position
     */
    extractPlayerStats(player) {
        const stats = {};
        
        // Common stats
        if (player.fumbles > 0) stats.fumbles = player.fumbles;
        if (player.return_tds > 0) stats.return_tds = player.return_tds;
        
        // Position-specific stats
        if (player.player_position === 'QB') {
            if (player.passing_yards) stats.passing_yards = player.passing_yards;
            if (player.passing_tds) stats.passing_tds = player.passing_tds;
            if (player.interceptions) stats.interceptions = player.interceptions;
            if (player.rushing_yards) stats.rushing_yards = player.rushing_yards;
            if (player.rushing_tds) stats.rushing_tds = player.rushing_tds;
            if (player.two_point_conversions_pass) stats.two_point_conversions_pass = player.two_point_conversions_pass;
            if (player.two_point_conversions_run) stats.two_point_conversions_run = player.two_point_conversions_run;
        } else if (player.player_position === 'RB') {
            if (player.rushing_yards) stats.rushing_yards = player.rushing_yards;
            if (player.rushing_tds) stats.rushing_tds = player.rushing_tds;
            if (player.receiving_yards) stats.receiving_yards = player.receiving_yards;
            if (player.receiving_tds) stats.receiving_tds = player.receiving_tds;
            if (player.receptions) stats.receptions = player.receptions;
            if (player.two_point_conversions_run) stats.two_point_conversions_run = player.two_point_conversions_run;
            if (player.two_point_conversions_rec) stats.two_point_conversions_rec = player.two_point_conversions_rec;
        } else if (player.player_position === 'WR' || player.player_position === 'TE') {
            if (player.receiving_yards) stats.receiving_yards = player.receiving_yards;
            if (player.receiving_tds) stats.receiving_tds = player.receiving_tds;
            if (player.receptions) stats.receptions = player.receptions;
            if (player.rushing_yards) stats.rushing_yards = player.rushing_yards;
            if (player.rushing_tds) stats.rushing_tds = player.rushing_tds;
            if (player.two_point_conversions_rec) stats.two_point_conversions_rec = player.two_point_conversions_rec;
        } else if (player.player_position === 'K') {
            if (player.field_goals_made) stats.field_goals_made = player.field_goals_made;
            if (player.field_goals_attempted) stats.field_goals_attempted = player.field_goals_attempted;
            if (player.extra_points_made) stats.extra_points_made = player.extra_points_made;
            if (player.field_goals_0_39) stats.field_goals_0_39 = player.field_goals_0_39;
            if (player.field_goals_40_49) stats.field_goals_40_49 = player.field_goals_40_49;
            if (player.field_goals_50_plus) stats.field_goals_50_plus = player.field_goals_50_plus;
        } else if (player.player_position === 'DEF') {
            if (player.sacks) stats.sacks = player.sacks;
            if (player.def_interceptions) stats.def_interceptions = player.def_interceptions;
            if (player.fumbles_recovered) stats.fumbles_recovered = player.fumbles_recovered;
            if (player.def_touchdowns) stats.def_touchdowns = player.def_touchdowns;
            if (player.safeties) stats.safeties = player.safeties;
            if (player.points_allowed !== null) stats.points_allowed = player.points_allowed;
            if (player.yards_allowed !== null) stats.yards_allowed = player.yards_allowed;
            if (player.def_points_bonus) stats.def_points_bonus = player.def_points_bonus;
            if (player.def_yards_bonus) stats.def_yards_bonus = player.def_yards_bonus;
        }
        
        return stats;
    }

    /**
     * Get all matchups for the week
     */
    async getMatchups(week, season) {
        try {
            const matchups = await this.db.all(`
                SELECT 
                    m.matchup_id,
                    m.team1_id,
                    m.team2_id,
                    m.team1_points,
                    m.team2_points,
                    m.team1_scoring_points,
                    m.team2_scoring_points,
                    m.is_complete,
                    t1.team_name as team1_name,
                    t2.team_name as team2_name
                FROM matchups m
                JOIN teams t1 ON m.team1_id = t1.team_id
                JOIN teams t2 ON m.team2_id = t2.team_id
                WHERE m.week = ? AND m.season = ?
                ORDER BY m.matchup_id
            `, [week, season]);

            return matchups.map(m => ({
                matchup_id: m.matchup_id,
                team1: {
                    id: m.team1_id,
                    name: m.team1_name,
                    total_points: parseFloat(m.team1_points || 0),
                    scoring_points: parseFloat(m.team1_scoring_points || 0)
                },
                team2: {
                    id: m.team2_id,
                    name: m.team2_name,
                    total_points: parseFloat(m.team2_points || 0),
                    scoring_points: parseFloat(m.team2_scoring_points || 0)
                },
                winner: m.team1_scoring_points > m.team2_scoring_points ? m.team1_name : 
                        m.team2_scoring_points > m.team1_scoring_points ? m.team2_name : 
                        'Tie',
                is_complete: m.is_complete === 1
            }));
            
        } catch (error) {
            logError('Failed to get matchups', error);
            throw error;
        }
    }
}

module.exports = WeeklyReportService;