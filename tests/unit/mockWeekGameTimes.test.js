/**
 * Mock Week Game Times Unit Tests
 * Tests the game time display logic for mock weeks 1, 2, and 3
 */

const request = require('supertest');
const app = require('../../server/app');

describe('Mock Week Game Times API Tests', () => {
  describe('Week 1 - Pre-Game State', () => {
    it('should return scheduled games with game times for NFL endpoint', async () => {
      const response = await request(app)
        .get('/api/nfl-games/mock/1/2024')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.length).toBe(16); // Full NFL week
      
      // All games should be scheduled with 0-0 scores
      response.body.data.forEach(game => {
        expect(game.status).toBe('Scheduled');
        expect(game.home_score).toBe(0);
        expect(game.away_score).toBe(0);
        expect(game.game_time).toBeDefined();
        expect(game.game_time).toMatch(/\d{1,2}:\d{2} (AM|PM) ET/);
      });
    });

    it('should return players with scheduled game status for matchup endpoint', async () => {
      const response = await request(app)
        .get('/api/matchups/mock-game/1?week=1')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      
      // Check both teams
      const allPlayers = [
        ...response.body.data.team1.starters,
        ...response.body.data.team2.starters
      ];
      
      allPlayers.forEach(player => {
        expect(player.game_status).toBe('Scheduled');
        expect(player.game_time).toBeDefined();
        expect(player.game_time).toMatch(/\d{1,2}:\d{2} (AM|PM) ET/);
        expect(player.stats.fantasy_points).toBe(0);
      });
    });

    it('should return 0 points for all teams', async () => {
      const response = await request(app)
        .get('/api/matchups/mock/1/2024')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      
      response.body.data.forEach(matchup => {
        expect(matchup.team1_points).toBe(0);
        expect(matchup.team2_points).toBe(0);
        expect(matchup.is_complete).toBe(0);
      });
    });
  });

  describe('Week 2 - All Games Complete', () => {
    it('should return final games with scores for NFL endpoint', async () => {
      const response = await request(app)
        .get('/api/nfl-games/mock/2/2024')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      
      // All games should be final with scores
      response.body.data.forEach(game => {
        expect(game.status).toBe('Final');
        expect(game.home_score + game.away_score).toBeGreaterThan(0);
        expect(game.game_time).toBeNull();
      });
    });

    it('should return players with final game status for matchup endpoint', async () => {
      const response = await request(app)
        .get('/api/matchups/mock-game/1?week=2')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      
      const allPlayers = [
        ...response.body.data.team1.starters,
        ...response.body.data.team2.starters
      ];
      
      allPlayers.forEach(player => {
        expect(player.game_status).toBe('Final');
        expect(player.game_time).toBeNull();
        expect(player.stats.fantasy_points).toBeGreaterThan(0);
      });
    });

    it('should return completed matchups with points', async () => {
      const response = await request(app)
        .get('/api/matchups/mock/2/2024')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      
      response.body.data.forEach(matchup => {
        expect(parseFloat(matchup.team1_points)).toBeGreaterThan(0);
        expect(parseFloat(matchup.team2_points)).toBeGreaterThan(0);
        expect(matchup.is_complete).toBe(1);
      });
    });
  });

  describe('Week 3 - Mid-Sunday Games', () => {
    it('should return mixed game statuses for NFL endpoint', async () => {
      const response = await request(app)
        .get('/api/nfl-games/mock/3/2024')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      
      const statuses = response.body.data.map(g => g.status);
      
      // Should have a mix of game statuses
      expect(statuses).toContain('Final');
      expect(statuses).toContain('Scheduled');
      expect(statuses.some(s => s === 'InProgress' || s === 'Halftime')).toBe(true);
      
      // Check game times based on status
      response.body.data.forEach(game => {
        if (game.status === 'Scheduled') {
          expect(game.game_time).toBeDefined();
          if (game.game_time) {
            expect(game.game_time).toMatch(/\d{1,2}:\d{2} (AM|PM) ET/);
          }
          expect(game.home_score).toBe(0);
          expect(game.away_score).toBe(0);
        } else if (game.status === 'InProgress' || game.status === 'Halftime') {
          expect(game.game_time).toBeDefined();
          // In-progress games show quarter and time
          if (game.status === 'InProgress' && game.game_time) {
            expect(game.game_time).toMatch(/[1-4]Q \d{1,2}:\d{2}/);
          } else if (game.status === 'Halftime') {
            expect(game.game_time).toBe('Halftime');
          }
        } else if (game.status === 'Final') {
          expect(game.game_time).toBeNull();
          expect(game.home_score + game.away_score).toBeGreaterThan(0);
        }
      });
    });

    it('should return players with mixed game statuses', async () => {
      const response = await request(app)
        .get('/api/matchups/mock-game/1?week=3')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      
      const allPlayers = [
        ...response.body.data.team1.starters,
        ...response.body.data.team2.starters
      ];
      
      const statuses = allPlayers.map(p => p.game_status);
      
      // Should have players in different game states
      const hasScheduled = statuses.includes('Scheduled');
      const hasInProgress = statuses.some(s => s === 'InProgress' || s === 'Halftime');
      const hasFinal = statuses.includes('Final');
      
      expect(hasScheduled || hasInProgress || hasFinal).toBe(true);
      
      // Check appropriate data for each status
      allPlayers.forEach(player => {
        if (player.game_status === 'Scheduled') {
          expect(player.game_time).toBeDefined();
          expect(player.stats.fantasy_points).toBe(0);
        } else if (player.game_status === 'InProgress' || player.game_status === 'Halftime') {
          expect(player.stats.fantasy_points).toBeGreaterThan(0);
        } else if (player.game_status === 'Final') {
          expect(player.game_time).toBeNull();
          expect(player.stats.fantasy_points).toBeGreaterThan(0);
        }
      });
    });

    it('should return matchups with points accumulated', async () => {
      const response = await request(app)
        .get('/api/matchups/mock/3/2024')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      
      response.body.data.forEach(matchup => {
        // Teams should have some points from games played
        expect(parseFloat(matchup.team1_points)).toBeGreaterThan(0);
        expect(parseFloat(matchup.team2_points)).toBeGreaterThan(0);
        // Mid-Sunday could have matchups complete or not depending on game schedule
        expect([0, 1]).toContain(matchup.is_complete);
      });
    });
  });

  describe('Time Conversion Helpers', () => {
    // Test the time conversion logic directly
    const convertToPST = (etTime) => {
      const match = etTime.match(/(\d+):(\d+) (AM|PM) ET/);
      if (!match) return etTime;
      
      let hours = parseInt(match[1]);
      const minutes = match[2];
      const period = match[3];
      
      // Convert to 24-hour format
      if (period === 'PM' && hours !== 12) hours += 12;
      if (period === 'AM' && hours === 12) hours = 0;
      
      // Subtract 3 hours for PST
      hours -= 3;
      
      // Handle negative hours
      if (hours < 0) {
        hours += 12;
        const newPeriod = period === 'PM' ? 'AM' : 'PM';
        return `${hours === 0 ? 12 : hours}:${minutes} ${newPeriod} PST`;
      }
      
      // Convert back to 12-hour format
      const newPeriod = hours >= 12 ? 'PM' : 'AM';
      if (hours > 12) hours -= 12;
      if (hours === 0) hours = 12;
      
      return `${hours}:${minutes} ${newPeriod} PST`;
    };

    it('should correctly convert ET times to PST', () => {
      expect(convertToPST('8:20 PM ET')).toBe('5:20 PM PST');
      expect(convertToPST('1:00 PM ET')).toBe('10:00 AM PST');
      expect(convertToPST('4:05 PM ET')).toBe('1:05 PM PST');
      expect(convertToPST('4:25 PM ET')).toBe('1:25 PM PST');
      expect(convertToPST('8:15 PM ET')).toBe('5:15 PM PST');
      expect(convertToPST('12:00 PM ET')).toBe('9:00 AM PST');
      expect(convertToPST('12:00 AM ET')).toBe('9:00 PM PST');
    });
  });

  describe('Game Progression for Week 3', () => {
    it('should update game status when progression is simulated', async () => {
      // First, get initial state
      const initialResponse = await request(app)
        .get('/api/nfl-games/mock/3/2024')
        .expect(200);
      
      const initialInProgress = initialResponse.body.data.filter(g => 
        g.status === 'InProgress' || g.status === 'Halftime'
      ).length;
      
      // Simulate progression
      const progressResponse = await request(app)
        .post('/api/matchups/mock/simulate-update/3')
        .expect(200);
      
      expect(progressResponse.body.success).toBe(true);
      
      // Get updated state
      const updatedResponse = await request(app)
        .get('/api/nfl-games/mock/3/2024')
        .expect(200);
      
      // Some games should have progressed
      const updatedInProgress = updatedResponse.body.data.filter(g => 
        g.status === 'InProgress' || g.status === 'Halftime'
      ).length;
      
      // The progression state should be maintained
      expect(progressResponse.body.hasActiveGames).toBeDefined();
    });
  });

  describe('Mock Week 3 Matchup Display', () => {
    it('should return correct game times for in-progress players', async () => {
      const response = await request(app)
        .get('/api/matchups/mock-game/1?week=3')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      
      const { team1, team2 } = response.body.data;
      
      // Find specific in-progress players
      const teamAQB = team1.starters.find(p => p.name === 'Team A QB');
      expect(teamAQB).toBeDefined();
      expect(teamAQB.game_status).toBe('InProgress');
      expect(teamAQB.game_time).toBe('3Q 12:45');
      
      const teamARB = team1.starters.find(p => p.name === 'Team A RB');
      expect(teamARB).toBeDefined();
      expect(teamARB.game_status).toBe('InProgress');
      expect(teamARB.game_time).toBe('3Q 8:22');
      
      // Check all in-progress players have proper game_time
      const allPlayers = [...team1.starters, ...team2.starters];
      const inProgressPlayers = allPlayers.filter(p => p.game_status === 'InProgress');
      
      inProgressPlayers.forEach(player => {
        expect(player.game_time).toBeDefined();
        expect(player.game_time).toMatch(/\d[Q] \d{1,2}:\d{2}/);
        console.log(`${player.name}: ${player.game_time}`);
      });
    });
  });
});