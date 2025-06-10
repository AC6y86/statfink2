const { Validator, ValidationError } = require('../../server/database/validation');
const { samplePlayers, invalidPlayers, sampleStats, invalidStats } = require('../fixtures/sampleData');

describe('Validation', () => {
  describe('Player Validation', () => {
    test('should validate correct player data', () => {
      samplePlayers.forEach(player => {
        expect(() => Validator.validatePlayer(player)).not.toThrow();
      });
    });

    test('should reject invalid player data', () => {
      invalidPlayers.forEach(player => {
        expect(() => Validator.validatePlayer(player)).toThrow(ValidationError);
      });
    });

    test('should require player_id', () => {
      const invalidPlayer = { name: 'Test', position: 'QB', team: 'KC' };
      expect(() => Validator.validatePlayer(invalidPlayer)).toThrow('player_id is required');
    });

    test('should require valid position', () => {
      const invalidPlayer = { 
        player_id: 'TEST1', 
        name: 'Test', 
        position: 'INVALID', 
        team: 'KC' 
      };
      expect(() => Validator.validatePlayer(invalidPlayer)).toThrow('position must be one of');
    });

    test('should validate bye week range', () => {
      const invalidPlayer = { 
        player_id: 'TEST1', 
        name: 'Test', 
        position: 'QB', 
        team: 'KC',
        bye_week: 25
      };
      expect(() => Validator.validatePlayer(invalidPlayer)).toThrow('bye_week must be an integer between 1 and 18');
    });
  });

  describe('Stats Validation', () => {
    test('should validate correct stats data', () => {
      sampleStats.forEach(stats => {
        expect(() => Validator.validateStats(stats)).not.toThrow();
      });
    });

    test('should reject invalid stats data', () => {
      invalidStats.forEach(stats => {
        expect(() => Validator.validateStats(stats)).toThrow(ValidationError);
      });
    });

    test('should require valid week', () => {
      const invalidStats = { 
        player_id: 'TEST1', 
        week: 25, 
        season: 2024 
      };
      expect(() => Validator.validateStats(invalidStats)).toThrow('week must be an integer between 1 and 18');
    });

    test('should require valid season', () => {
      const invalidStats = { 
        player_id: 'TEST1', 
        week: 1, 
        season: 1990 
      };
      expect(() => Validator.validateStats(invalidStats)).toThrow('season must be a valid year');
    });

    test('should reject negative stats', () => {
      const invalidStats = { 
        player_id: 'TEST1', 
        week: 1, 
        season: 2024,
        passing_yards: -100
      };
      expect(() => Validator.validateStats(invalidStats)).toThrow('passing_yards must be a non-negative integer');
    });
  });

  describe('Team Validation', () => {
    test('should validate correct team data', () => {
      const validTeam = { team_name: 'Test Team', owner_name: 'Test Owner' };
      expect(() => Validator.validateTeam(validTeam)).not.toThrow();
    });

    test('should require team name', () => {
      const invalidTeam = { owner_name: 'Test Owner' };
      expect(() => Validator.validateTeam(invalidTeam)).toThrow('team_name is required');
    });

    test('should require owner name', () => {
      const invalidTeam = { team_name: 'Test Team' };
      expect(() => Validator.validateTeam(invalidTeam)).toThrow('owner_name is required');
    });

    test('should reject empty strings', () => {
      const invalidTeam = { team_name: '', owner_name: 'Test Owner' };
      expect(() => Validator.validateTeam(invalidTeam)).toThrow('team_name is required');
    });
  });

  describe('Matchup Validation', () => {
    test('should validate correct matchup data', () => {
      const validMatchup = {
        week: 1,
        season: 2024,
        team1_id: 1,
        team2_id: 2
      };
      expect(() => Validator.validateMatchup(validMatchup)).not.toThrow();
    });

    test('should reject same team matchup', () => {
      const invalidMatchup = {
        week: 1,
        season: 2024,
        team1_id: 1,
        team2_id: 1
      };
      expect(() => Validator.validateMatchup(invalidMatchup)).toThrow('team1_id and team2_id must be different');
    });

    test('should require valid week', () => {
      const invalidMatchup = {
        week: 25,
        season: 2024,
        team1_id: 1,
        team2_id: 2
      };
      expect(() => Validator.validateMatchup(invalidMatchup)).toThrow('week must be an integer between 1 and 18');
    });
  });
});