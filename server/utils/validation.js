// Input validation utilities for fantasy football app

class ValidationError extends Error {
    constructor(message, field = null) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
    }
}

class Validator {
    static validatePlayer(player) {
        const errors = [];
        
        if (!player.player_id || typeof player.player_id !== 'string') {
            errors.push('Player ID is required and must be a string');
        }
        
        if (!player.name || typeof player.name !== 'string' || player.name.trim().length < 2) {
            errors.push('Player name is required and must be at least 2 characters');
        }
        
        const validPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
        if (!player.position || !validPositions.includes(player.position)) {
            errors.push(`Position must be one of: ${validPositions.join(', ')}`);
        }
        
        if (!player.team || typeof player.team !== 'string' || player.team.length < 2) {
            errors.push('Team is required and must be at least 2 characters');
        }
        
        if (player.bye_week !== null && player.bye_week !== undefined) {
            const byeWeek = parseInt(player.bye_week);
            if (isNaN(byeWeek) || byeWeek < 1 || byeWeek > 18) {
                errors.push('Bye week must be between 1 and 18');
            }
        }
        
        if (errors.length > 0) {
            throw new ValidationError(`Player validation failed: ${errors.join(', ')}`);
        }
        
        return true;
    }
    
    static validatePlayerStats(stats) {
        const errors = [];
        
        if (!stats.player_id || typeof stats.player_id !== 'string') {
            errors.push('Player ID is required');
        }
        
        const week = parseInt(stats.week);
        if (isNaN(week) || week < 1 || week > 18) {
            errors.push('Week must be between 1 and 18');
        }
        
        const season = parseInt(stats.season);
        if (isNaN(season) || season < 2020 || season > 2030) {
            errors.push('Season must be between 2020 and 2030');
        }
        
        // Validate numeric stats (should be non-negative)
        const numericStats = [
            'passing_yards', 'passing_tds', 'rushing_yards', 'rushing_tds',
            'receiving_yards', 'receiving_tds', 'receptions', 'sacks',
            'def_interceptions', 'fumbles_recovered', 'def_touchdowns',
            'safeties', 'points_allowed', 'yards_allowed', 'field_goals_made',
            'field_goals_attempted', 'extra_points_made', 'extra_points_attempted',
            'field_goals_0_39', 'field_goals_40_49', 'field_goals_50_plus'
        ];
        
        for (const stat of numericStats) {
            if (stats[stat] !== undefined && stats[stat] !== null) {
                const value = parseInt(stats[stat]);
                if (isNaN(value) || value < 0) {
                    errors.push(`${stat} must be a non-negative number`);
                }
            }
        }
        
        // Negative stats can be negative
        const negativeStats = ['interceptions', 'fumbles'];
        for (const stat of negativeStats) {
            if (stats[stat] !== undefined && stats[stat] !== null) {
                const value = parseInt(stats[stat]);
                if (isNaN(value)) {
                    errors.push(`${stat} must be a number`);
                }
            }
        }
        
        // Fantasy points can be negative
        if (stats.fantasy_points !== undefined && stats.fantasy_points !== null) {
            const value = parseFloat(stats.fantasy_points);
            if (isNaN(value)) {
                errors.push('Fantasy points must be a number');
            }
        }
        
        if (errors.length > 0) {
            throw new ValidationError(`Player stats validation failed: ${errors.join(', ')}`);
        }
        
        return true;
    }
    
    static validateTeam(team) {
        const errors = [];
        
        if (!team.team_name || typeof team.team_name !== 'string' || team.team_name.trim().length < 2) {
            errors.push('Team name is required and must be at least 2 characters');
        }
        
        if (!team.owner_name || typeof team.owner_name !== 'string' || team.owner_name.trim().length < 2) {
            errors.push('Owner name is required and must be at least 2 characters');
        }
        
        if (team.total_points !== undefined && team.total_points !== null) {
            const points = parseFloat(team.total_points);
            if (isNaN(points)) {
                errors.push('Total points must be a number');
            }
        }
        
        const recordStats = ['wins', 'losses', 'ties'];
        for (const stat of recordStats) {
            if (team[stat] !== undefined && team[stat] !== null) {
                const value = parseInt(team[stat]);
                if (isNaN(value) || value < 0) {
                    errors.push(`${stat} must be a non-negative number`);
                }
            }
        }
        
        if (errors.length > 0) {
            throw new ValidationError(`Team validation failed: ${errors.join(', ')}`);
        }
        
        return true;
    }
    
    static validateRosterMove(teamId, playerId, rosterPosition) {
        const errors = [];
        
        const teamIdNum = parseInt(teamId);
        if (isNaN(teamIdNum) || teamIdNum < 1) {
            errors.push('Team ID must be a positive number');
        }
        
        if (!playerId || typeof playerId !== 'string') {
            errors.push('Player ID is required');
        }
        
        const validPositions = ['starter', 'injured_reserve'];
        if (rosterPosition && !validPositions.includes(rosterPosition)) {
            errors.push(`Roster position must be one of: ${validPositions.join(', ')}`);
        }
        
        if (errors.length > 0) {
            throw new ValidationError(`Roster move validation failed: ${errors.join(', ')}`);
        }
        
        return true;
    }
    
    static validateMatchup(matchup) {
        const errors = [];
        
        const week = parseInt(matchup.week);
        if (isNaN(week) || week < 1 || week > 18) {
            errors.push('Week must be between 1 and 18');
        }
        
        const season = parseInt(matchup.season);
        if (isNaN(season) || season < 2020 || season > 2030) {
            errors.push('Season must be between 2020 and 2030');
        }
        
        const team1Id = parseInt(matchup.team1_id);
        const team2Id = parseInt(matchup.team2_id);
        
        if (isNaN(team1Id) || team1Id < 1) {
            errors.push('Team 1 ID must be a positive number');
        }
        
        if (isNaN(team2Id) || team2Id < 1) {
            errors.push('Team 2 ID must be a positive number');
        }
        
        if (team1Id === team2Id) {
            errors.push('A team cannot play against itself');
        }
        
        if (matchup.team1_points !== undefined && matchup.team1_points !== null) {
            const points = parseFloat(matchup.team1_points);
            if (isNaN(points) || points < 0) {
                errors.push('Team 1 points must be a non-negative number');
            }
        }
        
        if (matchup.team2_points !== undefined && matchup.team2_points !== null) {
            const points = parseFloat(matchup.team2_points);
            if (isNaN(points) || points < 0) {
                errors.push('Team 2 points must be a non-negative number');
            }
        }
        
        if (errors.length > 0) {
            throw new ValidationError(`Matchup validation failed: ${errors.join(', ')}`);
        }
        
        return true;
    }
    
    static validateWeekSeason(week, season) {
        const errors = [];
        
        const weekNum = parseInt(week);
        if (isNaN(weekNum) || weekNum < 1 || weekNum > 18) {
            errors.push('Week must be between 1 and 18');
        }
        
        const seasonNum = parseInt(season);
        if (isNaN(seasonNum) || seasonNum < 2020 || seasonNum > 2030) {
            errors.push('Season must be between 2020 and 2030');
        }
        
        if (errors.length > 0) {
            throw new ValidationError(`Week/Season validation failed: ${errors.join(', ')}`);
        }
        
        return true;
    }
    
    // Sanitize string inputs
    static sanitizeString(str, maxLength = 255) {
        if (typeof str !== 'string') return '';
        return str.trim().substring(0, maxLength);
    }
    
    // Sanitize numeric inputs
    static sanitizeNumber(num, defaultValue = 0) {
        const parsed = parseInt(num);
        return isNaN(parsed) ? defaultValue : parsed;
    }
    
    static sanitizeFloat(num, defaultValue = 0.0) {
        const parsed = parseFloat(num);
        return isNaN(parsed) ? defaultValue : parsed;
    }
}

module.exports = {
    Validator,
    ValidationError
};