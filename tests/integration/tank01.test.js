const axios = require('axios');

// Test configuration
const BASE_URL = 'http://localhost:3000';
const TANK01_API_KEY = process.env.TANK01_API_KEY;

describe('Tank01 API Integration', () => {
  let serverRunning = false;

  beforeAll(async () => {
    // Check if server is running
    try {
      await axios.get(`${BASE_URL}/health`, { timeout: 5000 });
      serverRunning = true;
    } catch (error) {
      console.warn('Server not running - Tank01 integration tests will be skipped');
      serverRunning = false;
    }
  }, 10000);

  describe('Health Endpoint', () => {
    test('should return healthy status', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/health`);
      const health = response.data;
      
      expect(health.status).toBe('healthy');
      expect(health.services).toBeDefined();
      expect(health.services.database).toBe('connected');
      expect(['healthy', 'initialized', 'not configured']).toContain(health.services.tank01);
      
      if (health.tank01_stats) {
        expect(typeof health.tank01_stats.requests).toBe('number');
        expect(typeof health.tank01_stats.cache_size).toBe('number');
      }
    });
  });

  describe('Sync Status', () => {
    test('should return sync status information', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/api/admin/sync/status`);
      const result = response.data;
      
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.sync).toBeDefined();
      expect(typeof result.data.sync.sync_in_progress).toBe('boolean');
      expect(typeof result.data.sync.tank01_available).toBe('boolean');
      
      if (result.data.tank01) {
        expect(['healthy', 'unhealthy']).toContain(result.data.tank01.status);
        expect(typeof result.data.tank01.requestCount).toBe('number');
        expect(typeof result.data.tank01.cacheSize).toBe('number');
      }
    });
  });

  describe('Player Sync', () => {
    test('should sync players if Tank01 API key is available', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      if (!TANK01_API_KEY) {
        console.log('Skipping player sync test - no Tank01 API key');
        return;
      }

      const response = await axios.post(`${BASE_URL}/api/admin/sync/players`, {}, {
        timeout: 60000 // 60 second timeout
      });
      
      const result = response.data;
      
      if (result.success) {
        expect(result.data.players_synced).toBeGreaterThan(0);
        expect(typeof result.data.duration).toBe('number');
        expect(result.data.last_sync).toBeDefined();
      } else {
        // Sync might fail for various reasons, just ensure error is reported
        expect(result.error).toBeDefined();
      }
    }, 70000);
  });

  describe('Player Data', () => {
    test('should have players in database', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/api/players`);
      const players = response.data.data;
      
      expect(Array.isArray(players)).toBe(true);
      expect(players.length).toBeGreaterThan(0);
      
      // Count by position
      const positions = {};
      players.forEach(player => {
        positions[player.position] = (positions[player.position] || 0) + 1;
      });
      
      // Should have multiple positions
      expect(Object.keys(positions).length).toBeGreaterThan(1);
      
      // Should have fantasy-relevant positions
      const fantasyPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
      Object.keys(positions).forEach(position => {
        expect(fantasyPositions).toContain(position);
      });
    });

    test('should filter players by position', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/api/players/position/QB`);
      const qbs = response.data.data;
      
      expect(Array.isArray(qbs)).toBe(true);
      
      if (qbs.length > 0) {
        // All players should be QBs
        qbs.forEach(player => {
          expect(player.position).toBe('QB');
          expect(player.name).toBeDefined();
          expect(player.team).toBeDefined();
        });
      }
    });
  });

  describe('Teams Data', () => {
    test('should have teams in database', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/api/teams`);
      const teams = response.data.data;
      
      expect(Array.isArray(teams)).toBe(true);
      expect(teams.length).toBeGreaterThan(0);
      
      if (teams.length > 0) {
        const team = teams[0];
        expect(team.team_name).toBeDefined();
        expect(team.owner_name).toBeDefined();
        expect(typeof team.wins).toBe('number');
        expect(typeof team.losses).toBe('number');
        expect(typeof team.total_points).toBe('number');
      }
    });

    test('should get team roster', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      // Get teams first
      const teamsResponse = await axios.get(`${BASE_URL}/api/teams`);
      const teams = teamsResponse.data.data;
      
      if (teams.length > 0) {
        const response = await axios.get(`${BASE_URL}/api/teams/${teams[0].team_id}/roster`);
        const roster = response.data.data;
        
        expect(Array.isArray(roster)).toBe(true);
        // Roster might be empty, which is fine
      }
    });
  });

  describe('Tank01 Service Health', () => {
    test('should report Tank01 service status', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/health`);
      const health = response.data;
      
      if (TANK01_API_KEY) {
        // If we have an API key, service should be initialized or healthy
        expect(['healthy', 'initialized', 'unhealthy']).toContain(health.services.tank01);
      } else {
        // Without API key, should be not configured
        expect(health.services.tank01).toBe('not configured');
      }
    });
  });
});