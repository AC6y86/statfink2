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

        // Touchdown scoring
        const totalTDs = (playerStats.passing_tds || 0) + (playerStats.rushing_tds || 0) + (playerStats.receiving_tds || 0);
        points += (playerStats.passing_tds || 0) * 5; // Touchdown Pass: 5 points
        points += ((playerStats.rushing_tds || 0) + (playerStats.receiving_tds || 0)) * 8; // Touchdown Scored: 8 points

        // Two Point Conversions
        points += (playerStats.two_point_conversions_pass || 0) * 2; // Two Point Conversion Pass: 2 points
        points += (playerStats.two_point_conversions_run || 0) * 2; // Two Point Conversion Scored: 2 points

        // Passing Yards (tiered system)
        const passingYards = playerStats.passing_yards || 0;
        if (passingYards >= 400) points += 15;
        else if (passingYards >= 325) points += 12;
        else if (passingYards >= 250) points += 9;
        else if (passingYards >= 175) points += 6;

        // Receiving Yards (tiered system) 
        const receivingYards = playerStats.receiving_yards || 0;
        if (receivingYards >= 200) points += 15;
        else if (receivingYards >= 150) points += 12;
        else if (receivingYards >= 100) points += 9;
        else if (receivingYards >= 75) points += 6;

        // Rushing Yards (tiered system)
        const rushingYards = playerStats.rushing_yards || 0;
        if (rushingYards >= 200) points += 15;
        else if (rushingYards >= 150) points += 12;
        else if (rushingYards >= 100) points += 9;
        else if (rushingYards >= 75) points += 6;

        // Kicker scoring
        points += (playerStats.field_goals_made || 0) * 2; // Field goals: 2 points
        points += (playerStats.extra_points_made || 0) * 0.5; // Extra points: 0.5 points

        // Team Defense scoring
        if (playerStats.position === 'DST') {
            points += (playerStats.def_touchdowns || 0) * 8; // Touchdown scored: 8 points
            
            // Defensive bonuses (least points/yards allowed among 16 teams)
            // This would need to be calculated weekly based on all team performances
            // For now, using placeholder logic
            if (playerStats.points_allowed !== undefined && playerStats.points_allowed <= 6) {
                points += 5; // Least points allowed bonus
            }
            if (playerStats.yards_allowed !== undefined && playerStats.yards_allowed <= 250) {
                points += 5; // Least yards allowed bonus  
            }
        }

        // Kick/Punt Return TDs
        points += (playerStats.return_tds || 0) * 20; // Kick or Punt returner touchdown: 20 points

        // Negative points for turnovers
        points -= (playerStats.interceptions || 0) * 2; // Interceptions thrown
        points -= (playerStats.fumbles_lost || 0) * 2; // Fumbles lost

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

        // Standard lineup requirements
        const requirements = {
            QB: { min: 1, max: 1 },
            RB: { min: 2, max: 3 },
            WR: { min: 2, max: 4 },
            TE: { min: 1, max: 2 },
            K: { min: 1, max: 1 },
            DST: { min: 1, max: 1 }
        };

        const errors = [];

        Object.entries(requirements).forEach(([position, req]) => {
            const count = positionCounts[position] || 0;
            if (count < req.min) {
                errors.push(`Need at least ${req.min} ${position}, currently have ${count}`);
            }
            if (count > req.max) {
                errors.push(`Can have at most ${req.max} ${position}, currently have ${count}`);
            }
        });

        const totalStarters = starters.length;
        if (totalStarters !== 9) { // Standard starting lineup size
            errors.push(`Starting lineup must have exactly 9 players, currently has ${totalStarters}`);
        }

        if (errors.length > 0) {
            throw new ValidationError(`Lineup validation failed: ${errors.join(', ')}`);
        }

        return true;
    }
}

module.exports = ScoringService;