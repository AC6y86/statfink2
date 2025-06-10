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
        await this.loadScoringRules();
        let points = 0;

        // Offensive scoring
        points += (playerStats.passing_yards || 0) * (this.scoringRules.passing_yards || 0);
        points += (playerStats.passing_tds || 0) * (this.scoringRules.passing_tds || 0);
        points += (playerStats.interceptions || 0) * (this.scoringRules.interceptions || 0);
        points += (playerStats.rushing_yards || 0) * (this.scoringRules.rushing_yards || 0);
        points += (playerStats.rushing_tds || 0) * (this.scoringRules.rushing_tds || 0);
        points += (playerStats.receiving_yards || 0) * (this.scoringRules.receiving_yards || 0);
        points += (playerStats.receiving_tds || 0) * (this.scoringRules.receiving_tds || 0);
        points += (playerStats.receptions || 0) * (this.scoringRules.receptions || 0);
        points += (playerStats.fumbles || 0) * (this.scoringRules.fumbles || 0);

        // Defensive scoring (DST)
        points += (playerStats.sacks || 0) * (this.scoringRules.sacks || 0);
        points += (playerStats.def_interceptions || 0) * (this.scoringRules.def_interceptions || 0);
        points += (playerStats.fumbles_recovered || 0) * (this.scoringRules.fumbles_recovered || 0);
        points += (playerStats.def_touchdowns || 0) * (this.scoringRules.def_touchdowns || 0);
        points += (playerStats.safeties || 0) * (this.scoringRules.safeties || 0);

        // Points allowed scoring for DST (tiered system)
        if (playerStats.points_allowed !== undefined && playerStats.points_allowed !== null) {
            if (playerStats.points_allowed === 0) points += 10;
            else if (playerStats.points_allowed <= 6) points += 7;
            else if (playerStats.points_allowed <= 13) points += 4;
            else if (playerStats.points_allowed <= 20) points += 1;
            else if (playerStats.points_allowed <= 27) points += 0;
            else if (playerStats.points_allowed <= 34) points -= 1;
            else points -= 4;
        }

        // Kicking scoring
        points += (playerStats.extra_points_made || 0) * (this.scoringRules.extra_points_made || 0);
        points += (playerStats.field_goals_0_39 || 0) * (this.scoringRules.field_goals_0_39 || 0);
        points += (playerStats.field_goals_40_49 || 0) * (this.scoringRules.field_goals_40_49 || 0);
        points += (playerStats.field_goals_50_plus || 0) * (this.scoringRules.field_goals_50_plus || 0);
        
        // Missed field goals penalty
        const missedFGs = (playerStats.field_goals_attempted || 0) - (playerStats.field_goals_made || 0);
        points += missedFGs * (this.scoringRules.field_goals_missed || 0);

        return Math.round(points * 100) / 100; // Round to 2 decimals
    }

    async calculateTeamScore(teamId, week, season) {
        const query = `
            SELECT SUM(ps.fantasy_points) as total_points
            FROM fantasy_rosters fr
            JOIN player_stats ps ON fr.player_id = ps.player_id
            WHERE fr.team_id = ? AND ps.week = ? AND ps.season = ?
            AND fr.roster_position = 'starter'
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