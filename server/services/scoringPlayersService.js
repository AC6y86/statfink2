const { logInfo, logError } = require('../utils/errorHandler');

class ScoringPlayersService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Calculate and mark scoring players for all teams in a given week
     * This determines which 11 offensive players + 2 DST score for each team
     */
    async calculateScoringPlayers(week, season) {
        try {
            logInfo(`Calculating scoring players for Week ${week}, Season ${season}...`);
            
            // Get all teams
            const teams = await this.db.all('SELECT team_id FROM teams');
            
            let totalUpdated = 0;
            
            for (const team of teams) {
                const updated = await this.calculateTeamScoringPlayers(team.team_id, week, season);
                totalUpdated += updated;
            }
            
            // Update matchup scoring totals after all teams are processed
            await this.updateMatchupScoringTotals(week, season);
            
            logInfo(`  ✓ Calculated scoring players for ${teams.length} teams (${totalUpdated} players marked)`);
            
            return {
                success: true,
                teamsProcessed: teams.length,
                playersMarked: totalUpdated
            };
            
        } catch (error) {
            logError(`Error calculating scoring players for Week ${week}:`, error);
            throw error;
        }
    }

    /**
     * Calculate scoring players for a specific team
     */
    async calculateTeamScoringPlayers(teamId, week, season) {
        try {
            // First, reset all scoring flags for this team/week
            await this.db.run(`
                UPDATE weekly_rosters 
                SET is_scoring = 0, scoring_slot = NULL
                WHERE team_id = ? AND week = ? AND season = ?
            `, [teamId, week, season]);
            
            // Get all active players with their stats
            const roster = await this.db.all(`
                SELECT 
                    wr.player_id,
                    wr.player_name,
                    wr.player_position,
                    ps.fantasy_points,
                    ps.points_allowed,
                    ps.yards_allowed
                FROM weekly_rosters wr
                LEFT JOIN player_stats ps ON wr.player_id = ps.player_id 
                    AND ps.week = wr.week 
                    AND ps.season = wr.season
                WHERE wr.team_id = ? 
                    AND wr.week = ? 
                    AND wr.season = ?
                    AND wr.roster_position = 'active'
                ORDER BY ps.fantasy_points DESC NULLS LAST
            `, [teamId, week, season]);
            
            // Track which players are scoring
            const scoringPlayers = [];
            const positionCounts = {
                QB: 0,
                RB: 0,
                WR_TE: 0,
                K: 0,
                DST: 0,
                BONUS: 0
            };
            
            // Position limits
            const limits = {
                QB: 1,
                RB: 4,
                WR_TE: 4,
                K: 1,
                DST: 2,
                BONUS: 1
            };
            
            // Separate DST from other players
            const dstPlayers = roster.filter(p => p.player_position === 'DST');
            const offensivePlayers = roster.filter(p => p.player_position !== 'DST');
            
            // First pass: Fill required offensive positions (skip 0 point players)
            for (const player of offensivePlayers) {
                if (!player.fantasy_points || player.fantasy_points === 0) continue;
                
                const pos = player.player_position;
                let assigned = false;
                
                if (pos === 'QB' && positionCounts.QB < limits.QB) {
                    scoringPlayers.push({ ...player, scoring_slot: 'QB' });
                    positionCounts.QB++;
                    assigned = true;
                } else if (pos === 'RB' && positionCounts.RB < limits.RB) {
                    scoringPlayers.push({ ...player, scoring_slot: `RB${positionCounts.RB + 1}` });
                    positionCounts.RB++;
                    assigned = true;
                } else if ((pos === 'WR' || pos === 'TE') && positionCounts.WR_TE < limits.WR_TE) {
                    scoringPlayers.push({ ...player, scoring_slot: `WR/TE${positionCounts.WR_TE + 1}` });
                    positionCounts.WR_TE++;
                    assigned = true;
                } else if (pos === 'K' && positionCounts.K < limits.K) {
                    scoringPlayers.push({ ...player, scoring_slot: 'K' });
                    positionCounts.K++;
                    assigned = true;
                }
            }
            
            // Second pass: Fill bonus slot with highest remaining offensive player
            for (const player of offensivePlayers) {
                if (!player.fantasy_points || player.fantasy_points === 0) continue;
                if (scoringPlayers.some(sp => sp.player_id === player.player_id)) continue;
                
                if (positionCounts.BONUS < limits.BONUS) {
                    scoringPlayers.push({ ...player, scoring_slot: 'BONUS' });
                    positionCounts.BONUS++;
                    break;
                }
            }
            
            // Handle DST separately - need best points allowed and best yards allowed
            if (dstPlayers.length > 0) {
                // Sort by points allowed (ascending - fewer is better)
                const dstByPoints = [...dstPlayers]
                    .filter(d => d.points_allowed !== null)
                    .sort((a, b) => a.points_allowed - b.points_allowed);
                
                // Sort by yards allowed (ascending - fewer is better)
                const dstByYards = [...dstPlayers]
                    .filter(d => d.yards_allowed !== null)
                    .sort((a, b) => a.yards_allowed - b.yards_allowed);
                
                // Add best points allowed DST
                if (dstByPoints.length > 0) {
                    scoringPlayers.push({ ...dstByPoints[0], scoring_slot: 'DST_PA' });
                    positionCounts.DST++;
                }
                
                // Add best yards allowed DST (if different from points allowed)
                if (dstByYards.length > 0) {
                    const bestYardsDst = dstByYards.find(d => 
                        !scoringPlayers.some(sp => sp.player_id === d.player_id)
                    ) || dstByYards[0];
                    
                    if (positionCounts.DST < limits.DST) {
                        scoringPlayers.push({ ...bestYardsDst, scoring_slot: 'DST_YA' });
                        positionCounts.DST++;
                    }
                }
            }
            
            // Update database with scoring players
            for (const player of scoringPlayers) {
                await this.db.run(`
                    UPDATE weekly_rosters
                    SET is_scoring = 1, scoring_slot = ?
                    WHERE team_id = ? AND player_id = ? AND week = ? AND season = ?
                `, [player.scoring_slot, teamId, player.player_id, week, season]);
            }
            
            return scoringPlayers.length;
            
        } catch (error) {
            logError(`Error calculating scoring players for team ${teamId}:`, error);
            throw error;
        }
    }

    /**
     * Update matchup scoring totals based on marked scoring players
     */
    async updateMatchupScoringTotals(week, season) {
        try {
            // Get all matchups for the week
            const matchups = await this.db.all(`
                SELECT matchup_id, team1_id, team2_id
                FROM matchups
                WHERE week = ? AND season = ?
            `, [week, season]);
            
            for (const matchup of matchups) {
                // Calculate team1 scoring total
                const team1Total = await this.db.get(`
                    SELECT COALESCE(SUM(ps.fantasy_points), 0) as total
                    FROM weekly_rosters wr
                    JOIN player_stats ps ON wr.player_id = ps.player_id
                        AND ps.week = wr.week
                        AND ps.season = wr.season
                    WHERE wr.team_id = ?
                        AND wr.week = ?
                        AND wr.season = ?
                        AND wr.is_scoring = 1
                `, [matchup.team1_id, week, season]);
                
                // Calculate team2 scoring total
                const team2Total = await this.db.get(`
                    SELECT COALESCE(SUM(ps.fantasy_points), 0) as total
                    FROM weekly_rosters wr
                    JOIN player_stats ps ON wr.player_id = ps.player_id
                        AND ps.week = wr.week
                        AND ps.season = wr.season
                    WHERE wr.team_id = ?
                        AND wr.week = ?
                        AND wr.season = ?
                        AND wr.is_scoring = 1
                `, [matchup.team2_id, week, season]);
                
                // Update matchup with scoring totals
                await this.db.run(`
                    UPDATE matchups
                    SET team1_scoring_points = ?, team2_scoring_points = ?
                    WHERE matchup_id = ?
                `, [team1Total.total, team2Total.total, matchup.matchup_id]);
            }
            
            logInfo(`  ✓ Updated scoring totals for ${matchups.length} matchups`);
            
        } catch (error) {
            logError(`Error updating matchup scoring totals:`, error);
            throw error;
        }
    }

    /**
     * Get scoring players for a specific team/week
     */
    async getTeamScoringPlayers(teamId, week, season) {
        try {
            const scoringPlayers = await this.db.all(`
                SELECT 
                    wr.*,
                    ps.fantasy_points
                FROM weekly_rosters wr
                LEFT JOIN player_stats ps ON wr.player_id = ps.player_id
                    AND ps.week = wr.week
                    AND ps.season = wr.season
                WHERE wr.team_id = ?
                    AND wr.week = ?
                    AND wr.season = ?
                    AND wr.is_scoring = 1
                ORDER BY ps.fantasy_points DESC NULLS LAST
            `, [teamId, week, season]);
            
            return scoringPlayers;
            
        } catch (error) {
            logError(`Error getting scoring players for team ${teamId}:`, error);
            throw error;
        }
    }
}

module.exports = ScoringPlayersService;