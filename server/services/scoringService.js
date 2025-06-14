const { ValidationError } = require('../database/validation');

class ScoringService {
    constructor(db) {
        this.db = db;
        this.scoringRules = null;
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
        else if (passingYards >= 250) points += 9;
        else if (passingYards >= 175) points += 6;

        // Receiving (by any player) - tiered system
        const receivingYards = playerStats.receiving_yards || 0;
        if (receivingYards >= 200) points += 15;
        else if (receivingYards >= 150) points += 12;
        else if (receivingYards >= 100) points += 9;
        else if (receivingYards >= 75) points += 6;

        // Rushing (by any player) - tiered system
        const rushingYards = playerStats.rushing_yards || 0;
        if (rushingYards >= 200) points += 15;
        else if (rushingYards >= 150) points += 12;
        else if (rushingYards >= 100) points += 9;
        else if (rushingYards >= 75) points += 6;

        // Kicker scoring - fixed points regardless of distance
        points += (playerStats.field_goals_made || 0) * 2; // Field goals: 2 points (distance doesn't matter)
        points += (playerStats.extra_points_made || 0) * 0.5; // Extra points: 0.5 points

        // Team Defense (of the 16 teams drafted)
        if (playerStats.position === 'DST') {
            points += (playerStats.def_touchdowns || 0) * 8; // Touchdown scored: 8 points
            
            // Note: Defensive bonuses for "fewest points allowed" and "fewest yards allowed" 
            // need to be calculated weekly based on all drafted teams' performance
            // This requires a separate calculation method that compares all DST performances
            if (playerStats.def_points_allowed_rank === 1) {
                points += 5; // Least points allowed: 5 points
            }
            if (playerStats.def_yards_allowed_rank === 1) {
                points += 5; // Least yards allowed: 5 points
            }
        }

        // Kick or Punt returner
        points += (playerStats.return_tds || 0) * 20; // Touchdown scored: 20 points

        // Negative points for turnovers
        points -= (playerStats.interceptions || 0) * 2; // Interceptions thrown
        // Note: Fumbles lost have no penalty (0 points) per scoring guide

        return Math.round(points * 100) / 100; // Round to 2 decimals
    }

    async calculateTeamScore(teamId, week, season) {
        const query = `
            SELECT SUM(ps.fantasy_points) as total_points
            FROM fantasy_rosters fr
            JOIN player_stats ps ON fr.player_id = ps.player_id
            WHERE fr.team_id = ? AND ps.week = ? AND ps.season = ?
            AND fr.roster_position = 'starter'
            AND fr.roster_position != 'injured_reserve'
        `;
        
        const result = await this.db.get(query, [teamId, week, season]);
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
        // Get all DST performances for the week from drafted teams
        const query = `
            SELECT ps.player_id, ps.points_allowed, ps.yards_allowed, p.team
            FROM player_stats ps
            JOIN nfl_players p ON ps.player_id = p.player_id
            WHERE ps.week = ? AND ps.season = ? AND p.position = 'DST'
            AND ps.player_id IN (
                SELECT DISTINCT player_id FROM fantasy_rosters
            )
            ORDER BY ps.points_allowed ASC, ps.yards_allowed ASC
        `;
        
        const dstStats = await this.db.all(query, [week, season]);
        
        if (dstStats.length === 0) return;

        // Calculate rankings for points allowed
        let pointsRank = 1;
        let yardsRank = 1;
        
        // Sort by points allowed and assign ranks
        const pointsSorted = [...dstStats].sort((a, b) => a.points_allowed - b.points_allowed);
        pointsSorted.forEach((stat, index) => {
            stat.def_points_allowed_rank = index + 1;
        });

        // Sort by yards allowed and assign ranks
        const yardsSorted = [...dstStats].sort((a, b) => a.yards_allowed - b.yards_allowed);
        yardsSorted.forEach((stat, index) => {
            stat.def_yards_allowed_rank = index + 1;
        });

        // Update the database with rankings
        for (const stat of dstStats) {
            await this.db.run(`
                UPDATE player_stats 
                SET def_points_allowed_rank = ?, def_yards_allowed_rank = ?
                WHERE player_id = ? AND week = ? AND season = ?
            `, [stat.def_points_allowed_rank, stat.def_yards_allowed_rank, stat.player_id, week, season]);
        }
    }
}

module.exports = ScoringService;