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
        test('should have no mismatches between current and reference databases for roster players', async () => {
            // Suppress console output during test
            const originalLog = console.log;
            console.log = jest.fn();
            
            try {
                await comparator.initialize();
                await comparator.compareAllStats(true); // roster players only
                
                // The test should pass only if there are no mismatches
                expect(comparator.mismatches).toHaveLength(0);
                
                // Verify the success message was logged
                expect(console.log).toHaveBeenCalledWith(
                    expect.stringContaining('No mismatches found!')
                );
            } finally {
                console.log = originalLog;
            }
        }, 30000); // 30 second timeout for database operations
        
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
        
        test('should find matches for all major stat categories', async () => {
            const originalLog = console.log;
            console.log = jest.fn();
            
            try {
                await comparator.initialize();
                
                // Get stats from current database
                const currentStats = await comparator.getStatsFromCurrent(true);
                const referenceStats = await comparator.getStatsFromReference();
                
                // Verify we have data
                expect(currentStats.length).toBeGreaterThan(0);
                expect(referenceStats.length).toBeGreaterThan(0);
                
                // Check that we have various positions represented
                const positions = [...new Set(currentStats.map(s => s.position))];
                expect(positions).toEqual(expect.arrayContaining(['QB', 'RB', 'WR']));
                
                // Run the comparison
                await comparator.compareAllStats(true);
                
                // No mismatches expected
                expect(comparator.mismatches).toHaveLength(0);
            } finally {
                console.log = originalLog;
            }
        }, 30000);
        
        test('should properly handle defense team name variations', async () => {
            const originalLog = console.log;
            console.log = jest.fn();
            
            try {
                await comparator.initialize();
                
                // Get stats and check for defense teams
                const currentStats = await comparator.getStatsFromCurrent(false);
                const defenseStats = currentStats.filter(s => s.position === 'DEF' || s.position === 'DST');
                
                if (defenseStats.length > 0) {
                    // Run comparison
                    await comparator.compareAllStats(false);
                    
                    // Check that defense teams were matched properly (fantasy point mismatches only)
                    const defenseFantasyPointMismatches = comparator.mismatches.filter(m => 
                        (m.position === 'DEF' || m.position === 'DST') && 
                        m.issue === 'FANTASY_POINTS_MISMATCH'
                    );
                    
                    expect(defenseFantasyPointMismatches).toHaveLength(0);
                }
            } finally {
                console.log = originalLog;
            }
        }, 30000);
        
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
});