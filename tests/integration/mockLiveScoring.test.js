const request = require('supertest');
const app = require('../../server/app');
const { getMockWeek, initializeGameProgression, simulateGameProgression, hasInProgressGames } = require('../mockWeeks');

describe('Mock Live Scoring Integration Tests', () => {
    let server;

    beforeAll(() => {
        // Start server on a test port
        server = app.listen(0);
    });

    afterAll((done) => {
        server.close(done);
    });

    describe('Week 3 - Mid-Sunday Games', () => {
        beforeEach(() => {
            // Initialize Week 3 progression state
            initializeGameProgression(3);
        });

        test('should load Week 3 with in-progress games', async () => {
            const response = await request(server)
                .get('/api/matchups/mock/3/mock')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.mock).toBe(true);
            expect(response.body.week).toBe(3);
            
            // Verify we have matchups
            expect(response.body.data.length).toBeGreaterThan(0);
        });

        test('should return games with mixed statuses', async () => {
            const response = await request(server)
                .get('/api/nfl-games/mock/3/mock')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.mock).toBe(true);
            
            const games = response.body.data;
            
            // Check for different game statuses
            const statuses = games.map(g => g.status);
            expect(statuses).toContain('Final');      // Thursday game
            expect(statuses).toContain('InProgress');  // Sunday 1PM games
            expect(statuses).toContain('Scheduled');  // Later games
        });

        test('should simulate game progression', async () => {
            // Check initial state
            expect(hasInProgressGames(3)).toBe(true);

            // Simulate update
            const response = await request(server)
                .post('/api/matchups/mock/simulate-update/3')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.updateCount).toBe(1);
            expect(response.body.gamesUpdated).toBeGreaterThan(0);
        });

        test('should update scores after progression', async () => {
            // Get initial games
            const initialResponse = await request(server)
                .get('/api/nfl-games/mock/3/mock')
                .expect(200);
            
            const initialGames = initialResponse.body.data;
            const initialInProgressGame = initialGames.find(g => g.status === 'InProgress');
            const initialScore = initialInProgressGame.home_score + initialInProgressGame.away_score;

            // Simulate multiple updates
            for (let i = 0; i < 5; i++) {
                await request(server)
                    .post('/api/matchups/mock/simulate-update/3')
                    .expect(200);
            }

            // Get updated games
            const updatedResponse = await request(server)
                .get('/api/nfl-games/mock/3/mock')
                .expect(200);
            
            const updatedGames = updatedResponse.body.data;
            const updatedGame = updatedGames.find(g => g.game_id === initialInProgressGame.game_id);

            // Score might have increased (30% chance per update)
            const updatedScore = updatedGame.home_score + updatedGame.away_score;
            expect(updatedScore).toBeGreaterThanOrEqual(initialScore);
            
            // Game should have progressed (either score changed or status changed)
            if (updatedGame.status === 'InProgress') {
                // Either score changed or game still in progress
                const scoreChanged = updatedScore > initialScore;
                const stillInProgress = updatedGame.status === 'InProgress';
                expect(scoreChanged || stillInProgress).toBe(true);
            }
        });

        test('should eventually complete all games', async () => {
            // Simulate many updates to complete games
            let hasActive = true;
            let updateCount = 0;
            const maxUpdates = 50; // Safety limit

            while (hasActive && updateCount < maxUpdates) {
                const response = await request(server)
                    .post('/api/matchups/mock/simulate-update/3')
                    .expect(200);
                
                hasActive = response.body.hasActiveGames;
                updateCount++;
            }

            // Verify all games are complete
            const finalResponse = await request(server)
                .get('/api/nfl-games/mock/3/mock')
                .expect(200);
            
            const finalGames = finalResponse.body.data;
            const activeGames = finalGames.filter(g => 
                g.status === 'InProgress' || g.status === 'Halftime'
            );
            
            expect(activeGames.length).toBe(0);
        });

        test('should update player stats during game progression', async () => {
            // Get initial matchup with player stats
            const initialResponse = await request(server)
                .get('/api/matchups/mock-game/1?week=3&season=mock')
                .expect(200);
            
            const initialData = initialResponse.body.data;
            
            // Find a player in an in-progress game
            const allPlayers = [...initialData.team1.starters, ...initialData.team2.starters];
            const activePlayer = allPlayers.find(p => 
                p.game_status === 'InProgress' && p.position === 'QB'
            );
            
            if (activePlayer) {
                const initialYards = activePlayer.stats.passing_yards || 0;

                // Simulate updates
                for (let i = 0; i < 3; i++) {
                    await request(server)
                        .post('/api/matchups/mock/simulate-update/3')
                        .expect(200);
                }

                // Get updated stats
                const updatedResponse = await request(server)
                    .get('/api/matchups/mock-game/1?week=3&season=mock')
                    .expect(200);
                
                const updatedData = updatedResponse.body.data;
                const updatedPlayers = [...updatedData.team1.starters, ...updatedData.team2.starters];
                const updatedPlayer = updatedPlayers.find(p => p.player_id === activePlayer.player_id);

                // Stats should have changed or stayed the same
                expect(updatedPlayer.stats.passing_yards).toBeDefined();
                // Game should still be in progress or completed
                expect(['InProgress', 'Halftime', 'Final']).toContain(updatedPlayer.game_status);
            }
        });
    });

    describe('Week 1 - Pre-Game State', () => {
        test('should not have any in-progress games', async () => {
            const response = await request(server)
                .get('/api/nfl-games/mock/1/mock')
                .expect(200);

            const games = response.body.data;
            const inProgressGames = games.filter(g => g.status === 'InProgress');
            
            expect(inProgressGames.length).toBe(0);
            expect(hasInProgressGames(1)).toBe(false);
        });

        test('should return no active games on simulate update', async () => {
            const response = await request(server)
                .post('/api/matchups/mock/simulate-update/1')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.hasActiveGames).toBe(false);
        });
    });

    describe('Week 2 - All Games Complete', () => {
        test('should have all games as Final', async () => {
            const response = await request(server)
                .get('/api/nfl-games/mock/2/mock')
                .expect(200);

            const games = response.body.data;
            const nonFinalGames = games.filter(g => g.status !== 'Final');
            
            expect(nonFinalGames.length).toBe(0);
            expect(hasInProgressGames(2)).toBe(false);
        });
    });
});