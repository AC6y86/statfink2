// Data validation utilities for fantasy football app

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
            errors.push('player_id is required and must be a string');
        }
        
        if (!player.name || typeof player.name !== 'string' || player.name.trim().length === 0) {
            errors.push('name is required and must be a non-empty string');
        }
        
        const validPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'Defense'];
        if (!player.position || !validPositions.includes(player.position)) {
            errors.push(`position must be one of: ${validPositions.join(', ')}`);
        }
        
        if (!player.team || typeof player.team !== 'string') {
            errors.push('team is required and must be a string');
        }
        
        if (player.bye_week !== null && player.bye_week !== undefined) {
            if (!Number.isInteger(player.bye_week) || player.bye_week < 1 || player.bye_week > 18) {
                errors.push('bye_week must be an integer between 1 and 18');
            }
        }
        
        if (errors.length > 0) {
            throw new ValidationError(`Player validation failed: ${errors.join(', ')}`);
        }
        
        return true;
    }
    
    static validateStats(stats) {
        const errors = [];
        
        if (!stats.player_id || typeof stats.player_id !== 'string') {
            errors.push('player_id is required');
        }
        
        if (!Number.isInteger(stats.week) || stats.week < 1 || stats.week > 18) {
            errors.push('week must be an integer between 1 and 18');
        }
        
        if (!Number.isInteger(stats.season) || stats.season < 2020 || stats.season > 2030) {
            errors.push('season must be a valid year');
        }
        
        // Validate numeric stats are non-negative
        const numericFields = [
            'passing_yards', 'passing_tds', 'rushing_yards', 'rushing_tds',
            'receiving_yards', 'receiving_tds', 'receptions', 'sacks',
            'def_interceptions', 'fumbles_recovered', 'def_touchdowns',
            'safeties', 'points_allowed', 'yards_allowed', 'field_goals_made',
            'field_goals_attempted', 'extra_points_made', 'extra_points_attempted'
        ];
        
        numericFields.forEach(field => {
            if (stats[field] !== undefined && stats[field] !== null) {
                if (!Number.isInteger(stats[field]) || stats[field] < 0) {
                    errors.push(`${field} must be a non-negative integer`);
                }
            }
        });
        
        // Special validation for negative stats
        const negativeFields = ['interceptions', 'fumbles'];
        negativeFields.forEach(field => {
            if (stats[field] !== undefined && stats[field] !== null) {
                if (!Number.isInteger(stats[field]) || stats[field] < 0) {
                    errors.push(`${field} must be a non-negative integer`);
                }
            }
        });
        
        if (errors.length > 0) {
            throw new ValidationError(`Stats validation failed: ${errors.join(', ')}`);
        }
        
        return true;
    }
    
    static validateTeam(team) {
        const errors = [];
        
        if (!team.team_name || typeof team.team_name !== 'string' || team.team_name.trim().length === 0) {
            errors.push('team_name is required and must be a non-empty string');
        }
        
        if (!team.owner_name || typeof team.owner_name !== 'string' || team.owner_name.trim().length === 0) {
            errors.push('owner_name is required and must be a non-empty string');
        }
        
        if (errors.length > 0) {
            throw new ValidationError(`Team validation failed: ${errors.join(', ')}`);
        }
        
        return true;
    }
    
    static validateMatchup(matchup) {
        const errors = [];
        
        if (!Number.isInteger(matchup.week) || matchup.week < 1 || matchup.week > 18) {
            errors.push('week must be an integer between 1 and 18');
        }
        
        if (!Number.isInteger(matchup.season) || matchup.season < 2020 || matchup.season > 2030) {
            errors.push('season must be a valid year');
        }
        
        if (!Number.isInteger(matchup.team1_id) || matchup.team1_id <= 0) {
            errors.push('team1_id must be a positive integer');
        }
        
        if (!Number.isInteger(matchup.team2_id) || matchup.team2_id <= 0) {
            errors.push('team2_id must be a positive integer');
        }
        
        if (matchup.team1_id === matchup.team2_id) {
            errors.push('team1_id and team2_id must be different');
        }
        
        if (errors.length > 0) {
            throw new ValidationError(`Matchup validation failed: ${errors.join(', ')}`);
        }
        
        return true;
    }
}

module.exports = { Validator, ValidationError };