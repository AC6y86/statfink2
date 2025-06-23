const { ValidationError } = require('../database/validation');

class ScoringService {
    constructor(db, nflGamesService = null) {
        this.db = db;
        this.nflGamesService = nflGamesService;
        this.scoringRules = null;
    }
    
    setNFLGamesService(nflGamesService) {
        this.nflGamesService = nflGamesService;
    }

    async loadScoringRules() {
        if (!this.scoringRules) {
            const rules = await this.db.getScoringRules();
            this.scoringRules = {};
            rules.forEach(rule => {
                this.scoringRules[rule.stat_type] = rule.points_per_unit;
            });
        }
        return this.scoringRules;
    }

    async calculateFantasyPoints(playerStats) {
        if (!playerStats) {
            return 0;
        }
        
        let points = 0;

        // Touchdown scoring (any player)
        points += (playerStats.passing_tds || 0) * 5; // Touchdown Pass: 5 points
        points += (playerStats.rushing_tds || 0) * 8; // Touchdown Scored: 8 points
        points += (playerStats.receiving_tds || 0) * 8; // Touchdown Scored: 8 points

        // Two Point Conversions (any player)
        points += (playerStats.two_point_conversions_pass || 0) * 2; // Two Point Conversion Pass: 2 points
        points += (playerStats.two_point_conversions_run || 0) * 2; // Two Point Conversion Scored: 2 points
        points += (playerStats.two_point_conversions_rec || 0) * 2; // Two Point Conversion Scored: 2 points

        // Quarterback (or any player) passing yards - tiered system
        const passingYards = playerStats.passing_yards || 0;
        if (passingYards >= 400) points += 15;
        else if (passingYards >= 325) points += 12;
        else if (passingYards >= 250) points += 9;  // Per SCORING_SYSTEM.md
        else if (passingYards >= 175) points += 6;

        // Receiving (by any player) - tiered system
        const receivingYards = playerStats.receiving_yards || 0;
        if (receivingYards >= 200) points += 15;
        else if (receivingYards >= 150) points += 12;
        else if (receivingYards >= 100) points += 9;
        else if (receivingYards >= 75) points += 6;
        else if (receivingYards >= 50) points += 3;

        // Rushing (by any player) - tiered system
        const rushingYards = playerStats.rushing_yards || 0;
        if (rushingYards >= 200) points += 15;
        else if (rushingYards >= 150) points += 12;
        else if (rushingYards >= 100) points += 9;
        else if (rushingYards >= 75) points += 6;
        else if (rushingYards >= 50) points += 3;

        // Kicker scoring - fixed points regardless of distance
        points += (playerStats.field_goals_made || 0) * 2; // Field goals: 2 points (distance doesn't matter)
        points += (playerStats.extra_points_made || 0) * 0.5; // Extra points: 0.5 points

        // Team Defense (of the 16 teams drafted)
        if (playerStats.position === 'DST' || playerStats.position === 'DEF') {
            // Defensive touchdowns: 8 points each
            points += (playerStats.def_int_return_tds || 0) * 8; // Interception return TDs
            points += (playerStats.def_fumble_return_tds || 0) * 8; // Fumble return TDs
            points += (playerStats.def_blocked_return_tds || 0) * 8; // Blocked punt/kick return TDs
            
            // Safeties: 2 points each
            points += (playerStats.safeties || 0) * 2; // Safeties
            
            // No fallback to def_touchdowns since it's unreliable from Tank01 API
            // All defensive TDs should come from our specific breakdown fields
            
            // Defensive bonuses are stored as fractional values when there are ties
            // e.g., if 2 teams tie for fewest points, each gets 2.5 points
            points += (playerStats.def_points_bonus || 0); // Fewest points allowed bonus (5 points split among ties)
            points += (playerStats.def_yards_bonus || 0); // Fewest yards allowed bonus (5 points split among ties)
        }

        // Special teams return touchdowns for individual players: 20 points each
        points += (playerStats.kick_return_tds || 0) * 20; // Kickoff return TDs
        points += (playerStats.punt_return_tds || 0) * 20; // Punt return TDs
        
        // Legacy return TDs field (fallback)
        points += (playerStats.return_tds || 0) * 20; // Legacy return TDs

        return Math.round(points * 100) / 100; // Round to 2 decimals
    }

    async calculateTeamScore(teamId, week, season) {
        const query = `
            SELECT SUM(ps.fantasy_points) as total_points
            FROM weekly_rosters wr
            JOIN player_stats ps ON wr.player_id = ps.player_id
            WHERE wr.team_id = ? AND ps.week = ? AND ps.season = ?
            AND wr.week = ? AND wr.season = ?
            AND wr.roster_position = 'active'
        `;
        
        const result = await this.db.get(query, [teamId, week, season, week, season]);
        return result?.total_points || 0;
    }

    async getPlayerProjections(playerId, week, season) {
        // Get last 3 weeks of stats for projection
        const recentStats = await this.db.all(`
            SELECT * FROM player_stats 
            WHERE player_id = ? AND season = ? AND week < ? 
            ORDER BY week DESC LIMIT 3
        `, [playerId, season, week]);

        if (recentStats.length === 0) return 0;

        // Simple average projection
        const avgPoints = recentStats.reduce((sum, stat) => sum + stat.fantasy_points, 0) / recentStats.length;
        return Math.round(avgPoints * 100) / 100;
    }

    async getWeeklyRankings(week, season, position = null) {
        let query = `
            SELECT p.name, p.position, p.team, ps.fantasy_points
            FROM player_stats ps
            JOIN nfl_players p ON ps.player_id = p.player_id
            WHERE ps.week = ? AND ps.season = ?
        `;
        const params = [week, season];

        if (position) {
            query += ' AND p.position = ?';
            params.push(position);
        }

        query += ' ORDER BY ps.fantasy_points DESC';

        return this.db.all(query, params);
    }

    validateLineup(roster) {
        const positionCounts = {};
        const starters = roster.filter(player => player.roster_position === 'starter');

        // Count positions
        starters.forEach(player => {
            positionCounts[player.position] = (positionCounts[player.position] || 0) + 1;
        });

        const errors = [];

        // Core requirements (minimum required positions)
        const coreRequirements = {
            QB: 1,      // 1 each Quarterback
            RB: 4,      // 4 each Running Backs
            K: 1,       // 1 each Kicker
            DST: 2      // 2 each Team Defense (points + yards allowed)
        };

        // Check core position requirements
        Object.entries(coreRequirements).forEach(([position, required]) => {
            const count = positionCounts[position] || 0;
            if (count < required) {
                errors.push(`Need at least ${required} ${position}, currently have ${count}`);
            }
        });

        // Check WR/TE combined requirement (3 each Wide Receivers or Tight Ends)
        const wrTeCount = (positionCounts['WR'] || 0) + (positionCounts['TE'] || 0);
        if (wrTeCount < 3) {
            errors.push(`Need at least 3 Wide Receivers or Tight Ends combined, currently have ${wrTeCount}`);
        }

        // Total lineup size should be: 1 QB + 4 RB + 3 WR/TE + 1 K + 2 DST + 2 Bonus = 13
        const totalStarters = starters.length;
        if (totalStarters !== 13) {
            errors.push(`Starting lineup must have exactly 13 players, currently has ${totalStarters}`);
        }

        if (errors.length > 0) {
            throw new ValidationError(`Lineup validation failed: ${errors.join(', ')}`);
        }

        return true;
    }

    async calculateDefensiveBonuses(week, season) {
        // Check if all games for the week are complete
        if (this.nflGamesService) {
            const completion = await this.nflGamesService.areAllWeekGamesComplete(week, season);
            if (!completion.isComplete) {
                console.log(`[WARNING] Not all games complete for Week ${week}, ${season}. ` +
                    `${completion.completedGames}/${completion.totalGames} games finished. ` +
                    `Skipping defensive bonus calculation.`);
                return {
                    success: false,
                    message: 'Not all games complete',
                    completion
                };
            }
        }
        
        // Get all DST performances for the week from drafted teams
        const query = `
            SELECT ps.player_id, ps.points_allowed, ps.yards_allowed, p.team
            FROM player_stats ps
            JOIN nfl_players p ON ps.player_id = p.player_id
            WHERE ps.week = ? AND ps.season = ? AND p.position = 'DST'
            AND ps.player_id IN (
                SELECT DISTINCT player_id FROM weekly_rosters
                WHERE week = ? AND season = ?
            )
            ORDER BY ps.points_allowed ASC, ps.yards_allowed ASC
        `;
        
        const dstStats = await this.db.all(query, [week, season, week, season]);
        
        if (dstStats.length === 0) return;

        // Sort by points allowed
        const pointsSorted = [...dstStats].sort((a, b) => a.points_allowed - b.points_allowed);
        
        // Find the lowest points allowed and count ties
        const lowestPoints = pointsSorted[0].points_allowed;
        const pointsTiedCount = pointsSorted.filter(s => s.points_allowed === lowestPoints).length;
        const pointsBonus = 5 / pointsTiedCount; // Split 5 points among tied teams
        
        // Sort by yards allowed
        const yardsSorted = [...dstStats].sort((a, b) => a.yards_allowed - b.yards_allowed);
        
        // Find the lowest yards allowed and count ties
        const lowestYards = yardsSorted[0].yards_allowed;
        const yardsTiedCount = yardsSorted.filter(s => s.yards_allowed === lowestYards).length;
        const yardsBonus = 5 / yardsTiedCount; // Split 5 points among tied teams
        
        // Assign rankings and bonuses
        let currentPointsRank = 1;
        let currentYardsRank = 1;
        
        // Process points allowed rankings
        for (let i = 0; i < pointsSorted.length; i++) {
            if (i > 0 && pointsSorted[i].points_allowed !== pointsSorted[i-1].points_allowed) {
                currentPointsRank = i + 1;
            }
            pointsSorted[i].def_points_allowed_rank = currentPointsRank;
            pointsSorted[i].def_points_bonus = pointsSorted[i].points_allowed === lowestPoints ? pointsBonus : 0;
        }
        
        // Process yards allowed rankings
        for (let i = 0; i < yardsSorted.length; i++) {
            if (i > 0 && yardsSorted[i].yards_allowed !== yardsSorted[i-1].yards_allowed) {
                currentYardsRank = i + 1;
            }
            yardsSorted[i].def_yards_allowed_rank = currentYardsRank;
            yardsSorted[i].def_yards_bonus = yardsSorted[i].yards_allowed === lowestYards ? yardsBonus : 0;
        }

        // Update the database with rankings and bonuses
        for (const stat of dstStats) {
            await this.db.run(`
                UPDATE player_stats 
                SET def_points_allowed_rank = ?, 
                    def_yards_allowed_rank = ?,
                    def_points_bonus = ?,
                    def_yards_bonus = ?
                WHERE player_id = ? AND week = ? AND season = ?
            `, [
                stat.def_points_allowed_rank, 
                stat.def_yards_allowed_rank,
                stat.def_points_bonus || 0,
                stat.def_yards_bonus || 0,
                stat.player_id, 
                week, 
                season
            ]);
        }
        
        return {
            success: true,
            message: `Calculated defensive bonuses for ${dstStats.length} DST teams`,
            teamsProcessed: dstStats.length
        };
    }
}

module.exports = ScoringService;