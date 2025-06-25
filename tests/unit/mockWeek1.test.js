/**
 * Mock Week 1 Tests
 * Tests for Pre-Game State (No Games Started)
 */

// Using Jest's built-in expect
const { getMockWeek } = require('../mockWeeks');

describe('Mock Week 1 - Pre-Game State', () => {
  let week1Data;

  beforeAll(() => {
    // Load week 1 data
    week1Data = getMockWeek(1);
  });

  describe('Mock Data Structure', () => {
    it('should have all required data sections', () => {
      expect(week1Data).toBeDefined();
      expect(week1Data.games).toBeDefined();
      expect(week1Data.playerStats).toBeDefined();
      expect(week1Data.dstStats).toBeDefined();
      expect(week1Data.metadata).toBeDefined();
    });

    it('should have 16 games', () => {
      expect(week1Data.games).toHaveLength(16);
    });

    it('should have all games in Scheduled status', () => {
      week1Data.games.forEach(game => {
        expect(game.status).toBe('Scheduled');
        expect(game.home_score).toBe(0);
        expect(game.away_score).toBe(0);
        expect(game.quarter).toBeNull();
        expect(game.time_remaining).toBeNull();
      });
    });
  });

  describe('Game Schedule', () => {
    it('should have correct Thursday Night game', () => {
      const thursdayGame = week1Data.games.find(g => 
        g.home_team === 'BAL' && g.away_team === 'KC'
      );

      expect(thursdayGame).toBeDefined();
      expect(thursdayGame.game_time).toBe('8:20 PM ET');
    });

    it('should have games spread across different time slots', () => {
      const timeSlots = [...new Set(week1Data.games.map(g => g.game_time))];
      
      const expectedSlots = [
        '8:20 PM ET',   // Thursday Night
        '1:00 PM ET',   // Sunday early
        '4:05 PM ET',   // Sunday late (west coast)
        '4:25 PM ET',   // Sunday late
        '8:15 PM ET'    // Monday Night
      ];
      
      expectedSlots.forEach(slot => {
        expect(timeSlots).toContain(slot);
      });
    });
  });

  describe('Player Stats', () => {
    it('should have empty player stats array', () => {
      expect(week1Data.playerStats).toHaveLength(0);
    });
  });

  describe('DST Stats', () => {
    it('should have empty DST stats array', () => {
      expect(week1Data.dstStats).toHaveLength(0);
    });
  });

  describe('Metadata Validation', () => {
    it('should have correct metadata for week 1', () => {
      expect(week1Data.metadata).toBeDefined();
      expect(week1Data.metadata.week).toBe(1);
      expect(week1Data.metadata.season).toBe('mock');
      expect(week1Data.metadata.scenario).toBe('Pre-Game State');
    });

    it('should specify expected behaviors', () => {
      const { expectedBehaviors } = week1Data.metadata;
      
      expect(Array.isArray(expectedBehaviors)).toBe(true);
      expect(expectedBehaviors).toContain('All player scores should be 0');
      expect(expectedBehaviors).toContain('Rosters should be valid (19 players per team)');
    });
  });

  describe('Time-based Testing', () => {
    it('should have metadata with current time', () => {
      expect(week1Data.metadata.currentTime).toBeDefined();
      const currentTime = new Date(week1Data.metadata.currentTime);
      expect(currentTime).toBeInstanceOf(Date);
      
      // The metadata says it's Thursday 7:00 PM ET
      const expectedHour = 23; // 23:00 UTC = 7:00 PM ET
      expect(currentTime.getUTCHours()).toBe(expectedHour);
    });
  });
});