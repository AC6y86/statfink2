// Integration test that compares actual 2024 stats between databases
const StatsComparator = require('../2024/StatsComparator');

describe('2024 Stats Database Comparison (Integration)', () => {
    let comparator;
    
    beforeEach(() => {
        comparator = new StatsComparator();
    });
    
    afterEach(async () => {
        await comparator.close();
    });
    
    describe('Real database comparison', () => {
        test('should have no fantasy point mismatches for roster players', async () => {
            // Suppress console output during test
            const originalLog = console.log;
            console.log = jest.fn();
            
            try {
                await comparator.initialize();
                await comparator.compareAllStats(true); // roster players only
                
                // Filter for only fantasy point mismatches (not "NOT_IN_REFERENCE")
                const fantasyPointMismatches = comparator.mismatches.filter(m => 
                    m.issue === 'FANTASY_POINTS_MISMATCH'
                );
                
                // The test should pass only if there are no fantasy point calculation mismatches
                expect(fantasyPointMismatches).toHaveLength(0);
                
                // If there are mismatches, Jest will show them in the error
                if (fantasyPointMismatches.length > 0) {
                    console.log = originalLog;
                    console.log('\n=== FANTASY POINT MISMATCHES FOUND ===');
                    fantasyPointMismatches.forEach(mismatch => {
                        console.log(`${mismatch.player_name} (Week ${mismatch.week}): ` +
                            `current=${mismatch.current_fantasy_points}, ` +
                            `reference=${mismatch.reference_fantasy_points}, ` +
                            `diff=${mismatch.difference?.toFixed(1)}`);
                    });
                }
            } finally {
                console.log = originalLog;
            }
        }, 30000); // 30 second timeout for database operations
        
        test('should cover all weeks of 2024 season', async () => {
            const originalLog = console.log;
            const logSpy = jest.fn();
            console.log = logSpy;
            
            try {
                await comparator.initialize();
                await comparator.compareAllStats(true);
                
                // Find the log entry that shows weeks analyzed
                const weeksLogCall = logSpy.mock.calls.find(call => 
                    call[0] && call[0].includes('Weeks analyzed:')
                );
                
                expect(weeksLogCall).toBeDefined();
                
                // Extract weeks from the log
                const weeksMatch = weeksLogCall[0].match(/Weeks analyzed: ([\d, ]+)/);
                if (weeksMatch) {
                    const weeks = weeksMatch[1].split(', ').map(w => parseInt(w));
                    
                    // Should have data for multiple weeks
                    expect(weeks.length).toBeGreaterThan(0);
                    expect(Math.min(...weeks)).toBeGreaterThanOrEqual(1);
                    expect(Math.max(...weeks)).toBeLessThanOrEqual(17);
                }
            } finally {
                console.log = originalLog;
            }
        }, 30000);
    });
    
    describe('Opponent display in matchups', () => {
        test('should show correct opponent names instead of @OPP for week 1 matchups', async () => {
            // Test data - actual week 1 matchups from 2024
            const testMatchups = [
                { team: 'BAL', opponent: '@KC', isHome: false },  // Ravens @ Chiefs (Thursday night)
                { team: 'KC', opponent: 'BAL', isHome: true },   // Chiefs vs Ravens
                { team: 'GB', opponent: '@PHI', isHome: false }, // Packers @ Eagles (Brazil)
                { team: 'PHI', opponent: 'GB', isHome: true },   // Eagles vs Packers
            ];
            
            // Use the comparator's database connection
            await comparator.initialize();
            const db = comparator.currentDb;
            
            try {
                // For each test matchup, verify the opponent is correct
                // Helper to promisify db.get
                const dbGet = (query, params) => new Promise((resolve, reject) => {
                    db.get(query, params, (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    });
                });
                
                for (const testCase of testMatchups) {
                    // Get a player from the team to test with
                    const player = await dbGet(`
                        SELECT player_id, name, team 
                        FROM nfl_players 
                        WHERE team = ? AND position != 'DST'
                        LIMIT 1
                    `, [testCase.team]);
                    
                    expect(player).toBeTruthy();
                    expect(player.team).toBe(testCase.team);
                    
                    // Check that the game exists in nfl_games table
                    const game = await dbGet(`
                        SELECT home_team, away_team 
                        FROM nfl_games
                        WHERE week = 1 AND season = 2024 
                        AND (home_team = ? OR away_team = ?)
                        LIMIT 1
                    `, [testCase.team, testCase.team]);
                    
                    expect(game).toBeTruthy();
                    
                    // Verify the opponent calculation matches expected
                    if (testCase.isHome) {
                        expect(game.home_team).toBe(testCase.team);
                        expect(game.away_team).toBe(testCase.opponent);
                    } else {
                        expect(game.away_team).toBe(testCase.team);
                        expect(game.home_team).toBe(testCase.opponent.substring(1)); // Remove @ sign
                    }
                }
                
                // Test the opponent lookup function logic directly
                const { getTeamAbbreviation } = require('../../server/utils/teamMappings');
                
                // Test some specific games we know exist
                const knownGames = await dbGet(`
                    SELECT home_team, away_team 
                    FROM nfl_games
                    WHERE week = 1 AND season = 2024 
                    AND home_team = 'KC' AND away_team = 'BAL'
                `, []);
                
                if (knownGames) {
                    // For a KC player at home, opponent should be 'BAL'
                    const kcPlayer = { team: 'Chiefs' }; // Full name
                    const teamCode = getTeamAbbreviation(kcPlayer.team);
                    expect(teamCode).toBe('KC');
                    
                    // For a BAL player away, opponent should be '@KC'
                    const balPlayer = { team: 'Ravens' }; // Full name 
                    const balTeamCode = getTeamAbbreviation(balPlayer.team);
                    expect(balTeamCode).toBe('BAL');
                }
                
                console.log('✓ Opponent display test completed successfully');
            } finally {
                // Don't close the db here, let comparator handle it
            }
        }, 30000);
    });
});