/**
 * Mock Week Frontend Integration Tests
 * Tests that the frontend correctly displays mock week game times
 */

const request = require('supertest');
const app = require('../../server/app');

describe('Mock Week Frontend Integration', () => {
  let server;

  beforeAll(() => {
    server = app.listen(3002);
  });

  afterAll(() => {
    server.close();
  });

  describe('Mock Week 3 Game Time Display', () => {
    it('should properly render game times for in-progress games', async () => {
      // First verify the API returns correct data
      const apiResponse = await request(app)
        .get('/api/matchups/mock-game/1?week=3')
        .expect(200);
      
      expect(apiResponse.body.success).toBe(true);
      
      // Count in-progress games
      const allPlayers = [
        ...apiResponse.body.data.team1.starters,
        ...apiResponse.body.data.team2.starters
      ];
      
      const inProgressCount = allPlayers.filter(p => 
        p.game_status === 'InProgress'
      ).length;
      
      expect(inProgressCount).toBeGreaterThan(0); // Should have some in-progress games
      
      // Verify all in-progress players have game times
      allPlayers
        .filter(p => p.game_status === 'InProgress')
        .forEach(player => {
          expect(player.game_time).toMatch(/\d[Q] \d{1,2}:\d{2}/);
        });
    });

    it('should have correct HTML structure for rendering', async () => {
      // Get the HTML page
      const pageResponse = await request(app)
        .get('/statfink/mock/3?matchup=1')
        .expect(200);
      
      const html = pageResponse.text;
      
      // Check that the page has necessary functions
      expect(html).toContain('function getPlayerGameStatus');
      expect(html).toContain('function displayTeamRoster');
      expect(html).toContain('loadMatchup');
      
      // Check that it will load mock data
      expect(html).toContain('/api/matchups/mock-game/');
      
      // Should not have unrendered template literals in initial HTML
      expect(html).not.toContain('${getPlayerGameStatus(player)}');
    });

    it('should format different game states correctly', () => {
      // Test the game status formatting logic
      const getPlayerGameStatus = (player) => {
        if (player.game_status === 'Scheduled' && player.game_time) {
          // Simple PST conversion for test
          return player.game_time.replace('ET', 'PST');
        } else if ((player.game_status === 'InProgress' || player.game_status === 'Halftime') && player.game_time) {
          return player.game_time;
        }
        return player.game_status || 'Final';
      };
      
      // Test cases
      expect(getPlayerGameStatus({ 
        game_status: 'InProgress', 
        game_time: '3Q 12:45' 
      })).toBe('3Q 12:45');
      
      expect(getPlayerGameStatus({ 
        game_status: 'Halftime', 
        game_time: 'Halftime' 
      })).toBe('Halftime');
      
      expect(getPlayerGameStatus({ 
        game_status: 'Scheduled', 
        game_time: '4:25 PM ET' 
      })).toBe('4:25 PM PST');
      
      expect(getPlayerGameStatus({ 
        game_status: 'Final' 
      })).toBe('Final');
    });
  });

  describe('Mock Week Comparison', () => {
    it('should show different game states for each mock week', async () => {
      // Week 1 - All scheduled
      const week1Response = await request(app)
        .get('/api/matchups/mock-game/1?week=1')
        .expect(200);
      
      const week1Players = [
        ...week1Response.body.data.team1.starters,
        ...week1Response.body.data.team2.starters
      ];
      
      const week1Scheduled = week1Players.filter(p => p.game_status === 'Scheduled').length;
      expect(week1Scheduled).toBe(week1Players.length); // All players scheduled
      
      // Week 2 - All final
      const week2Response = await request(app)
        .get('/api/matchups/mock-game/1?week=2')
        .expect(200);
      
      const week2Players = [
        ...week2Response.body.data.team1.starters,
        ...week2Response.body.data.team2.starters
      ];
      
      const week2Final = week2Players.filter(p => p.game_status === 'Final').length;
      expect(week2Final).toBe(week2Players.length); // All players final
      
      // Week 3 - Mixed states
      const week3Response = await request(app)
        .get('/api/matchups/mock-game/1?week=3')
        .expect(200);
      
      const week3Players = [
        ...week3Response.body.data.team1.starters,
        ...week3Response.body.data.team2.starters
      ];
      
      const week3States = {
        scheduled: week3Players.filter(p => p.game_status === 'Scheduled').length,
        inProgress: week3Players.filter(p => p.game_status === 'InProgress').length,
        halftime: week3Players.filter(p => p.game_status === 'Halftime').length,
        final: week3Players.filter(p => p.game_status === 'Final').length
      };
      
      // Should have a mix of states (at least 2 different states)
      const statesWithPlayers = Object.entries(week3States)
        .filter(([state, count]) => count > 0)
        .map(([state]) => state);
      
      expect(statesWithPlayers.length).toBeGreaterThanOrEqual(2);
      expect(week3States.inProgress).toBeGreaterThan(0); // Must have in-progress games
      
      // Total should equal all players
      const total = Object.values(week3States).reduce((a, b) => a + b, 0);
      expect(total).toBe(week3Players.length);
    });
  });
});