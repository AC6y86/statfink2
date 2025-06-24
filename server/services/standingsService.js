const { logInfo, logError } = require('../utils/errorHandler');

class StandingsService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Calculate standings for a specific week
     * Builds on previous week's cumulative data
     */
    async calculateWeeklyStandings(week, season) {
        try {
            logInfo(`Calculating standings for Week ${week}, Season ${season}`);
            
            // Get all teams
            const teams = await this.db.all('SELECT team_id, team_name FROM teams ORDER BY team_id');
            
            // Get matchup results for this week (for W-L calculation)
            const matchups = await this.db.all(`
                SELECT 
                    team1_id,
                    team2_id,
                    team1_points,
                    team2_points,
                    team1_scoring_points,
                    team2_scoring_points,
                    is_complete
                FROM matchups
                WHERE week = ? AND season = ? AND is_complete = 1
            `, [week, season]);
            
            // Calculate standings for each team
            const standingsData = [];
            
            for (const team of teams) {
                // Get this week's points from matchups
                const weekPoints = await this.getTeamWeekPoints(team.team_id, week, season, matchups);
                
                // Get previous week's cumulative data
                const previousWeekData = week > 1 
                    ? await this.getPreviousWeekStandings(team.team_id, week - 1, season)
                    : { wins: 0, losses: 0, ties: 0, cumulative_points: 0 };
                
                // Calculate W-L for this week (only for weeks 1-12)
                let weekResult = { win: 0, loss: 0, tie: 0 };
                if (week <= 12) {
                    weekResult = this.getWeekMatchupResult(team.team_id, matchups);
                }
                
                // Calculate new totals
                const wins = previousWeekData.wins + weekResult.win;
                const losses = previousWeekData.losses + weekResult.loss;
                const ties = previousWeekData.ties + weekResult.tie;
                const cumulativePoints = previousWeekData.cumulative_points + weekPoints;
                
                standingsData.push({
                    team_id: team.team_id,
                    team_name: team.team_name,
                    week,
                    season,
                    wins,
                    losses,
                    ties,
                    points_for_week: weekPoints,
                    cumulative_points: cumulativePoints
                });
            }
            
            // Calculate weekly rankings based on points for the week
            standingsData.sort((a, b) => b.points_for_week - a.points_for_week);
            standingsData.forEach((standing, index) => {
                standing.weekly_rank = index + 1;
            });
            
            // Insert or update standings data
            for (const standing of standingsData) {
                await this.db.run(`
                    INSERT OR REPLACE INTO weekly_standings 
                    (team_id, week, season, wins, losses, ties, points_for_week, cumulative_points, weekly_rank)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    standing.team_id,
                    standing.week,
                    standing.season,
                    standing.wins,
                    standing.losses,
                    standing.ties,
                    standing.points_for_week,
                    standing.cumulative_points,
                    standing.weekly_rank
                ]);
            }
            
            logInfo(`  ✓ Calculated standings for Week ${week}: ${teams.length} teams processed`);
            
            return {
                success: true,
                week,
                season,
                teamsProcessed: teams.length
            };
            
        } catch (error) {
            logError(`Error calculating standings for Week ${week}:`, error);
            throw error;
        }
    }
    
    /**
     * Get team's points for a specific week from matchups
     */
    async getTeamWeekPoints(teamId, week, season, matchups) {
        const matchup = matchups.find(m => 
            m.team1_id === teamId || m.team2_id === teamId
        );
        
        if (!matchup) {
            return 0;
        }
        
        // Use team1_scoring_points and team2_scoring_points if available, otherwise fall back to team1_points/team2_points
        if (matchup.team1_id === teamId) {
            return matchup.team1_scoring_points !== null ? matchup.team1_scoring_points : matchup.team1_points;
        } else {
            return matchup.team2_scoring_points !== null ? matchup.team2_scoring_points : matchup.team2_points;
        }
    }
    
    /**
     * Get previous week's standings data for a team
     */
    async getPreviousWeekStandings(teamId, week, season) {
        const result = await this.db.get(`
            SELECT wins, losses, ties, cumulative_points
            FROM weekly_standings
            WHERE team_id = ? AND week = ? AND season = ?
        `, [teamId, week, season]);
        
        return result || { wins: 0, losses: 0, ties: 0, cumulative_points: 0 };
    }
    
    /**
     * Determine if team won, lost, or tied this week
     */
    getWeekMatchupResult(teamId, matchups) {
        const matchup = matchups.find(m => 
            m.team1_id === teamId || m.team2_id === teamId
        );
        
        if (!matchup || !matchup.is_complete) {
            return { win: 0, loss: 0, tie: 0 };
        }
        
        const isTeam1 = matchup.team1_id === teamId;
        // Use scoring points for determining W-L
        const teamPoints = isTeam1 
            ? (matchup.team1_scoring_points !== null ? matchup.team1_scoring_points : matchup.team1_points)
            : (matchup.team2_scoring_points !== null ? matchup.team2_scoring_points : matchup.team2_points);
        const opponentPoints = isTeam1 
            ? (matchup.team2_scoring_points !== null ? matchup.team2_scoring_points : matchup.team2_points)
            : (matchup.team1_scoring_points !== null ? matchup.team1_scoring_points : matchup.team1_points);
        
        if (teamPoints > opponentPoints) {
            return { win: 1, loss: 0, tie: 0 };
        } else if (teamPoints < opponentPoints) {
            return { win: 0, loss: 1, tie: 0 };
        } else {
            return { win: 0, loss: 0, tie: 1 };
        }
    }
    
    /**
     * Get standings data for a specific week
     */
    async getStandingsForWeek(week, season) {
        try {
            // Get weekly rankings (sorted by points for the week)
            const weeklyRankings = await this.db.all(`
                SELECT 
                    ws.team_id,
                    t.team_name,
                    ws.points_for_week,
                    ws.weekly_rank
                FROM weekly_standings ws
                JOIN teams t ON ws.team_id = t.team_id
                WHERE ws.week = ? AND ws.season = ?
                ORDER BY ws.weekly_rank
            `, [week, season]);
            
            // Get overall standings (with W-L and cumulative points)
            const overallStandings = await this.db.all(`
                SELECT 
                    ws.team_id,
                    t.team_name,
                    ws.wins,
                    ws.losses,
                    ws.ties,
                    ws.cumulative_points,
                    (SELECT COUNT(*) FROM weekly_standings ws2 
                     WHERE ws2.team_id = ws.team_id 
                     AND ws2.season = ws.season 
                     AND ws2.weekly_rank = 1
                     AND ws2.week <= ?) as weekly_wins
                FROM weekly_standings ws
                JOIN teams t ON ws.team_id = t.team_id
                WHERE ws.week = ? AND ws.season = ?
                ORDER BY ws.wins DESC, ws.cumulative_points DESC
            `, [week, week, season]);
            
            // Get weekly winner
            const weeklyWinner = weeklyRankings.find(team => team.weekly_rank === 1);
            
            return {
                weeklyRankings,
                overallStandings,
                weeklyWinner,
                week,
                season
            };
            
        } catch (error) {
            logError(`Error getting standings for Week ${week}:`, error);
            throw error;
        }
    }
    
    /**
     * Get count of weekly wins for all teams in a season
     */
    async getWeeklyWinners(season) {
        try {
            const results = await this.db.all(`
                SELECT 
                    t.team_id,
                    t.team_name,
                    COUNT(*) as weekly_win_count
                FROM weekly_standings ws
                JOIN teams t ON ws.team_id = t.team_id
                WHERE ws.season = ? AND ws.weekly_rank = 1
                GROUP BY t.team_id, t.team_name
                ORDER BY weekly_win_count DESC
            `, [season]);
            
            return results;
            
        } catch (error) {
            logError('Error getting weekly winners:', error);
            throw error;
        }
    }
}

module.exports = StandingsService;