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
      
      // 300 * 0.04 + 3 * 4 + 1 * -2 + 20 * 0.1 + 1 * 6
      // = 12 + 12 - 2 + 2 + 6 = 30
      expect(points).toBe(30);
    });

    test('should calculate RB fantasy points correctly', async () => {
      const rbStats = {
        rushing_yards: 100,
        rushing_tds: 2,
        receiving_yards: 30,
        receiving_tds: 0,
        receptions: 3,
        fumbles: 1
      };

      const points = await scoringService.calculateFantasyPoints(rbStats);
      
      // 100 * 0.1 + 2 * 6 + 30 * 0.1 + 0 * 6 + 3 * 1 + 1 * -2
      // = 10 + 12 + 3 + 0 + 3 - 2 = 26
      expect(points).toBe(26);
    });

    test('should calculate DST fantasy points correctly', async () => {
      const dstStats = {
        sacks: 4,
        def_interceptions: 2,
        fumbles_recovered: 1,
        def_touchdowns: 1,
        safeties: 0,
        points_allowed: 7
      };

      const points = await scoringService.calculateFantasyPoints(dstStats);
      
      // 4 * 1 + 2 * 2 + 1 * 2 + 1 * 6 + 0 * 2 + 7 points allowed (7 bonus)
      // = 4 + 4 + 2 + 6 + 0 + 7 = 23
      // Note: 7 points allowed gets 7 bonus points in our tier system
      expect(points).toBe(20); // Actual calculation: 4+4+2+6+0+4 = 20 (since 7 points = +4 bonus)
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
      
      // 3 * 1 + 2 * 3 + 1 * 4 + 1 * 5 + 0 missed FGs
      // = 3 + 6 + 4 + 5 + 0 = 18
      expect(points).toBe(18);
    });

    test('should handle missing stats gracefully', async () => {
      const emptyStats = {};
      const points = await scoringService.calculateFantasyPoints(emptyStats);
      expect(points).toBe(0);
    });

    test('should apply points allowed tiers correctly', async () => {
      const testCases = [
        { points_allowed: 0, expected_bonus: 10 },
        { points_allowed: 6, expected_bonus: 7 },
        { points_allowed: 13, expected_bonus: 4 },
        { points_allowed: 20, expected_bonus: 1 },
        { points_allowed: 27, expected_bonus: 0 },
        { points_allowed: 34, expected_bonus: -1 },
        { points_allowed: 40, expected_bonus: -4 }
      ];

      for (const testCase of testCases) {
        const dstStats = { points_allowed: testCase.points_allowed };
        const points = await scoringService.calculateFantasyPoints(dstStats);
        expect(points).toBe(testCase.expected_bonus);
      }
    });
  });

  describe('validateLineup', () => {
    test('should validate correct starting lineup', () => {
      const validRoster = [
        { position: 'QB', roster_position: 'starter' },
        { position: 'RB', roster_position: 'starter' },
        { position: 'RB', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },
        { position: 'TE', roster_position: 'starter' },
        { position: 'K', roster_position: 'starter' },
        { position: 'DST', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' }, // FLEX
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

    test('should reject lineup with too many players', () => {
      const invalidRoster = [
        { position: 'QB', roster_position: 'starter' },
        { position: 'QB', roster_position: 'starter' }, // Too many QBs
        { position: 'RB', roster_position: 'starter' },
        { position: 'RB', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },
        { position: 'TE', roster_position: 'starter' },
        { position: 'K', roster_position: 'starter' },
        { position: 'DST', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' }
      ];

      expect(() => scoringService.validateLineup(invalidRoster)).toThrow(ValidationError);
      expect(() => scoringService.validateLineup(invalidRoster)).toThrow('Can have at most 1 QB');
    });

    test('should reject lineup with wrong total players', () => {
      const invalidRoster = [
        { position: 'QB', roster_position: 'starter' },
        { position: 'RB', roster_position: 'starter' },
        { position: 'WR', roster_position: 'starter' },
        { position: 'TE', roster_position: 'starter' }
        // Missing players
      ];

      expect(() => scoringService.validateLineup(invalidRoster)).toThrow('Starting lineup must have exactly 9 players');
    });
  });

  describe('calculateTeamScore', () => {
    test('should calculate team score from starter stats', async () => {
      mockDb.get.mockResolvedValue({ total_points: 145.5 });

      const score = await scoringService.calculateTeamScore(1, 1, 2024);

      expect(score).toBe(145.5);
      expect(mockDb.get).toHaveBeenCalledWith(
        expect.stringContaining('SUM(ps.fantasy_points)'),
        [1, 1, 2024]
      );
    });

    test('should return 0 for team with no stats', async () => {
      mockDb.get.mockResolvedValue(null);

      const score = await scoringService.calculateTeamScore(1, 1, 2024);

      expect(score).toBe(0);
    });
  });
});