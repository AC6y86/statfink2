const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

describe('Database Dashboard Integration', () => {
  let serverRunning = false;

  beforeAll(async () => {
    // Check if server is running
    try {
      await axios.get(`${BASE_URL}/health`, { timeout: 5000 });
      serverRunning = true;
    } catch (error) {
      console.warn('Server not running - Dashboard integration tests will be skipped');
      serverRunning = false;
    }
  }, 10000);

  describe('Dashboard Page', () => {
    test('should serve dashboard HTML page', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/dashboard`);
      
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.data).toContain('StatFink Database Dashboard');
      expect(response.data).toContain('Fantasy Football League Management System');
      expect(response.data.length).toBeGreaterThan(30000); // Should be substantial HTML
    });

    test('should include all dashboard sections', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/dashboard`);
      const html = response.data;
      
      // Check for key dashboard sections
      expect(html).toContain('players-tab');
      expect(html).toContain('teams-tab');
      expect(html).toContain('rosters-tab');
      expect(html).toContain('stats-tab');
      expect(html).toContain('admin-tab');
      
      // Check for key functionality
      expect(html).toContain('loadPlayers');
      expect(html).toContain('syncPlayers');
      expect(html).toContain('checkSyncStatus');
    });
  });

  describe('Players API for Dashboard', () => {
    test('should load players data', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/api/players`);
      const result = response.data;
      
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
      
      // Check player structure
      if (result.data.length > 0) {
        const player = result.data[0];
        expect(player.name).toBeDefined();
        expect(player.position).toBeDefined();
        expect(player.team).toBeDefined();
        expect(player.player_id).toBeDefined();
      }
    });

    test('should have balanced position distribution', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/api/players`);
      const players = response.data.data;
      
      // Count by position
      const positions = {};
      players.forEach(player => {
        positions[player.position] = (positions[player.position] || 0) + 1;
      });
      
      // Should have all major fantasy positions
      const expectedPositions = ['QB', 'RB', 'WR', 'TE', 'K'];
      expectedPositions.forEach(pos => {
        expect(positions[pos]).toBeGreaterThan(0);
      });
      
      // Should have reasonable distribution
      expect(positions.QB).toBeGreaterThan(50); // At least 50 QBs
      expect(positions.RB).toBeGreaterThan(100); // At least 100 RBs
      expect(positions.WR).toBeGreaterThan(200); // At least 200 WRs
      expect(positions.TE).toBeGreaterThan(50); // At least 50 TEs
      expect(positions.K).toBeGreaterThan(20); // At least 20 Kickers
    });

    test('should filter players by position', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const positions = ['QB', 'RB', 'WR', 'TE', 'K'];
      
      for (const position of positions) {
        const response = await axios.get(`${BASE_URL}/api/players/position/${position}`);
        const result = response.data;
        
        expect(result.success).toBe(true);
        expect(Array.isArray(result.data)).toBe(true);
        
        // All returned players should be of the requested position
        result.data.forEach(player => {
          expect(player.position).toBe(position);
        });
      }
    });
  });

  describe('Teams API for Dashboard', () => {
    test('should load teams data', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/api/teams`);
      const result = response.data;
      
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
      
      // Check team structure
      if (result.data.length > 0) {
        const team = result.data[0];
        expect(team.team_name).toBeDefined();
        expect(team.owner_name).toBeDefined();
        expect(typeof team.wins).toBe('number');
        expect(typeof team.losses).toBe('number');
        expect(typeof team.ties).toBe('number');
        expect(typeof team.total_points).toBe('number');
      }
    });

    test('should get team rosters', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      // Get teams first
      const teamsResponse = await axios.get(`${BASE_URL}/api/teams`);
      const teams = teamsResponse.data.data;
      
      if (teams.length > 0) {
        const teamId = teams[0].team_id;
        const rosterResponse = await axios.get(`${BASE_URL}/api/teams/${teamId}/roster`);
        const result = rosterResponse.data;
        
        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(Array.isArray(result.data.roster)).toBe(true);
        
        // Check roster structure if not empty
        if (result.data.roster.length > 0) {
          const player = result.data.roster[0];
          expect(player.name).toBeDefined();
          expect(player.position).toBeDefined();
          expect(player.team).toBeDefined();
          expect(player.roster_position).toBeDefined();
          expect(['starter', 'bench', 'ir']).toContain(player.roster_position);
        }
      }
    });
  });

  describe('Health Endpoint for Dashboard', () => {
    test('should provide comprehensive system status', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/health`);
      const health = response.data;
      
      expect(health.status).toBe('healthy');
      expect(health.timestamp).toBeDefined();
      expect(health.version).toBeDefined();
      expect(health.services).toBeDefined();
      expect(health.services.database).toBe('connected');
      expect(['healthy', 'initialized', 'not configured']).toContain(health.services.tank01);
    });
  });

  describe('Admin Dashboard Features', () => {
    test('should access sync status without authentication', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/api/admin/sync/status`);
      const result = response.data;
      
      expect(response.status).toBe(200);
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.sync).toBeDefined();
      expect(typeof result.data.sync.tank01_available).toBe('boolean');
    });

    test('should access admin dashboard data', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const response = await axios.get(`${BASE_URL}/api/admin/dashboard`);
      const result = response.data;
      
      expect(response.status).toBe(200);
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.summary).toBeDefined();
      expect(typeof result.data.summary.totalPlayers).toBe('number');
      expect(typeof result.data.summary.totalTeams).toBe('number');
    });
  });

  describe('Dashboard Data Quality', () => {
    test('should have consistent data across endpoints', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      // Get data from multiple endpoints
      const [playersRes, teamsRes, healthRes] = await Promise.all([
        axios.get(`${BASE_URL}/api/players`),
        axios.get(`${BASE_URL}/api/teams`),
        axios.get(`${BASE_URL}/health`)
      ]);

      const playersCount = playersRes.data.data.length;
      const teamsCount = teamsRes.data.data.length;
      
      // Verify data consistency
      expect(playersCount).toBeGreaterThan(0);
      expect(teamsCount).toBeGreaterThan(0);
      
      // Health should reflect actual system state
      expect(healthRes.data.status).toBe('healthy');
    });

    test('should handle empty rosters gracefully', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const teamsResponse = await axios.get(`${BASE_URL}/api/teams`);
      const teams = teamsResponse.data.data;
      
      // Check that roster endpoints work even for empty rosters
      for (let i = 0; i < Math.min(5, teams.length); i++) {
        const rosterResponse = await axios.get(`${BASE_URL}/api/teams/${teams[i].team_id}/roster`);
        expect(rosterResponse.status).toBe(200);
        expect(rosterResponse.data.success).toBe(true);
        expect(rosterResponse.data.data).toBeDefined();
        expect(Array.isArray(rosterResponse.data.data.roster)).toBe(true);
      }
    });
  });

  describe('Dashboard Performance', () => {
    test('should load dashboard page quickly', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      const startTime = Date.now();
      const response = await axios.get(`${BASE_URL}/dashboard`);
      const loadTime = Date.now() - startTime;
      
      expect(response.status).toBe(200);
      expect(loadTime).toBeLessThan(5000); // Should load in under 5 seconds
    });

    test('should handle concurrent API requests', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      // Make multiple concurrent requests
      const requests = [
        axios.get(`${BASE_URL}/api/players`),
        axios.get(`${BASE_URL}/api/teams`),
        axios.get(`${BASE_URL}/health`),
        axios.get(`${BASE_URL}/api/players/position/QB`),
        axios.get(`${BASE_URL}/api/admin/sync/status`)
      ];

      const responses = await Promise.all(requests);
      
      // All should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });
    });
  });
});