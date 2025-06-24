const ScoringService = require('../../server/services/scoringService');
const { ValidationError } = require('../../server/database/validation');

// Mock database
const mockDb = {
  getScoringRules: jest.fn().mockResolvedValue([
    { stat_type: 'passing_yards', points_per_unit: 0.04 },
    { stat_type: 'passing_tds', points_per_unit: 4 },
    { stat_type: 'interceptions', points_per_unit: -2 },
    { stat_type: 'rushing_yards', points_per_unit: 0.1 },
    { stat_type: 'rushing_tds', points_per_unit: 6 },
    { stat_type: 'receiving_yards', points_per_unit: 0.1 },
    { stat_type: 'receiving_tds', points_per_unit: 6 },
    { stat_type: 'receptions', points_per_unit: 1 },
    { stat_type: 'fumbles', points_per_unit: -2 },
    { stat_type: 'sacks', points_per_unit: 1 },
    { stat_type: 'def_interceptions', points_per_unit: 2 },
    { stat_type: 'fumbles_recovered', points_per_unit: 2 },
    { stat_type: 'def_touchdowns', points_per_unit: 6 },
    { stat_type: 'safeties', points_per_unit: 2 },
    { stat_type: 'extra_points_made', points_per_unit: 1 },
    { stat_type: 'field_goals_0_39', points_per_unit: 3 },
    { stat_type: 'field_goals_40_49', points_per_unit: 4 },
    { stat_type: 'field_goals_50_plus', points_per_unit: 5 },
    { stat_type: 'field_goals_missed', points_per_unit: -1 }
  ]),
  get: jest.fn(),
  all: jest.fn()
};

describe('ScoringService', () => {
  let scoringService;

  beforeEach(() => {
    scoringService = new ScoringService(mockDb);
    jest.clearAllMocks();
  });

  describe('calculateFantasyPoints', () => {
    test('should calculate QB fantasy points correctly', async () => {
      const qbStats = {
        passing_yards: 300,
        passing_tds: 3,
        interceptions: 1,
        rushing_yards: 20,
        rushing_tds: 1
      };

      const points = await scoringService.calculateFantasyPoints(qbStats);
      
      // Passing TDs: 3 * 5 = 15, Rushing TDs: 1 * 8 = 8, Passing yards 300 (250-324) = 9, Rushing yards 20 (< 75) = 0
      // = 15 + 8 + 9 + 0 = 32
      expect(points).toBe(32);
    });

    test('should calculate RB fantasy points correctly', async () => {
      const rbStats = {
        rushing_yards: 100,
        rushing_tds: 2,
        receiving_yards: 30,
        receiving_tds: 0,
        receptions: 3,
        fumbles_lost: 1
      };

      const points = await scoringService.calculateFantasyPoints(rbStats);
      
      // Rushing TDs: 2 * 8 = 16, Rushing yards 100 (100-149) = 9, Receiving yards 30 (< 75) = 0
      // Total: 16 + 9 + 0 = 25 points
      expect(points).toBe(25);
    });

    test('should calculate DST fantasy points correctly', async () => {
      const dstStats = {
        position: 'DST',
        sacks: 4,
        def_interceptions: 2,
        fumbles_recovered: 1,
        def_touchdowns: 1,
        def_int_return_tds: 1,  // Defensive TD breakdown
        safeties: 0,
        points_allowed: 7,
        def_points_bonus: 0,    // Not rank 1 for points allowed
        def_yards_bonus: 5      // Rank 1 for yards allowed gets full 5 points
      };

      const points = await scoringService.calculateFantasyPoints(dstStats);
      
      // def_touchdowns * 8 = 8 points + def_yards_bonus = 5 points
      // def_points_bonus = 0 (not rank 1)
      expect(points).toBe(13);
    });

    test('should calculate kicker fantasy points correctly', async () => {
      const kStats = {
        extra_points_made: 3,
        field_goals_0_39: 2,
        field_goals_40_49: 1,
        field_goals_50_plus: 1,
        field_goals_attempted: 4,
        field_goals_made: 4
      };

      const points = await scoringService.calculateFantasyPoints(kStats);
      
      // Current scoring: field_goals_made * 2 + extra_points_made * 0.5
      // = 4 * 2 + 3 * 0.5 = 8 + 1.5 = 9.5
      expect(points).toBe(9.5);
    });

    test('should handle missing stats gracefully', async () => {
      const emptyStats = {};
      const points = await scoringService.calculateFantasyPoints(emptyStats);
      expect(points).toBe(0);
    });

    test('should apply defensive ranking bonuses correctly', async () => {
      const testCases = [
        { def_points_bonus: 5, def_yards_bonus: 5, expected_total: 10 }, // Both rank 1
        { def_points_bonus: 5, def_yards_bonus: 0, expected_total: 5 }, // Points rank 1 only
        { def_points_bonus: 0, def_yards_bonus: 5, expected_total: 5 }, // Yards rank 1 only
        { def_points_bonus: 0, def_yards_bonus: 0, expected_total: 0 }, // Neither rank 1
        { def_points_bonus: 2.5, def_yards_bonus: 2.5, expected_total: 5 }  // Tie scenario
      ];

      for (const testCase of testCases) {
        const dstStats = { 
          position: 'DST', 
          def_points_bonus: testCase.def_points_bonus,
          def_yards_bonus: testCase.def_yards_bonus
        };
        const points = await scoringService.calculateFantasyPoints(dstStats);
        expect(points).toBe(testCase.expected_total);
      }
    });
  });

  describe('validateLineup', () => {
    test('should validate correct starting lineup', () => {
      const validRoster = [
        { position: 'QB', roster_position: 'starter' },      // 1 QB
        { position: 'RB', roster_position: 'starter' },      // 4 RBs
        { position: 'RB', roster_position: 'starter' },
        { position: 'RB', roster_position: 'starter' },
        { position: 'RB', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },      // 3 WR/TE combined
        { position: 'WR', roster_position: 'starter' },
        { position: 'TE', roster_position: 'starter' },
        { position: 'K', roster_position: 'starter' },       // 1 K
        { position: 'DST', roster_position: 'starter' },     // 2 DST
        { position: 'DST', roster_position: 'starter' },
        { position: 'QB', roster_position: 'starter' },      // 2 Bonus players (any position)
        { position: 'RB', roster_position: 'starter' },
        { position: 'RB', roster_position: 'bench' },
        { position: 'WR', roster_position: 'bench' }
      ];

      expect(() => scoringService.validateLineup(validRoster)).not.toThrow();
    });

    test('should reject lineup with missing QB', () => {
      const invalidRoster = [
        { position: 'RB', roster_position: 'starter' },
        { position: 'RB', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },
        { position: 'TE', roster_position: 'starter' },
        { position: 'K', roster_position: 'starter' },
        { position: 'DST', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' }
      ];

      expect(() => scoringService.validateLineup(invalidRoster)).toThrow(ValidationError);
      expect(() => scoringService.validateLineup(invalidRoster)).toThrow('Need at least 1 QB');
    });

    test('should reject lineup with insufficient RBs', () => {
      const invalidRoster = [
        { position: 'QB', roster_position: 'starter' },
        { position: 'RB', roster_position: 'starter' },
        { position: 'RB', roster_position: 'starter' },
        { position: 'RB', roster_position: 'starter' }, // Only 3 RBs instead of 4
        { position: 'WR', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },
        { position: 'TE', roster_position: 'starter' },
        { position: 'K', roster_position: 'starter' },
        { position: 'DST', roster_position: 'starter' },
        { position: 'DST', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },
        { position: 'TE', roster_position: 'starter' }
      ];

      expect(() => scoringService.validateLineup(invalidRoster)).toThrow(ValidationError);
      expect(() => scoringService.validateLineup(invalidRoster)).toThrow('Need at least 4 RB');
    });

    test('should reject lineup with wrong total players', () => {
      const invalidRoster = [
        { position: 'QB', roster_position: 'starter' },
        { position: 'RB', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },
        { position: 'TE', roster_position: 'starter' }
        // Missing players
      ];

      expect(() => scoringService.validateLineup(invalidRoster)).toThrow('Starting lineup must have exactly 13 players');
    });
  });

  describe('calculateTeamScore', () => {
    test('should calculate team score from starter stats', async () => {
      mockDb.get.mockResolvedValue({ total_points: 145.5 });

      const score = await scoringService.calculateTeamScore(1, 1, 2024);

      expect(score).toBe(145.5);
      expect(mockDb.get).toHaveBeenCalledWith(
        expect.stringContaining('SUM(ps.fantasy_points)'),
        [1, 1, 2024, 1, 2024]
      );
    });

    test('should return 0 for team with no stats', async () => {
      mockDb.get.mockResolvedValue(null);

      const score = await scoringService.calculateTeamScore(1, 1, 2024);

      expect(score).toBe(0);
    });
  });
});