const { logInfo, logError } = require('../utils/errorHandler');

class TeamScoreService {
    constructor(db) {
        this.db = db;
    }

    // NB: this service must never write matchups.teamX_scoring_points. Its old
    // recalculateTeamScores/recalculateSeasonScores summed the FULL active
    // roster (19 players) instead of the marked scoring lineup, corrupting
    // official matchup scores from three different call paths (recalc, live
    // updates, admin sync) before being removed for good. The sole legitimate
    // writer is scoringPlayersService.updateMatchupScoringTotals.
    // Guarded by tests/integration/matchupScoreIntegrity.test.js.

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