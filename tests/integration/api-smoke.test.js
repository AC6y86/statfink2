/**
 * API Smoke Tests - Essential coverage for all endpoints
 * These tests ensure basic API functionality works after refactoring
 */

const axios = require('axios');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TIMEOUT = 10000;

// Test data
const TEST_TEAM_ID = 1;
const TEST_PLAYER_ID = 1;

describe('API Smoke Tests - Critical Endpoints', () => {
  let server;
  
  beforeAll(async () => {
    // Ensure server is running
    try {
      await axios.get(`${BASE_URL}/api/health`, { timeout: 5000 });
    } catch (error) {
      throw new Error(`Server not running at ${BASE_URL}. Start with: npm start`);
    }
  }, TIMEOUT);

  describe('Health & System Endpoints', () => {
    test('GET /api/health should return system status', async () => {
      const response = await axios.get(`${BASE_URL}/api/health`);
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status');
    });

    test('GET / should serve main page', async () => {
      const response = await axios.get(`${BASE_URL}/`);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
    });
  });

  describe('Teams API Endpoints', () => {
    test('GET /api/teams should return teams list', async () => {
      const response = await axios.get(`${BASE_URL}/api/teams`);
      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
    });

    test('GET /api/teams/:id should return specific team', async () => {
      const response = await axios.get(`${BASE_URL}/api/teams/${TEST_TEAM_ID}`);
      expect([200, 404]).toContain(response.status);
      if (response.status === 200) {
        expect(response.data).toHaveProperty('team_id');
      }
    });

    test('GET /api/teams/:id/roster should return team roster', async () => {
      const response = await axios.get(`${BASE_URL}/api/teams/${TEST_TEAM_ID}/roster`);
      expect([200, 404]).toContain(response.status);
      if (response.status === 200) {
        expect(Array.isArray(response.data)).toBe(true);
      }
    });
  });

  describe('Players API Endpoints', () => {
    test('GET /api/players should return players list', async () => {
      const response = await axios.get(`${BASE_URL}/api/players`);
      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
    });

    test('GET /api/players/:id should return specific player', async () => {
      const response = await axios.get(`${BASE_URL}/api/players/${TEST_PLAYER_ID}`);
      expect([200, 404]).toContain(response.status);
      if (response.status === 200) {
        expect(response.data).toHaveProperty('player_id');
      }
    });

    test('GET /api/players/available should return available players', async () => {
      const response = await axios.get(`${BASE_URL}/api/players/available`);
      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
    });
  });

  describe('Stats API Endpoints', () => {
    test('GET /api/stats/week/:week should return weekly stats', async () => {
      const response = await axios.get(`${BASE_URL}/api/stats/week/1`);
      expect([200, 404]).toContain(response.status);
      if (response.status === 200) {
        expect(Array.isArray(response.data)).toBe(true);
      }
    });

    test('GET /api/stats/player/:id should return player stats', async () => {
      const response = await axios.get(`${BASE_URL}/api/stats/player/${TEST_PLAYER_ID}`);
      expect([200, 404]).toContain(response.status);
      if (response.status === 200) {
        expect(Array.isArray(response.data)).toBe(true);
      }
    });
  });

  describe('League API Endpoints', () => {
    test('GET /api/league/standings should return league standings', async () => {
      const response = await axios.get(`${BASE_URL}/api/league/standings`);
      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
    });

    test('GET /api/league/settings should return league configuration', async () => {
      const response = await axios.get(`${BASE_URL}/api/league/settings`);
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('league_name');
    });
  });

  describe('Matchups API Endpoints', () => {
    test('GET /api/matchups/week/:week should return weekly matchups', async () => {
      const response = await axios.get(`${BASE_URL}/api/matchups/week/1`);
      expect([200, 404]).toContain(response.status);
      if (response.status === 200) {
        expect(Array.isArray(response.data)).toBe(true);
      }
    });

    test('GET /api/matchups/current should return current week matchups', async () => {
      const response = await axios.get(`${BASE_URL}/api/matchups/current`);
      expect([200, 404]).toContain(response.status);
      if (response.status === 200) {
        expect(Array.isArray(response.data)).toBe(true);
      }
    });
  });

  describe('Admin API Endpoints', () => {
    test('GET /api/admin/health should return admin health status', async () => {
      const response = await axios.get(`${BASE_URL}/api/admin/health`);
      expect([200, 401, 403]).toContain(response.status);
    });

    test('GET /api/admin/sync/status should return sync status', async () => {
      const response = await axios.get(`${BASE_URL}/api/admin/sync/status`);
      expect([200, 401, 403]).toContain(response.status);
    });
  });

  describe('Error Handling', () => {
    test('GET /api/nonexistent should return 404', async () => {
      try {
        await axios.get(`${BASE_URL}/api/nonexistent`);
        fail('Should have thrown 404 error');
      } catch (error) {
        expect(error.response.status).toBe(404);
      }
    });

    test('Invalid API calls should return proper error responses', async () => {
      try {
        await axios.get(`${BASE_URL}/api/teams/invalid_id`);
        fail('Should have thrown error for invalid ID');
      } catch (error) {
        expect([400, 404]).toContain(error.response.status);
        expect(error.response.data).toHaveProperty('message');
      }
    });
  });
});