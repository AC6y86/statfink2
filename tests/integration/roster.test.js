const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

describe('Roster Management Integration', () => {
  let serverRunning = false;
  let testTeamId = 1;
  let testPlayerId = null;

  beforeAll(async () => {
    // Check if server is running
    try {
      await axios.get(`${BASE_URL}/health`, { timeout: 10000 });
      serverRunning = true;
      
      // Get a test player from available players
      const playersResponse = await axios.get(`${BASE_URL}/api/players/available/QB`);
      if (playersResponse.data.data.length > 0) {
        testPlayerId = playersResponse.data.data[0].player_id;
      }
    } catch (error) {
      console.warn('Server not running - Roster management tests will be skipped', error.message);
      serverRunning = false;
    }
  }, 10000);

  describe('Add Player to Roster', () => {
    test('should add available player to team roster', async () => {
      if (!serverRunning || !testPlayerId) {
        console.log('Skipping test - server not running or no available players');
        return;
      }

      const response = await axios.post(`${BASE_URL}/api/teams/${testTeamId}/roster/add`, {
        playerId: testPlayerId,
        rosterPosition: 'active'
      });
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.data.player.id).toBe(testPlayerId);
      expect(response.data.data.rosterPosition).toBe('active');
      expect(response.data.message).toContain('added to');
    });

    test('should reject invalid roster position', async () => {
      if (!serverRunning || !testPlayerId) {
        console.log('Skipping test - server not running or no available players');
        return;
      }

      try {
        await axios.post(`${BASE_URL}/api/teams/${testTeamId}/roster/add`, {
          playerId: testPlayerId,
          rosterPosition: 'invalid'
        });
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.message).toContain('Invalid roster position');
      }
    });

    // Removed test for adding player with 'starter' position - database only supports 'active' and 'injured_reserve'

    test('should reject invalid team ID', async () => {
      if (!serverRunning || !testPlayerId) {
        console.log('Skipping test - server not running or no available players');
        return;
      }

      try {
        await axios.post(`${BASE_URL}/api/teams/999/roster/add`, {
          playerId: testPlayerId,
          rosterPosition: 'active'
        });
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.response.status).toBe(404);
        expect(error.response.data.message).toContain('Team not found');
      }
    });
  });

  describe('Move Player Between Positions', () => {
    // Removed test for 'starter' position - database only supports 'active' and 'injured_reserve'

    test('should handle IR constraints properly', async () => {
      if (!serverRunning || !testPlayerId) {
        console.log('Skipping test - server not running or no test player on roster');
        return;
      }

      try {
        const response = await axios.put(`${BASE_URL}/api/teams/${testTeamId}/roster/move`, {
          playerId: testPlayerId,
          rosterPosition: 'injured_reserve'
        });
        
        // If it succeeds, verify the response
        expect(response.status).toBe(200);
        expect(response.data.success).toBe(true);
        expect(response.data.data.newPosition).toBe('injured_reserve');
      } catch (error) {
        // If it fails, it should be due to IR constraints
        expect(error.response.status).toBe(400);
        expect(error.response.data.message).toContain('injured reserve');
        console.log('Expected IR constraint violation:', error.response.data.message);
      }
    });

    test('should reject invalid roster position', async () => {
      if (!serverRunning || !testPlayerId) {
        console.log('Skipping test - server not running or no test player on roster');
        return;
      }

      try {
        await axios.put(`${BASE_URL}/api/teams/${testTeamId}/roster/move`, {
          playerId: testPlayerId,
          rosterPosition: 'invalid'
        });
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.message).toContain('Invalid roster position');
      }
    });

    // Removed test for moving player to 'starter' position - database only supports 'active' and 'injured_reserve'
  });

  describe('Remove Player from Roster', () => {
    test('should remove player from team roster', async () => {
      if (!serverRunning || !testPlayerId) {
        console.log('Skipping test - server not running or no test player on roster');
        return;
      }

      const response = await axios.delete(`${BASE_URL}/api/teams/${testTeamId}/roster/remove`, {
        data: { playerId: testPlayerId }
      });
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.data.player.id).toBe(testPlayerId);
      expect(response.data.message).toContain('removed from');
    });

    test('should reject removing player not on roster', async () => {
      if (!serverRunning || !testPlayerId) {
        console.log('Skipping test - server not running or no test player');
        return;
      }

      try {
        await axios.delete(`${BASE_URL}/api/teams/${testTeamId}/roster/remove`, {
          data: { playerId: testPlayerId }
        });
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.message).toContain('not on this team\'s roster');
      }
    });

    test('should reject invalid team ID', async () => {
      if (!serverRunning || !testPlayerId) {
        console.log('Skipping test - server not running or no test player');
        return;
      }

      try {
        await axios.delete(`${BASE_URL}/api/teams/999/roster/remove`, {
          data: { playerId: testPlayerId }
        });
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.response.status).toBe(404);
        expect(error.response.data.message).toContain('Team not found');
      }
    });

    test('should reject missing player ID', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      try {
        await axios.delete(`${BASE_URL}/api/teams/${testTeamId}/roster/remove`, {
          data: {}
        });
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.message).toContain('Player ID is required');
      }
    });
  });

  describe('Roster Validation', () => {
    test('should verify roster changes are reflected in team roster', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      // Get current roster
      const rosterResponse = await axios.get(`${BASE_URL}/api/teams/${testTeamId}/roster`);
      const initialRosterSize = rosterResponse.data.data.roster.length;

      // Get an available player
      const availableResponse = await axios.get(`${BASE_URL}/api/players/available/WR`);
      if (availableResponse.data.data.length === 0) {
        console.log('Skipping test - no available WR players');
        return;
      }

      const newPlayerId = availableResponse.data.data[0].player_id;

      // Add player
      await axios.post(`${BASE_URL}/api/teams/${testTeamId}/roster/add`, {
        playerId: newPlayerId,
        rosterPosition: 'active'
      });

      // Verify roster size increased
      const updatedRosterResponse = await axios.get(`${BASE_URL}/api/teams/${testTeamId}/roster`);
      const updatedRosterSize = updatedRosterResponse.data.data.roster.length;
      expect(updatedRosterSize).toBe(initialRosterSize + 1);

      // Verify player is in roster
      const addedPlayer = updatedRosterResponse.data.data.roster.find(p => p.player_id === newPlayerId);
      expect(addedPlayer).toBeDefined();
      expect(addedPlayer.roster_position).toBe('active');

      // Clean up - remove the player
      await axios.delete(`${BASE_URL}/api/teams/${testTeamId}/roster/remove`, {
        data: { playerId: newPlayerId }
      });

      // Verify roster size back to original
      const finalRosterResponse = await axios.get(`${BASE_URL}/api/teams/${testTeamId}/roster`);
      const finalRosterSize = finalRosterResponse.data.data.roster.length;
      expect(finalRosterSize).toBe(initialRosterSize);
    });

    // Removed test that moves player to 'starter' position - database only supports 'active' and 'injured_reserve'
  });

  describe('Error Handling', () => {
    test('should handle non-existent player ID gracefully', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      try {
        await axios.post(`${BASE_URL}/api/teams/${testTeamId}/roster/add`, {
          playerId: 'nonexistent',
          rosterPosition: 'active'
        });
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.response.status).toBe(404);
        expect(error.response.data.message).toContain('Player not found');
      }
    });

    test('should handle malformed request bodies', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      try {
        await axios.post(`${BASE_URL}/api/teams/${testTeamId}/roster/add`, {});
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.message).toContain('Player ID is required');
      }
    });

    test('should handle invalid team ID format', async () => {
      if (!serverRunning) {
        console.log('Skipping test - server not running');
        return;
      }

      try {
        await axios.post(`${BASE_URL}/api/teams/invalid/roster/add`, {
          playerId: 'test',
          rosterPosition: 'active'
        });
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.message).toContain('Invalid team ID');
      }
    });
  });
});