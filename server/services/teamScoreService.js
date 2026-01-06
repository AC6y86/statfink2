const { logInfo, logError } = require('../utils/errorHandler');

class TeamScoreService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Recalculate team scores for a specific week
     */
    async recalculateTeamScores(week, season) {
        try {
            // Get all teams
            const teams = await this.db.all('SELECT team_id FROM teams');
            
            let updated = 0;
            
            for (const team of teams) {
                // Calculate total points for active players
                const totalPoints = await this.calculateTeamTotalPoints(team.team_id, week, season);
                
                // Update matchup scores
                const matchupUpdates = await this.updateMatchupScores(team.team_id, week, season, totalPoints);
                
                if (matchupUpdates > 0) {
                    updated++;
                }
            }
            
            logInfo(`  ✓ Recalculated team scores for Week ${week}: ${updated} teams updated`);
            
            return {
                success: true,
                week,
                teamsUpdated: updated,
                totalTeams: teams.length
            };
            
        } catch (error) {
            logError(`Error recalculating team scores for Week ${week}:`, error);
            throw error;
        }
    }

    /**
     * Calculate total fantasy points for a team's active roster
     */
    async calculateTeamTotalPoints(teamId, week, season) {
        try {
            const result = await this.db.get(`
                SELECT SUM(ps.fantasy_points) as total_points
                FROM weekly_rosters wr
                JOIN player_stats ps ON wr.player_id = ps.player_id
                WHERE wr.team_id = ? 
                AND ps.week = ? 
                AND ps.season = ?
                AND wr.week = ? 
                AND wr.season = ?
                AND wr.roster_position = 'active'
            `, [teamId, week, season, week, season]);
            
            return result?.total_points || 0;
        } catch (error) {
            logError(`Error calculating total points for team ${teamId}:`, error);
            throw error;
        }
    }

    /**
     * Update matchup scores for a team
     */
    async updateMatchupScores(teamId, week, season, totalPoints) {
        try {
            // Update when team is team1
            const result1 = await this.db.run(`
                UPDATE matchups
                SET team1_scoring_points = ?
                WHERE team1_id = ? AND week = ? AND season = ?
            `, [totalPoints, teamId, week, season]);

            // Update when team is team2
            const result2 = await this.db.run(`
                UPDATE matchups
                SET team2_scoring_points = ?
                WHERE team2_id = ? AND week = ? AND season = ?
            `, [totalPoints, teamId, week, season]);
            
            return result1.changes + result2.changes;
        } catch (error) {
            logError(`Error updating matchup scores for team ${teamId}:`, error);
            throw error;
        }
    }

    /**
     * Recalculate all team scores for an entire season
     */
    async recalculateSeasonScores(season, startWeek = 1, endWeek = 17) {
        try {
            logInfo(`📊 Recalculating team scores for ${season} season (weeks ${startWeek}-${endWeek})...`);
            
            let totalUpdated = 0;
            
            for (let week = startWeek; week <= endWeek; week++) {
                const weekResult = await this.recalculateTeamScores(week, season);
                totalUpdated += weekResult.teamsUpdated;
            }
            
            logInfo(`✓ Season recalculation complete: ${totalUpdated} team-weeks updated`);
            
            return {
                success: true,
                season,
                weeksProcessed: endWeek - startWeek + 1,
                totalUpdated
            };
            
        } catch (error) {
            logError(`Error recalculating season scores:`, error);
            throw error;
        }
    }

    /**
     * Get team scores for a specific week
     */
    async getWeeklyTeamScores(week, season) {
        try {
            const scores = await this.db.all(`
                SELECT
                    m.matchup_id,
                    m.week,
                    t1.team_name as team1_name,
                    m.team1_scoring_points as team1_points,
                    t2.team_name as team2_name,
                    m.team2_scoring_points as team2_points,
                    CASE
                        WHEN m.team1_scoring_points > m.team2_scoring_points THEN m.team1_id
                        WHEN m.team2_scoring_points > m.team1_scoring_points THEN m.team2_id
                        ELSE NULL
                    END as winner_id
                FROM matchups m
                JOIN teams t1 ON m.team1_id = t1.team_id
                JOIN teams t2 ON m.team2_id = t2.team_id
                WHERE m.week = ? AND m.season = ?
                ORDER BY m.matchup_id
            `, [week, season]);
            
            return scores;
        } catch (error) {
            logError(`Error getting weekly team scores:`, error);
            throw error;
        }
    }

    /**
     * Verify roster completeness for scoring
     */
    async verifyRosterCompleteness(week, season) {
        try {
            const result = await this.db.all(`
                SELECT 
                    t.team_id,
                    t.team_name,
                    COUNT(wr.player_id) as active_players
                FROM teams t
                LEFT JOIN weekly_rosters wr ON t.team_id = wr.team_id
                    AND wr.week = ? 
                    AND wr.season = ?
                    AND wr.roster_position = 'active'
                GROUP BY t.team_id, t.team_name
                HAVING active_players != 19
            `, [week, season]);
            
            if (result.length > 0) {
                logError(`⚠️ Week ${week}: ${result.length} teams don't have 19 active players`);
                result.forEach(team => {
                    logError(`  - ${team.team_name}: ${team.active_players} active players`);
                });
            }
            
            return {
                complete: result.length === 0,
                incompleteTeams: result
            };
        } catch (error) {
            logError(`Error verifying roster completeness:`, error);
            throw error;
        }
    }

    /**
     * Get season standings
     */
    async getSeasonStandings(season) {
        try {
            const standings = await this.db.all(`
                SELECT
                    t.team_id,
                    t.team_name,
                    SUM(CASE
                        WHEN m.team1_id = t.team_id AND m.team1_scoring_points > m.team2_scoring_points THEN 1
                        WHEN m.team2_id = t.team_id AND m.team2_scoring_points > m.team1_scoring_points THEN 1
                        ELSE 0
                    END) as wins,
                    SUM(CASE
                        WHEN m.team1_id = t.team_id AND m.team1_scoring_points < m.team2_scoring_points THEN 1
                        WHEN m.team2_id = t.team_id AND m.team2_scoring_points < m.team1_scoring_points THEN 1
                        ELSE 0
                    END) as losses,
                    SUM(CASE
                        WHEN m.team1_id = t.team_id THEN m.team1_scoring_points
                        WHEN m.team2_id = t.team_id THEN m.team2_scoring_points
                        ELSE 0
                    END) as total_points
                FROM teams t
                LEFT JOIN matchups m ON (m.team1_id = t.team_id OR m.team2_id = t.team_id)
                    AND m.season = ?
                GROUP BY t.team_id, t.team_name
                ORDER BY wins DESC, total_points DESC
            `, [season]);
            
            return standings;
        } catch (error) {
            logError(`Error getting season standings:`, error);
            throw error;
        }
    }
}

module.exports = TeamScoreService;